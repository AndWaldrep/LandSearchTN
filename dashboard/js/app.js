/* global L */
import { CATEGORIES, subscores, total, explain } from './scoring.js';
import { PRESETS } from './presets.js';
import { ParcelCanvas, ArcGISExportLayer } from './maplayer.js';

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const LS = {
  get(k, d) { try { const v = localStorage.getItem('lstn.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('lstn.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const SEQ = ['--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5', '--seq-6', '--seq-7'];
const CATPAL = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const STATUS = { Low: '#0ca30c', Moderate: '#fab219', High: '#d03b3b', 'Not limited': '#0ca30c', 'Somewhat limited': '#fab219',
  'Very limited': '#d03b3b', 'Not rated': '#898781', Unknown: '#898781' };
const CAT_ORDER = { sinkhole_risk: ['Low', 'Moderate', 'High'], septic_rating: ['Not limited', 'Somewhat limited', 'Very limited', 'Not rated', 'Unknown'],
  basement_rating: ['Not limited', 'Somewhat limited', 'Very limited', 'Not rated', 'Unknown'] };

let N_SALE = 0;
let META, COLS, N, LAYERS, ROWS, FIELD = {}, GROUPS = [];
let SUB = [];          // per-row sub-scores
let SCORE;             // Float32Array overall score
let GEOM = null, HORIZON = null;
let geomLoading = false;
let pass = new Uint8Array(0), failKey = new Int16Array(0), failCount = new Uint8Array(0);
let filtered = [];     // indices passing all filters, sorted by score ascending (for drawing)
let sortedRows = [];   // indices for the table
let tableLimit = 150;
let selected = null;
let compareSet = new Set();
let map, parcelLayer, radiusCircle, centerMarker;
const DOM = {};
const OFFLINE = !!window.LSTN_OFFLINE;
const TOUCH = matchMedia('(hover: none)').matches; // sandboxed host: no third-party tiles, downloads or URL state
const ctxScore = {};

// Shortlist, hidden parcels and notes are kept per browser, keyed by parcel ID so they survive data refreshes.
const user = { stars: new Set(), hidden: new Set(), notes: {} };
function loadUser() {
  const idx = new Map(COLS.gislink.map((g, i) => [g, i]));
  const ids = k => (LS.get(k, []) || []).map(g => idx.get(g)).filter(i => i != null);
  user.stars = new Set(ids('stars_v2'));
  user.hidden = new Set(ids('hidden_v2'));
  user.notes = {};
  for (const [g, t] of Object.entries(LS.get('notes_v2', {}) || {})) if (idx.has(g)) user.notes[idx.get(g)] = t;
}
function saveUser() {
  const g = i => COLS.gislink[i];
  LS.set('stars_v2', [...user.stars].map(g)); LS.set('hidden_v2', [...user.hidden].map(g));
  LS.set('notes_v2', Object.fromEntries(Object.entries(user.notes).map(([i, t]) => [g(+i), t])));
}

const state = {
  preset: 'balanced',
  filters: {},          // key -> spec
  weights: Object.fromEntries(CATEGORIES.map(c => [c.key, c.w])),
  minScore: 0,
  q: '',
  spatial: { mode: 'none', center: null, radius: 5 },
  onlyStar: false, onlyListed: false, showHidden: false,
  colorBy: 'score',
  sort: { key: 'score', dir: -1 },
  scope: 'sale',        // 'sale' = parcels with an active/pending listing; 'all' = every vacant candidate
  columns: ['score', 'list_link', 'list_price', 'acres', 'list_ppa', 'days_listed', 'nearest_town', 'view_smokies', 'slope_mean',
    'pad_ac', 'noise_db', 'dt_ed_min', 'sinkhole_risk', 'flood_pct', 'address'],
  openGroups: LS.get('openGroups2', []),
};

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
function fmt(key, v) {
  if (v == null || v === '') return '—';
  const f = FIELD[key];
  if (!f) return typeof v === 'number' ? nf1.format(v) : String(v);
  if (f.type === 'bool') return v ? 'Yes' : 'No';
  if (f.type !== 'num') return String(v);
  if (f.unit === '$') return v >= 1e6 ? '$' + nf2.format(v / 1e6) + 'M' : '$' + nf0.format(v);
  if (key === 'last_sale_year' || key === 'data_year') return String(v);
  const n = Math.abs(v) >= 100 ? nf0.format(v) : Math.abs(v) >= 10 ? nf1.format(v) : nf2.format(v);
  return f.unit && f.unit !== '' ? `${n}${f.unit === '%' ? '%' : ' ' + f.unit}` : n;
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2200); }
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// ---------------------------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------------------------
async function load() {
  const [pj, lj] = await Promise.all([fetch('data/parcels.json').then(r => r.json()), fetch('data/layers.json').then(r => r.json())]);
  META = pj.meta; COLS = pj.cols; LAYERS = lj; N = META.count;
  for (const f of META.fields) FIELD[f.key] = f;
  FIELD.score = { key: 'score', label: 'Overall score', type: 'num', unit: '', better: 'high', group: 'Score', desc: 'Weighted overall score' };
  for (const c of CATEGORIES) FIELD['s_' + c.key] = { key: 's_' + c.key, label: c.label + ' score', type: 'num', unit: '', better: 'high', group: 'Score', desc: '' };
  GROUPS = [...new Set(META.fields.map(f => f.group))];
  ROWS = new Array(N);
  const keys = Object.keys(COLS);
  for (let i = 0; i < N; i++) { const r = { i }; for (const k of keys) r[k] = COLS[k][i]; ROWS[i] = r; }
  const per = COLS.land_val_per_ac.filter(v => v != null && v > 0).sort((a, b) => a - b);
  ctxScore.medPerAc = per[Math.floor(per.length / 2)];
  const lp = COLS.list_ppa ? COLS.list_ppa.filter(v => v != null && v > 0).sort((a, b) => a - b) : [];
  ctxScore.medListPpa = lp[Math.floor(lp.length / 2)];
  N_SALE = N; // every parcel in the data is listed for sale
  SUB = ROWS.map(r => subscores(r, ctxScore));
  loadUser();
  SCORE = new Float32Array(N);
  prepFields();
}

function prepFields() {
  for (const f of META.fields) {
    const col = COLS[f.key];
    if (f.type === 'num') {
      const vals = col.filter(v => v != null).sort((a, b) => a - b);
      f.min = vals[0] ?? 0; f.max = vals[vals.length - 1] ?? 1;
      f.hasNull = vals.length < N;
      const q = p => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
      const p50 = q(0.5), p99 = q(0.99);
      f.log = f.min >= 0 && (p99 - f.min) > 8 * Math.max(p50 - f.min, 1e-9) && f.max > 10;
      f.step = Number.isInteger(f.min) && Number.isInteger(f.max) && vals.every(v => Number.isInteger(v)) ? 1 : (f.max - f.min > 50 ? 1 : 0.1);
    } else if (f.type === 'cat') {
      const counts = new Map();
      for (const v of col) counts.set(v ?? '(blank)', (counts.get(v ?? '(blank)') || 0) + 1);
      const order = CAT_ORDER[f.key];
      f.cats = [...counts.entries()].sort((a, b) => order ? order.indexOf(a[0]) - order.indexOf(b[0]) : b[1] - a[1]).map(e => e[0]);
      f.catColor = {};
      f.cats.forEach((c, j) => { f.catColor[c] = STATUS[c] && (order || f.key.includes('septic') || f.key.includes('basement')) ? STATUS[c] : (j < 8 ? CATPAL[j] : '#898781'); });
    }
  }
}
const tf = (f, v) => (f.log ? Math.log10(v - f.min + 1) : v);
const itf = (f, t) => (f.log ? Math.pow(10, t) - 1 + f.min : t);
function roundTo(f, v) { const s = f.step || 0.1; return Math.round(v / s) * s; }

// ---------------------------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------------------------
function isActive(key, spec) {
  const f = FIELD[key];
  if (!spec || !f) return false;
  if (f.type === 'num') return (spec.min != null && spec.min > f.min) || (spec.max != null && spec.max < f.max);
  if (f.type === 'cat') return Array.isArray(spec.values);
  if (f.type === 'bool') return spec === 'yes' || spec === 'no';
  if (f.type === 'text') return !!(spec && spec.trim());
  return false;
}
function activeFilters() { return Object.entries(state.filters).filter(([k, s]) => isActive(k, s)); }

function makeTest(key, spec) {
  const f = FIELD[key], col = COLS[key];
  if (f.type === 'num') {
    const lo = spec.min ?? -Infinity, hi = spec.max ?? Infinity, inc = !!spec.includeNull;
    return i => { const v = col[i]; return v == null ? inc : v >= lo - 1e-9 && v <= hi + 1e-9; };
  }
  if (f.type === 'cat') { const set = new Set(spec.values); return i => set.has(col[i] ?? '(blank)'); }
  if (f.type === 'bool') { const want = spec === 'yes' ? 1 : 0; return i => col[i] === want; }
  if (f.type === 'text') {
    const terms = spec.toLowerCase().split(/\s+/).filter(Boolean);
    return i => { const s = (col[i] || '').toLowerCase(); return terms.every(t => (t[0] === '-' ? !s.includes(t.slice(1)) : s.includes(t))); };
  }
  return () => true;
}

function recompute({ keepTable = false } = {}) {
  for (let i = 0; i < N; i++) SCORE[i] = total(SUB[i], state.weights);
  const tests = activeFilters().map(([k, s]) => [k, makeTest(k, s)]);
  const extra = [];
  if (state.minScore > 0) extra.push(i => SCORE[i] >= state.minScore);
  if (state.q.trim()) {
    const terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = i => `${COLS.address[i] || ''} ${COLS.owner[i] || ''} ${COLS.subdivision[i] || ''} ${COLS.gislink[i] || ''} ${COLS.nearest_town[i] || ''}`.toLowerCase();
    extra.push(i => { const h = hay(i); return terms.every(t => h.includes(t)); });
  }
  if (!state.showHidden) extra.push(i => !user.hidden.has(i));
  if (state.onlyStar) extra.push(i => user.stars.has(i));
  const sp = state.spatial;
  if (sp.mode === 'view' && map) {
    const b = map.getBounds();
    extra.push(i => b.contains([COLS.lat[i], COLS.lon[i]]));
  } else if (sp.mode === 'radius' && sp.center) {
    const [clat, clon] = sp.center, r = sp.radius * 1609.344;
    const kx = 111320 * Math.cos(clat * Math.PI / 180), ky = 110540;
    extra.push(i => { const dx = (COLS.lon[i] - clon) * kx, dy = (COLS.lat[i] - clat) * ky; return dx * dx + dy * dy <= r * r; });
  }
  pass = new Uint8Array(N); failKey = new Int16Array(N).fill(-1); failCount = new Uint8Array(N);
  const out = [];
  for (let i = 0; i < N; i++) {
    let ok = true;
    for (const t of extra) if (!t(i)) { ok = false; break; }
    if (!ok) { failCount[i] = 255; continue; }
    let fc = 0;
    for (let t = 0; t < tests.length; t++) {
      if (!tests[t][1](i)) { fc++; failKey[i] = t; if (fc > 1) break; }
    }
    failCount[i] = fc;
    if (fc === 0) { pass[i] = 1; out.push(i); }
  }
  recompute.testKeys = tests.map(t => t[0]);
  filtered = out.sort((a, b) => SCORE[a] - SCORE[b]);
  sortRows();
  if (!keepTable) tableLimit = 150;
  renderStats(); renderChips(); updateFilterWidgets(); renderTable(); renderLegend();
  if (parcelLayer) parcelLayer.redraw();
  if (selected != null && DOM.detail && !DOM.detail.hidden) renderDetail(selected);
  updateHash();
}
// rows passing every filter except `key` (for crossfilter histograms / counts)
function passesExcept(i, key) {
  if (failCount[i] === 0) return true;
  if (failCount[i] !== 1) return false;
  return recompute.testKeys[failKey[i]] === key;
}

function sortRows() {
  const { key, dir } = state.sort;
  const val = valueGetter(key);
  sortedRows = filtered.slice().sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
  });
}
function valueGetter(key) {
  if (key === 'score') return i => SCORE[i];
  if (key.startsWith('s_')) { const k = key.slice(2); return i => SUB[i][k]; }
  if (key === 'star') return i => (user.stars.has(i) ? 1 : 0);
  if (key === 'list_link') return i => COLS.list_price[i];
  if (key === 'near') return i => (DIST ? DIST[i] : null);
  return i => COLS[key][i];
}

// ---------------------------------------------------------------------------------------------
// Sidebar: weights + filters
// ---------------------------------------------------------------------------------------------
function buildWeights() {
  const el = $('#weights');
  el.innerHTML = CATEGORIES.map(c => `<label class="weight"><span>${c.label}</span>
    <input type="range" min="0" max="10" step="1" data-w="${c.key}" value="${state.weights[c.key]}"><output>${state.weights[c.key]}</output></label>`).join('');
  el.addEventListener('input', e => {
    const k = e.target.dataset.w; if (!k) return;
    state.weights[k] = +e.target.value; e.target.nextElementSibling.textContent = e.target.value;
    debounced();
  });
  $('#minscore').addEventListener('input', e => { state.minScore = +e.target.value; $('#minscore-out').textContent = e.target.value; debounced(); });
}

const QUICK = ['list_price', 'list_ppa', 'acres', 'view_smokies', 'slope_mean', 'pad_ac', 'dt_ed_min', 'dt_grocery_min',
  'noise_db', 'sinkhole_risk', 'flood_pct'];
function buildFilters() {
  const quick = $('#quick-filters');
  quick.innerHTML = QUICK.filter(k => FIELD[k]).map(k => filterHTML(FIELD[k])).join('');
  for (const el of $$('.flt', quick)) wireFilter(el);
  const host = $('#filter-groups');
  host.innerHTML = GROUPS.map(g => {
    const fields = META.fields.filter(f => f.group === g);
    const open = state.openGroups.includes(g);
    return `<section class="panel" data-group="${esc(g)}">
      <button class="panel-h" aria-expanded="${open}"><span>${esc(g)}<span class="count"></span></span><span class="caret">▾</span></button>
      <div class="panel-b">${fields.map(filterHTML).join('')}</div></section>`;
  }).join('');
  for (const el of $$('.flt', host)) wireFilter(el);
  $$('.panel-h').forEach(h => h.addEventListener('click', () => {
    const open = h.getAttribute('aria-expanded') !== 'true';
    h.setAttribute('aria-expanded', open);
    const g = h.parentElement.dataset.group;
    if (g) {
      state.openGroups = open ? [...new Set([...state.openGroups, g])] : state.openGroups.filter(x => x !== g);
      LS.set('openGroups2', state.openGroups);
    }
    if (open) updateFilterWidgets();
  }));
}

function filterHTML(f) {
  const head = `<div class="flt-h"><span class="name" title="${esc(f.desc)}">${esc(f.label)}</span><span class="val"></span><button class="x" title="Clear">✕</button></div>`;
  if (f.type === 'num') {
    return `<div class="flt" data-key="${f.key}">${head}
      <svg class="hist" viewBox="0 0 300 34" preserveAspectRatio="none"></svg>
      <div class="dual"><div class="track"></div><div class="fill"></div>
        <input type="range" class="lo" min="0" max="1000" value="0" aria-label="${esc(f.label)} minimum">
        <input type="range" class="hi" min="0" max="1000" value="1000" aria-label="${esc(f.label)} maximum"></div>
      <div class="minmax"><input type="number" class="nlo" step="any" placeholder="${fmtNum(f.min)}" aria-label="min">–<input type="number" class="nhi" step="any" placeholder="${fmtNum(f.max)}" aria-label="max">
      ${f.hasNull ? '<label title="Include parcels with no value"><input type="checkbox" class="inull"> blanks</label>' : ''}</div></div>`;
  }
  if (f.type === 'cat') {
    return `<div class="flt" data-key="${f.key}">${head}
      ${f.cats.length > 10 ? '<input type="search" class="cat-search" placeholder="Filter list…">' : ''}
      <div class="cats"></div><div class="cat-tools"><button class="all">All</button><button class="none">None</button><button class="invert">Invert</button></div></div>`;
  }
  if (f.type === 'bool') {
    return `<div class="flt" data-key="${f.key}">${head}
      <div class="seg tri"><button data-v="any" class="on">Any</button><button data-v="yes">Yes</button><button data-v="no">No</button></div></div>`;
  }
  return `<div class="flt" data-key="${f.key}">${head}<input type="search" class="text-flt" placeholder="contains… (use -word to exclude)"></div>`;
}
const fmtNum = v => (v == null ? '' : Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100);

function wireFilter(el) {
  const key = el.dataset.key, f = FIELD[key];
  el.querySelector('.x').addEventListener('click', () => { delete state.filters[key]; recompute(); });
  if (f.type === 'num') {
    const lo = el.querySelector('.lo'), hi = el.querySelector('.hi');
    const t0 = tf(f, f.min), t1 = tf(f, f.max);
    const posToVal = p => roundTo(f, itf(f, t0 + (t1 - t0) * p / 1000));
    const onSlide = () => {
      let a = +lo.value, b = +hi.value;
      if (a > b) { if (document.activeElement === lo) a = b; else b = a; lo.value = a; hi.value = b; }
      const spec = state.filters[key] || {};
      spec.min = a <= 0 ? f.min : posToVal(a);
      spec.max = b >= 1000 ? f.max : posToVal(b);
      state.filters[key] = spec;
      paintNum(el, f);
      debounced();
    };
    lo.addEventListener('input', onSlide); hi.addEventListener('input', onSlide);
    const onNum = () => {
      const a = el.querySelector('.nlo').value, b = el.querySelector('.nhi').value;
      const spec = state.filters[key] || {};
      spec.min = a === '' ? f.min : +a; spec.max = b === '' ? f.max : +b;
      state.filters[key] = spec; debounced();
    };
    el.querySelector('.nlo').addEventListener('change', onNum); el.querySelector('.nhi').addEventListener('change', onNum);
    const inull = el.querySelector('.inull');
    if (inull) inull.addEventListener('change', () => { state.filters[key] = { ...(state.filters[key] || { min: f.min, max: f.max }), includeNull: inull.checked }; recompute(); });
  } else if (f.type === 'cat') {
    const box = el.querySelector('.cats');
    box.addEventListener('click', e => {
      const row = e.target.closest('.cat'); if (!row) return;
      const v = row.dataset.v;
      if (e.target.classList.contains('only')) { state.filters[key] = { values: [v] }; recompute(); e.preventDefault(); return; }
    });
    box.addEventListener('change', e => {
      const cur = state.filters[key]?.values ?? f.cats.slice();
      const v = e.target.closest('.cat').dataset.v;
      const set = new Set(cur);
      e.target.checked ? set.add(v) : set.delete(v);
      state.filters[key] = set.size === f.cats.length ? undefined : { values: [...set] };
      if (!state.filters[key]) delete state.filters[key];
      recompute();
    });
    el.querySelector('.all').addEventListener('click', () => { delete state.filters[key]; recompute(); });
    el.querySelector('.none').addEventListener('click', () => { state.filters[key] = { values: [] }; recompute(); });
    el.querySelector('.invert').addEventListener('click', () => {
      const cur = new Set(state.filters[key]?.values ?? f.cats);
      state.filters[key] = { values: f.cats.filter(c => !cur.has(c)) }; recompute();
    });
    const cs = el.querySelector('.cat-search');
    if (cs) cs.addEventListener('input', () => { const t = cs.value.toLowerCase(); $$('.cat', box).forEach(r => { r.hidden = t && !r.dataset.v.toLowerCase().includes(t); }); });
  } else if (f.type === 'bool') {
    el.querySelector('.tri').addEventListener('click', e => {
      const v = e.target.dataset.v; if (!v) return;
      if (v === 'any') delete state.filters[key]; else state.filters[key] = v;
      recompute();
    });
  } else {
    const inp = el.querySelector('.text-flt');
    inp.addEventListener('input', () => { if (inp.value.trim()) state.filters[key] = inp.value; else delete state.filters[key]; debounced(); });
  }
}

function paintNum(el, f) {
  const spec = state.filters[f.key];
  const t0 = tf(f, f.min), t1 = tf(f, f.max);
  const toPos = v => Math.round(((tf(f, Math.min(Math.max(v, f.min), f.max)) - t0) / ((t1 - t0) || 1)) * 1000);
  const a = spec?.min != null ? toPos(spec.min) : 0, b = spec?.max != null ? toPos(spec.max) : 1000;
  const lo = el.querySelector('.lo'), hi = el.querySelector('.hi');
  if (document.activeElement !== lo) lo.value = a;
  if (document.activeElement !== hi) hi.value = b;
  const fill = el.querySelector('.fill');
  fill.style.left = (+lo.value / 10) + '%'; fill.style.width = ((+hi.value - +lo.value) / 10) + '%';
  const act = isActive(f.key, spec);
  el.classList.toggle('active', act);
  el.querySelector('.val').textContent = act ? `${fmt(f.key, spec.min ?? f.min)} – ${fmt(f.key, spec.max ?? f.max)}` : `${fmt(f.key, f.min)} – ${fmt(f.key, f.max)}`;
  const nlo = el.querySelector('.nlo'), nhi = el.querySelector('.nhi');
  if (document.activeElement !== nlo) nlo.value = act && spec.min > f.min ? fmtNum(spec.min) : '';
  if (document.activeElement !== nhi) nhi.value = act && spec.max < f.max ? fmtNum(spec.max) : '';
  const inull = el.querySelector('.inull'); if (inull) inull.checked = !!spec?.includeNull;
  return { a: +lo.value, b: +hi.value };
}

const BINS = 40;
function updateFilterWidgets() {
  let total = 0;
  for (const panel of $$('#panel-quick, #filter-groups .panel')) {
    const open = panel.querySelector('.panel-h').getAttribute('aria-expanded') === 'true';
    let n = 0;
    for (const el of $$('.flt', panel)) {
      const key = el.dataset.key, f = FIELD[key], spec = state.filters[key];
      const act = isActive(key, spec);
      if (act) n++;
      if (f.type === 'num') {
        const { a, b } = paintNum(el, f);
        if (!open) continue;
        const col = COLS[key], t0 = tf(f, f.min), t1 = tf(f, f.max), span = (t1 - t0) || 1;
        const all = new Array(BINS).fill(0), on = new Array(BINS).fill(0);
        for (let i = 0; i < N; i++) {
          const v = col[i]; if (v == null) continue;
          const bi = Math.min(BINS - 1, Math.floor(((tf(f, v) - t0) / span) * BINS));
          all[bi]++;
          if (passesExcept(i, key)) on[bi]++;
        }
        const mx = Math.max(...all, 1), w = 300 / BINS;
        el.querySelector('.hist').innerHTML = all.map((c, j) => {
          const h = c ? Math.max(1.5, Math.sqrt(c / mx) * 32) : 0, h2 = on[j] ? Math.max(1.5, Math.sqrt(on[j] / mx) * 32) : 0;
          const inRange = (j + 1) / BINS * 1000 > a && j / BINS * 1000 < b;
          return `<rect class="all" x="${j * w + 0.5}" y="${34 - h}" width="${w - 1}" height="${h}" rx="1"/>` +
            (h2 ? `<rect class="on${inRange ? '' : ' out'}" x="${j * w + 0.5}" y="${34 - h2}" width="${w - 1}" height="${h2}" rx="1"><title>${on[j]} of ${c}</title></rect>` : '');
        }).join('');
      } else if (f.type === 'cat') {
        el.classList.toggle('active', act);
        el.querySelector('.val').textContent = act ? `${spec.values.length} selected` : '';
        if (!open) continue;
        const counts = new Map(); const col = COLS[key];
        for (let i = 0; i < N; i++) if (passesExcept(i, key)) { const v = col[i] ?? '(blank)'; counts.set(v, (counts.get(v) || 0) + 1); }
        const mx = Math.max(1, ...counts.values());
        const sel = act ? new Set(spec.values) : null;
        el.querySelector('.cats').innerHTML = f.cats.map(c => {
          const n_ = counts.get(c) || 0;
          return `<label class="cat${n_ ? '' : ' zero'}" data-v="${esc(c)}"><input type="checkbox" ${!sel || sel.has(c) ? 'checked' : ''}>
            <span>${esc(c)}</span><button class="only" type="button">only</button><span class="n">${nf0.format(n_)}</span></label>`;
        }).join('');
        const cs = el.querySelector('.cat-search'); if (cs && cs.value) cs.dispatchEvent(new Event('input'));
        void mx;
      } else if (f.type === 'bool') {
        el.classList.toggle('active', act);
        $$('.tri button', el).forEach(btn => btn.classList.toggle('on', (spec || 'any') === btn.dataset.v));
        if (open) {
          let y = 0, no = 0; const col = COLS[key];
          for (let i = 0; i < N; i++) if (passesExcept(i, key)) col[i] ? y++ : no++;
          el.querySelector('.val').textContent = `${nf0.format(y)} yes · ${nf0.format(no)} no`;
        }
      } else {
        el.classList.toggle('active', act);
        const inp = el.querySelector('.text-flt'); if (document.activeElement !== inp) inp.value = spec || '';
      }
    }
    panel.querySelector('.count').textContent = n ? `${n} active` : '';
    if (panel.id !== 'panel-quick') total += n;
  }
  const nAct = activeFilters().length + (state.minScore > 0) + (state.spatial.mode !== 'none');
  const badge = $('#filter-count'); badge.hidden = !nAct; badge.textContent = nAct;
  const tb = $('#tab-filters-n'); if (tb) { tb.hidden = !nAct; tb.textContent = nAct; }
}

function renderChips() {
  const chips = activeFilters().map(([k, s]) => {
    const f = FIELD[k];
    let txt;
    if (f.type === 'num') txt = `${f.label}: ${fmt(k, s.min ?? f.min)}–${fmt(k, s.max ?? f.max)}`;
    else if (f.type === 'cat') txt = `${f.label}: ${s.values.length <= 2 ? s.values.join(', ') || 'none' : s.values.length + ' selected'}`;
    else if (f.type === 'bool') txt = `${f.label}: ${s}`;
    else txt = `${f.label} ~ “${s}”`;
    return `<span class="chip">${esc(txt)}<button data-k="${k}" aria-label="Remove">×</button></span>`;
  });
  if (state.minScore > 0) chips.unshift(`<span class="chip">Score ≥ ${state.minScore}<button data-k="__score">×</button></span>`);
  if (state.spatial.mode !== 'none') chips.unshift(`<span class="chip">${state.spatial.mode === 'view' ? 'In map view' : `Within ${state.spatial.radius} mi`}<button data-k="__spatial">×</button></span>`);
  $('#active-chips').innerHTML = chips.join('');
}

// ---------------------------------------------------------------------------------------------
// Stats, table
// ---------------------------------------------------------------------------------------------
function median(arr) { const v = arr.filter(x => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; }
function renderStats() {
  const n = filtered.length;
  const take = k => filtered.map(i => COLS[k][i]);
  const sale = state.scope === 'sale';
  $('#stats').innerHTML = [
    [nf0.format(n), sale ? `of ${nf0.format(N_SALE)} for sale` : `of ${nf0.format(N)} parcels`],
    [fmt('list_price', median(take('list_price'))), 'median asking'],
    [fmt('acres', median(take('acres'))), 'median size'],
    [fmt('dt_ed_min', median(take('dt_ed_min'))), 'median to ER'],
    [nf0.format(filtered.filter(i => (COLS.view_smokies[i] || 0) >= 15).length), 'with Smokies view'],
  ].filter((x, j) => sale || j !== 2).map(([b, s_]) => `<div class="stat"><b>${b}</b><span>${s_}</span></div>`).join('');
  $('#btn-show').textContent = `Show ${nf0.format(n)} parcel${n === 1 ? '' : 's'}`;
  const tc = $('#tab-count'); if (tc) tc.textContent = `(${nf0.format(n)})`;
}

function colLabel(k) { return k === 'score' ? 'Score' : k === 'list_link' ? 'Listing' : (FIELD[k]?.label ?? k); }
function renderTable() {
  const cols = state.columns;
  const thead = $('#results thead'), tbody = $('#results tbody');
  thead.innerHTML = `<tr><th class="l" data-k="star">★</th>${cols.map(k => {
    const f = FIELD[k]; const left = f && f.type !== 'num' && f.type !== 'bool';
    return `<th class="${left ? 'l' : ''}${state.sort.key === k ? ' sorted' : ''}" data-k="${k}" title="${esc(f?.desc || '')}">${esc(colLabel(k))}${state.sort.key === k ? (state.sort.dir < 0 ? ' ↓' : ' ↑') : ''}</th>`;
  }).join('')}<th class="l">Cmp</th></tr>`;
  const rows = sortedRows.slice(0, tableLimit);
  tbody.innerHTML = rows.map(i => `<tr data-i="${i}" class="${i === selected ? 'is-sel' : ''}"><td><button class="star${user.stars.has(i) ? ' on' : ''}" data-star="${i}" aria-label="Shortlist">${user.stars.has(i) ? '★' : '☆'}</button></td>${cols.map(k => {
    if (k === 'list_link') return `<td class="l">${COLS.list_url[i] ? `<a href="${esc(COLS.list_url[i])}" target="_blank" rel="noopener">View ↗</a>${COLS.list_status[i] && COLS.list_status[i] !== 'active' ? ` <span class="badge warn">${esc(COLS.list_status[i])}</span>` : ''}` : '—'}</td>`;
    if (k === 'score') { const s = SCORE[i]; return `<td><span class="scorecell"><i style="width:${Math.round(s * 0.4)}px"></i>${Math.round(s)}</span></td>`; }
    const f = FIELD[k]; const left = f && f.type !== 'num' && f.type !== 'bool';
    const v = k.startsWith('s_') ? SUB[i][k.slice(2)] : COLS[k][i];
    let txt = k.startsWith('s_') ? (v == null ? '—' : Math.round(v)) : fmt(k, v);
    if (k === 'sinkhole_risk' && v) txt = `<span class="badge ${v === 'Low' ? 'good' : v === 'Moderate' ? 'warn' : 'bad'}">${v}</span>`;
    else txt = esc(txt);
    return `<td class="${left ? 'l' : ''}">${txt}</td>`;
  }).join('')}<td><input type="checkbox" data-cmp="${i}" ${compareSet.has(i) ? 'checked' : ''} aria-label="Compare"></td></tr>`).join('');
  renderCards();
  $('#table-sub').textContent = `${nf0.format(filtered.length)} matches · sorted by ${colLabel(state.sort.key)}`;
  $('#btn-more').hidden = sortedRows.length <= tableLimit;
  $('#btn-compare').textContent = `Compare (${compareSet.size})`;
  $('#btn-compare').disabled = compareSet.size < 2;
}

// Phone list: one card per parcel with the facts people decide on first.
const scoreColor = v => SEQ.map(css)[Math.max(0, Math.min(6, Math.floor((v - 20) / 10)))];
function renderCards() {
  const host = $('#cards'); if (!host || !isMobile()) return;
  const rows = sortedRows.slice(0, tableLimit);
  if (!rows.length) {
    host.innerHTML = state.onlyStar
      ? `<p class="empty">Your shortlist is empty.<br>Tap <b>☆ Save</b> on any parcel to keep it here.</p>`
      : `<p class="empty">No parcels match. Open <b>Filters</b> and loosen a filter, or tap <b>Reset</b>.</p>`;
    return;
  }
  const chip = (txt, cls = '') => `<span class="chip-s ${cls}">${esc(txt)}</span>`;
  host.innerHTML = rows.map(i => {
    const c = k => COLS[k]?.[i];
    const listed = true;
    const chips = [
      c('view_smokies') != null ? chip(`Smokies ${Math.round(c('view_smokies'))}%`, c('view_smokies') >= 15 ? 'good' : '') : '',
      chip(`Slope ${fmt('slope_mean', c('slope_mean'))}`, c('slope_mean') > 20 ? 'bad' : ''),
      chip(`ER ${fmt('dt_ed_min', c('dt_ed_min'))}`),
      c('sinkhole_risk') ? chip(`Sinkhole ${c('sinkhole_risk').toLowerCase()}`, c('sinkhole_risk') === 'High' ? 'bad' : c('sinkhole_risk') === 'Low' ? 'good' : '') : '',
      c('flood_pct') > 0 ? chip(`${Math.round(c('flood_pct'))}% flood zone`, 'bad') : '',
      c('list_status') && c('list_status') !== 'active' ? chip(c('list_status'), 'bad') : '',
      DIST && DIST[i] != null ? chip(`${nf1.format(DIST[i])} mi away`) : '',
    ].join('');
    const head = listed ? `${fmt('list_price', c('list_price'))}` : `${fmt('land_val', c('land_val'))} <small class="muted">appraised</small>`;
    return `<article class="card${i === selected ? ' is-sel' : ''}" data-i="${i}">
      <div><div class="price">${head}</div></div>
      <div class="score" style="background:${scoreColor(SCORE[i])}" title="Overall score">${Math.round(SCORE[i])}</div>
      <div class="meta">${fmt('acres', c('acres'))}${listed && c('list_ppa') ? ` · ${fmt('list_ppa', c('list_ppa'))}/ac` : ''} · ${esc(c('nearest_town') || c('county'))}${listed && c('days_listed') != null ? ` · ${nf0.format(c('days_listed'))} days listed` : ''}</div>
      <div class="chips-row">${chips}</div>
      <div class="row-actions">
        <button type="button" data-act="map">Show on map</button>
        <button type="button" data-act="star" class="${user.stars.has(i) ? 'on' : ''}">${user.stars.has(i) ? '★ Saved' : '☆ Save'}</button>
        ${c('list_url') ? `<a href="${esc(c('list_url'))}" target="_blank" rel="noopener">Listing ↗</a>` : ''}
      </div></article>`;
  }).join('') + (sortedRows.length > tableLimit ? `<button class="btn more" type="button" data-act="more">Show more (${nf0.format(sortedRows.length - tableLimit)} left)</button>` : '');
}

// Phone views: map or list, chosen from the bottom tab bar.
function setView(v) {
  document.body.classList.toggle('view-map', v === 'map');
  document.body.classList.toggle('view-list', v === 'list');
  state.view = v;
  $$('#tabbar button').forEach(b => b.classList.toggle('on', b.dataset.tab === (v === 'list' && state.onlyStar ? 'star' : v)));
  if (v === 'map') setTimeout(() => { map.invalidateSize(); parcelLayer.redraw(); }, 30);
  else renderCards();
}

// "Near me": the phone's location (asked for only when the viewer taps a Near-me control).
let DIST = null, meLayer = null;
function locateMe(then) {
  if (!navigator.geolocation) { toast('Location is not available in this browser'); return; }
  toast('Finding your location…');
  navigator.geolocation.getCurrentPosition(pos => {
    const { latitude: la, longitude: lo, accuracy } = pos.coords;
    const kx = Math.cos(la * Math.PI / 180) * 69.17, ky = 69.05;
    DIST = new Float32Array(N);
    for (let i = 0; i < N; i++) { const dx = (COLS.lon[i] - lo) * kx, dy = (COLS.lat[i] - la) * ky; DIST[i] = Math.hypot(dx, dy); }
    if (meLayer) meLayer.remove();
    meLayer = L.layerGroup([L.circle([la, lo], { radius: accuracy, weight: 1, color: '#2a78d6', fillOpacity: 0.08, interactive: false }),
      L.circleMarker([la, lo], { radius: 8, color: '#fff', weight: 3, fillColor: '#2a78d6', fillOpacity: 1, interactive: false })]).addTo(map);
    then && then([la, lo]);
  }, err => toast(err.code === 1 ? 'Location permission was denied' : 'Could not get your location'), { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
}

// ---------------------------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------------------------
function colorFor() {
  const key = state.colorBy;
  if (key === 'score' || key.startsWith('s_')) {
    const get = valueGetter(key);
    const ramp = SEQ.map(css);
    const brks = [30, 40, 50, 60, 70, 80];
    colorFor.legend = { type: 'ramp', ramp, ticks: ['<30', '40', '50', '60', '70', '80+'], label: 'Darker = better' };
    return i => { const v = get(i); if (v == null) return '#898781'; let b = 0; while (b < brks.length && v >= brks[b]) b++; return ramp[b]; };
  }
  const f = FIELD[key];
  if (f.type === 'cat') {
    colorFor.legend = { type: 'cat', items: f.cats.slice(0, 9).map(c => [c, f.catColor[c]]) };
    return i => f.catColor[COLS[key][i] ?? '(blank)'] || '#898781';
  }
  if (f.type === 'bool') {
    colorFor.legend = { type: 'cat', items: [['Yes', CATPAL[1]], ['No', CATPAL[0]]] };
    return i => (COLS[key][i] ? CATPAL[1] : CATPAL[0]);
  }
  // numeric: 7 quantile classes over the current matches; darker = more favourable when known
  const vals = filtered.map(i => COLS[key][i]).filter(v => v != null).sort((a, b) => a - b);
  const qs = [1, 2, 3, 4, 5, 6].map(k => vals[Math.floor(k / 7 * (vals.length - 1))] ?? 0);
  let ramp = SEQ.map(css);
  if (f.better === 'low') ramp = ramp.slice().reverse();
  colorFor.legend = { type: 'ramp', ramp, ticks: [vals[0], ...qs.filter((_, j) => j % 2 === 1), vals[vals.length - 1]].map(v => fmt(key, v)),
    label: f.better ? 'Darker = more favorable' : 'Darker = higher' };
  return i => { const v = COLS[key][i]; if (v == null) return '#898781'; let b = 0; while (b < 6 && v > qs[b]) b++; return ramp[b]; };
}
let currentColor = () => '#2a78d6';
function renderLegend() {
  currentColor = colorFor();
  const L_ = colorFor.legend, el = $('#legend');
  if (L_.type === 'ramp') el.innerHTML = `<div class="ramp">${L_.ramp.map(c => `<span style="background:${c}"></span>`).join('')}</div><div class="ticks">${L_.ticks.map(t => `<span>${esc(t)}</span>`).join('')}</div><div class="muted">${L_.label}</div>`;
  else el.innerHTML = `<div class="swatches">${L_.items.map(([n, c]) => `<span class="sw"><i style="background:${c}"></i>${esc(n)}</span>`).join('')}</div>`;
}

function initMap() {
  map = L.map('map', { zoomControl: true, preferCanvas: true, minZoom: OFFLINE ? 9 : 0, maxZoom: 18 }).setView([35.73, -84.08], 10);
  if (OFFLINE) map.setMaxBounds([[35.30, -84.75], [36.15, -83.20]]);
  const base = {}, over = {};
  if (OFFLINE) buildLocalLayers(base, over);
  else {
    const topo = L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, maxNativeZoom: 16, attribution: 'USGS The National Map' });
    const imgTopo = L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, maxNativeZoom: 16, attribution: 'USGS The National Map' });
    const esriImg = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri, Maxar, Earthstar Geographics' });
    const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' });
    const dark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19, attribution: '© OpenStreetMap © CARTO' });
    const isDark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    (isDark ? dark : topo).addTo(map);

    const IMG = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
    const hill = new ArcGISExportLayer(IMG, { format: 'jpgpng', renderingRule: JSON.stringify({ rasterFunction: 'Hillshade Multidirectional' }) }, { opacity: 0.45, attribution: 'USGS 3DEP LiDAR' });
    const slope = new ArcGISExportLayer(IMG, { format: 'png', renderingRule: JSON.stringify({ rasterFunction: 'Slope Map' }) }, { opacity: 0.5, attribution: 'USGS 3DEP' });
    const contours = new ArcGISExportLayer(IMG, { format: 'png', renderingRule: JSON.stringify({ rasterFunction: 'Contour 25' }) }, { opacity: 0.8, minZoom: 13 });
    const flood = new ArcGISExportLayer('https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/export', { format: 'png32', layers: 'show:28' }, { opacity: 0.6, attribution: 'FEMA NFHL' });
    const wet = new ArcGISExportLayer('https://tnmap.tn.gov/arcgis/rest/services/ENVIRONMENTAL/NATIONAL_WETLANDS_INVENTORY/MapServer/export', { format: 'png32', layers: 'show:0' }, { opacity: 0.6, minZoom: 12 });
    Object.assign(base, { 'USGS Topo': topo, 'USGS Imagery + Topo': imgTopo, 'Esri Satellite': esriImg, 'OpenStreetMap': osm, 'Dark': dark });
    const lb = {}, lo = {};
    buildLocalLayers(lb, lo, false);
    base['LiDAR shaded relief + roads'] = L.layerGroup([lb['Shaded relief (LiDAR)'], lo['Roads & water'], lo['City & county lines']]);
    Object.assign(over, { 'LiDAR hillshade': hill, 'Slope (LiDAR)': slope, 'Contours (25 ft)': contours, 'FEMA flood zones': flood, 'NWI wetlands (z12+)': wet });
  }

  const hosp = L.layerGroup(LAYERS.hospitals.map(h => L.marker([h.lat, h.lon], { icon: L.divIcon({ className: '', html: `<div style="background:#d03b3b;color:#fff;border-radius:4px;font-weight:700;width:18px;height:18px;display:grid;place-items:center;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4)">H</div>`, iconSize: [18, 18] }) })
    .bindTooltip(`${esc(h.name)}${h.tags.includes('trauma') ? ' — Level I trauma' : ''}`))).addTo(map);
  const towns = L.layerGroup(LAYERS.towns.map(t => L.circleMarker([t.lat, t.lon], { radius: 4, color: '#0b0b0b', weight: 1.5, fillColor: '#fff', fillOpacity: 1 })
    .bindTooltip(esc(t.name), { permanent: true, direction: 'right', className: 'town-label', offset: [6, 0] }))).addTo(map);
  const peaks = L.layerGroup(LAYERS.targets.map(t => L.circleMarker([t.lat, t.lon], { radius: 3, color: t.kind === 'crest' ? '#d03b3b' : '#c98500', weight: 1, fillOpacity: 0.8 })
    .bindTooltip(`${t.kind === 'crest' ? 'Smokies crest' : 'Foothill'} view target · ${Math.round(t.z * 3.2808)} ft`)));
  const groc = L.layerGroup(LAYERS.groceries.map(g => L.circleMarker([g.lat, g.lon], { radius: 3, color: '#1baf7a', weight: 1, fillOpacity: 0.9 }).bindTooltip(esc(g.name))));

  L.control.layers(base, { ...over, 'Hospitals': hosp, 'Towns': towns, 'Grocery stores': groc, 'Mountain view targets': peaks },
    { position: 'topright', collapsed: true }).addTo(map);
  L.control.scale({ imperial: true, metric: false }).addTo(map);

  parcelLayer = new ParcelCanvas({
    lat: COLS.lat, lon: COLS.lon, polyZoom: 14,
    getRows: () => filtered, getColor: i => currentColor(i), getSelected: () => selected, getStars: () => user.stars,
    getGeom: () => { if (!GEOM) loadGeom(); return GEOM; },
  }).addTo(map);

  map.on('click', e => {
    if (state.spatial.mode === 'radius' && (!state.spatial.center || e.originalEvent.shiftKey || !parcelLayer.pick(e.containerPoint))) {
      state.spatial.center = [e.latlng.lat, e.latlng.lng]; drawRadius(); recompute(); return;
    }
    const i = parcelLayer.pick(e.containerPoint, TOUCH ? 22 : 9);
    if (i != null) select(i, false);
  });
  // locate-me control
  const Locate = L.Control.extend({ options: { position: 'topleft' }, onAdd() {
    const a = L.DomUtil.create('a', 'locate-btn leaflet-bar-part'); a.href = '#'; a.title = 'Show my location'; a.setAttribute('role', 'button');
    a.setAttribute('aria-label', 'Show my location'); a.innerHTML = '&#9678;';
    const bar = L.DomUtil.create('div', 'leaflet-bar'); bar.appendChild(a);
    L.DomEvent.on(a, 'click', ev => { L.DomEvent.preventDefault(ev); L.DomEvent.stopPropagation(ev); locateMe(ll => { map.flyTo(ll, Math.max(map.getZoom(), 12)); renderCards(); }); });
    return bar;
  } });
  new Locate().addTo(map);
  let hoverT;
  map.on('mousemove', e => {
    if (TOUCH) return;
    clearTimeout(hoverT);
    hoverT = setTimeout(() => {
      const i = parcelLayer.pick(e.containerPoint);
      map.getContainer().style.cursor = i != null ? 'pointer' : '';
      if (i != null) {
        const tip = `<b>${Math.round(SCORE[i])}</b> · ${fmt('acres', COLS.acres[i])} · ${esc(COLS.nearest_town[i] || '')}<br>View ${fmt('view_smokies', COLS.view_smokies[i])} · slope ${fmt('slope_mean', COLS.slope_mean[i])} · ER ${fmt('dt_ed_min', COLS.dt_ed_min[i])}`;
        if (!initMap.tip) initMap.tip = L.tooltip({ direction: 'top', offset: [0, -8], opacity: 0.95 });
        initMap.tip.setLatLng([COLS.lat[i], COLS.lon[i]]).setContent(tip);
        if (!map.hasLayer(initMap.tip)) initMap.tip.addTo(map);
      } else if (initMap.tip && map.hasLayer(initMap.tip)) map.removeLayer(initMap.tip);
    }, 30);
  });
  map.on('moveend', () => { if (state.spatial.mode === 'view') debounced(); });
}

// Self-contained basemap: LiDAR shaded relief images + vector roads/water/boundaries built by s85_basemap.py.
const vecLayers = [];
function vecStyle(f) {
  const p = f.properties, k = p.kind;
  if (k === 'water') return { stroke: false, fill: true, fillColor: css('--map-water'), fillOpacity: 1 };
  if (k === 'river') return { color: css('--map-water'), weight: 1.5 };
  if (k === 'flood') return { stroke: false, fill: true, fillColor: css('--map-flood'), fillOpacity: 0.35 };
  if (k === 'wetland') return { color: css('--map-wetland'), weight: 0.8, fill: true, fillColor: css('--map-wetland'), fillOpacity: 0.35 };
  if (k === 'county') return { color: css('--map-county'), weight: 1.6, dashArray: '8 4 2 4', fill: false };
  if (k === 'city') return { color: css('--map-city'), weight: 1.2, dashArray: '3 3', fill: false };
  if (k === 'rail') return { color: css('--map-road'), weight: 1, dashArray: '4 3' };
  const w = { motorway: 3.2, trunk: 2.6, primary: 2.2, secondary: 1.6, tertiary: 1.1, local: 1 }[p.cls] || 1;
  return { color: css(['motorway', 'trunk', 'primary'].includes(p.cls) ? '--map-road-major' : '--map-road'), weight: w, opacity: 0.9 };
}
function buildLocalLayers(base, over, show = true) {
  map.createPane('relief').style.zIndex = 150;
  map.createPane('vectors').style.zIndex = 350;
  map.createPane('hazards').style.zIndex = 360;
  const rVec = L.canvas({ pane: 'vectors' }), rHaz = L.canvas({ pane: 'hazards' });
  const relief = show ? L.layerGroup().addTo(map) : L.layerGroup();
  const slope = L.layerGroup();
  const roads = L.layerGroup(), local = L.layerGroup(), bounds = L.layerGroup();
  if (show) { roads.addTo(map); bounds.addTo(map); }
  const flood = L.layerGroup(), wet = L.layerGroup();
  Object.assign(base, { 'Shaded relief (LiDAR)': relief, 'Plain': L.layerGroup() });
  Object.assign(over, { 'Roads & water': roads, 'City & county lines': bounds, 'Slope classes (LiDAR)': slope, 'FEMA flood zones': flood, 'NWI wetlands': wet });
  fetch('data/basemap/meta.json').then(r => r.json()).then(m => {
    const att = 'USGS 3DEP LiDAR';
    relief.addLayer(L.imageOverlay('data/basemap/relief_region.jpg', m.relief_region, { pane: 'relief', attribution: att }));
    relief.addLayer(L.imageOverlay('data/basemap/relief_study.jpg', m.relief_study, { pane: 'relief' }));
    slope.addLayer(L.imageOverlay('data/basemap/slope.png', m.slope, { pane: 'hazards', opacity: 0.85 }));
  });
  fetch('data/basemap/vectors.json').then(r => r.json()).then(fc => {
    const pick = fn => ({ type: 'FeatureCollection', features: fc.features.filter(fn) });
    const mk = (fn, r) => { const l = L.geoJSON(pick(fn), { style: vecStyle, renderer: r, interactive: false, attribution: 'Overture Maps / OpenStreetMap' }); vecLayers.push(l); return l; };
    roads.addLayer(mk(f => ['water', 'river'].includes(f.properties.kind), rVec));
    roads.addLayer(mk(f => ['road', 'rail'].includes(f.properties.kind) && f.properties.cls !== 'local', rVec));
    local.addLayer(mk(f => f.properties.cls === 'local', rVec));
    bounds.addLayer(mk(f => ['city', 'county'].includes(f.properties.kind), rVec));
    const syncLocal = () => { const on = map.hasLayer(roads) && map.getZoom() >= 13; if (on && !map.hasLayer(local)) local.addTo(map); if (!on && map.hasLayer(local)) local.remove(); };
    map.on('zoomend overlayadd overlayremove baselayerchange', syncLocal); syncLocal();
  });
  fetch('data/basemap/overlays.json').then(r => r.json()).then(fc => {
    for (const [grp, kind] of [[flood, 'flood'], [wet, 'wetland']]) {
      const l = L.geoJSON({ type: 'FeatureCollection', features: fc.features.filter(f => f.properties.kind === kind) }, { style: vecStyle, renderer: rHaz, interactive: false, attribution: kind === 'flood' ? 'FEMA NFHL' : 'USFWS NWI' });
      vecLayers.push(l); grp.addLayer(l);
    }
  });
}
function restyleVectors() { for (const l of vecLayers) l.setStyle(vecStyle); }

let geomPromise = null;
function loadGeom() {
  if (!geomPromise) {
    geomLoading = true;
    geomPromise = fetch('data/geom.json').then(r => r.json()).then(g => { GEOM = g; parcelLayer.redraw(); return g; });
  }
  return geomPromise;
}
async function loadHorizon() {
  if (HORIZON) return HORIZON;
  let buf;
  if (OFFLINE) { // sandboxed hosts only serve text types: the int16 array ships base64-encoded
    const b = atob((await fetch('data/horizon.b64.txt').then(r => r.text())).trim());
    const u8 = new Uint8Array(b.length);
    for (let k = 0; k < b.length; k++) u8[k] = b.charCodeAt(k);
    buf = u8.buffer;
  } else buf = await fetch('data/horizon.bin').then(r => r.arrayBuffer());
  HORIZON = new Int16Array(buf);
  return HORIZON;
}

function drawRadius() {
  const sp = state.spatial;
  if (radiusCircle) { radiusCircle.remove(); radiusCircle = null; }
  if (centerMarker) { centerMarker.remove(); centerMarker = null; }
  if (sp.mode === 'radius' && sp.center) {
    radiusCircle = L.circle(sp.center, { radius: sp.radius * 1609.344, color: '#2a78d6', weight: 2, fill: false, dashArray: '6 4', interactive: false }).addTo(map);
    centerMarker = L.circleMarker(sp.center, { radius: 4, color: '#2a78d6', fillOpacity: 1, interactive: false }).addTo(map);
  }
}

// ---------------------------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------------------------
function select(i, fly = true) {
  selected = i;
  if (isMobile() && state.view !== 'map') setView('map');
  renderDetail(i);
  highlight(i);
  if (fly) focusParcel(i);
  parcelLayer.redraw();
  $$('#results tbody tr').forEach(tr => tr.classList.toggle('is-sel', +tr.dataset.i === i));
  $$('#cards .card').forEach(el => el.classList.toggle('is-sel', +el.dataset.i === i));
}

// Selected parcel: bold outline + pulsing ring at the house site, drawn above everything else.
let hlLayer = null, hoverLayer = null;
const ringIcon = cls => L.divIcon({ className: '', html: `<div class="${cls}"></div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
function parcelLatLngs(i) { return GEOM && GEOM[i] && GEOM[i].length ? GEOM[i] : null; }
function highlight(i) {
  if (!map.getPane('highlight')) { map.createPane('highlight').style.zIndex = 640; }
  if (hlLayer) hlLayer.remove();
  hlLayer = L.layerGroup().addTo(map);
  const draw = () => {
    if (selected !== i) return;
    hlLayer.clearLayers();
    const rings = parcelLatLngs(i);
    if (rings) {
      hlLayer.addLayer(L.polygon(rings, { pane: 'highlight', color: '#ffffff', weight: 8, opacity: 0.95, fill: false, interactive: false }));
      hlLayer.addLayer(L.polygon(rings, { pane: 'highlight', color: '#d03b3b', weight: 3.5, fillColor: '#d03b3b', fillOpacity: 0.18, interactive: false }));
    }
    hlLayer.addLayer(L.marker([COLS.lat[i], COLS.lon[i]], { icon: ringIcon('pulse-ring'), pane: 'highlight', interactive: false, keyboard: false }));
  };
  draw();
  if (!GEOM) loadGeom().then(draw);
}
function clearHighlight() { if (hlLayer) { hlLayer.remove(); hlLayer = null; } }
function hoverHighlight(i) {
  if (hoverLayer) { hoverLayer.remove(); hoverLayer = null; }
  if (i == null || i === selected) return;
  hoverLayer = L.marker([COLS.lat[i], COLS.lon[i]], { icon: ringIcon('hover-ring'), pane: map.getPane('highlight') ? 'highlight' : 'markerPane', interactive: false, keyboard: false }).addTo(map);
}

// Fly so the parcel lands in the part of the map the detail panel and overlays leave visible.
async function focusParcel(i) {
  if (isMobile()) $('.map-wrap').scrollIntoView({ behavior: 'auto', block: 'start' });
  if (!GEOM) { try { await loadGeom(); } catch { /* fall back to the house-site point */ } }
  if (selected !== i) return;
  const rings = parcelLatLngs(i);
  const bounds = rings ? L.latLngBounds(rings.flat()) : L.latLng(COLS.lat[i], COLS.lon[i]).toBounds(250);
  // keep the parcel clear of the detail panel / bottom sheet and the colour-by box
  const m = map.getContainer().getBoundingClientRect();
  const det = DOM.detail && !DOM.detail.hidden ? DOM.detail.getBoundingClientRect() : null;
  const ctl = $('#map-ctl').getBoundingClientRect();
  let right = 30, bottom = 30;
  const top = Math.min(Math.max(30, ctl.bottom - m.top + 10), m.height * 0.35);
  if (det && det.left > m.left + 50 && det.top <= m.top + 5) right = Math.max(right, m.right - det.left + 30);   // side panel
  else if (det) bottom = Math.max(bottom, m.bottom - det.top + 20);                                             // bottom sheet
  bottom = Math.min(bottom, m.height - top - 80);
  right = Math.min(right, m.width - 110);
  map.flyToBounds(bounds, { paddingTopLeft: [30, top], paddingBottomRight: [right, bottom], maxZoom: 17, duration: 0.8 });
}

function links(i) {
  const lat = COLS.lat[i], lon = COLS.lon[i];
  const town = (COLS.nearest_town[i] || COLS.county[i]).replace(/ /g, '-');
  const addr = COLS.address[i] ? `${COLS.address[i]}, ${COLS.county[i]} County, TN` : `${lat},${lon}`;
  const L_ = [
    ['County assessor (TPAD)', `https://assessment.cot.tn.gov/TPAD/Parcel/GIS?gislink=${encodeURIComponent(COLS.gislink[i])}`],
    ['TN parcel viewer', `https://tnmap.tn.gov/assessment/#/parcel/${encodeURIComponent(COLS.gislink[i])}`],
    ['Google satellite', `https://www.google.com/maps/@?api=1&map_action=map&center=${lat},${lon}&zoom=18&basemap=satellite`],
    ['Google Earth 3D', `https://earth.google.com/web/@${lat},${lon},300a,900d,35y,135h,70t,0r`],
    ['Zillow (land near here)', `https://www.zillow.com/homes/for_sale/${encodeURIComponent(town)}-TN/land_type/`],
    ['Realtor.com land', `https://www.realtor.com/realestateandhomes-search/${encodeURIComponent(town)}_TN/type-land`],
    ['LandWatch', `https://www.landwatch.com/tennessee-land-for-sale/${COLS.county[i].toLowerCase()}-county`],
    ['Search web for listing', `https://www.google.com/search?q=${encodeURIComponent(`"${COLS.address[i] || ''}" ${COLS.county[i]} County TN land for sale`)}`],
    ['FEMA flood map', `https://msc.fema.gov/portal/search?AddressQuery=${lat}%2C${lon}`],
    ['FCC broadband', `https://broadbandmap.fcc.gov/location-summary/fixed?lat=${lat}&lon=${lon}&zoom=15`],
    ['SoilWeb', `https://casoilresource.lawr.ucdavis.edu/gmap/?loc=${lat},${lon},z16`],
  ];
  void addr;
  return L_.map(([t, u]) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`).join('');
}

async function renderDetail(i) {
  const d = DOM.detail; d.hidden = false;
  const c = k => COLS[k]?.[i];
  const flags = [];
  const badge = (txt, cls) => flags.push(`<span class="badge ${cls}">${esc(txt)}</span>`);
  if (c('view_smokies') >= 15) badge(`Smokies view ${Math.round(c('view_smokies'))}%`, 'good');
  if (c('sinkhole_risk') === 'High') badge('High sinkhole risk', 'bad'); else if (c('sinkhole_risk') === 'Low') badge('Low sinkhole risk', 'good');
  if (c('flood_pct') > 0) badge(`${Math.round(c('flood_pct'))}% in flood zone`, c('flood_pct') > 20 ? 'bad' : 'warn');
  if (c('under_approach')) badge('Under TYS flight path', 'bad');
  if (c('noise_db') >= 58) badge(`Noisy (~${Math.round(c('noise_db'))} dBA)`, 'warn');
  if (c('bldg_fp') > 0 && !c('synthetic')) badge(`${c('bldg_fp')} structure(s) detected`, 'warn');
  if (c('synthetic')) badge('Approximate area: no exact parcel match', 'warn');
  if (c('greenbelt')) badge('Greenbelt', 'warn');
  if (c('waterfront')) badge('Waterfront', 'good');

  const sub = SUB[i];
  const kvGroups = GROUPS.map(g => {
    const fs = META.fields.filter(f => f.group === g && !['address', 'owner', 'gislink'].includes(f.key));
    return `<div class="kv-group"><h3>${esc(g)}</h3><div class="kv">${fs.map(f => `<div title="${esc(f.desc)}">${esc(f.label)}</div><div>${esc(fmt(f.key, c(f.key)))}${f.type === 'num' && c(f.key) != null ? `<span class="pct">${pctRank(f.key, c(f.key))}</span>` : ''}</div>`).join('')}</div></div>`;
  }).join('');
  const wasOpen = !d.dataset.for || d.dataset.for === String(i);
  d.dataset.for = i;
  if (!wasOpen) d.classList.remove('sheet-full');
  d.innerHTML = `<div class="sheet-handle" role="button" tabindex="0" aria-label="Expand or collapse details"></div><button class="icon-btn close" aria-label="Close">✕</button>
    <h2>${esc(c('address') || 'Vacant parcel')} · ${fmt('acres', c('acres'))}</h2>
    ${c('list_url') ? `<div class="listing-box"><div><b>${fmt('list_price', c('list_price'))}</b> asking · ${fmt('list_acres', c('list_acres'))} listed${c('list_ppa') ? ` · ${fmt('list_ppa', c('list_ppa'))}/ac` : ''}</div>
      <div class="muted">${esc(c('list_status'))}${c('days_listed') != null ? ` · on market ${nf0.format(c('days_listed'))} days` : ''} · ${esc(c('list_match'))}</div>
      <a class="btn small primary" href="${esc(c('list_url'))}" target="_blank" rel="noopener">View listing on LandSearch ↗</a></div>` : '<div class="listing-box muted">Not currently listed for sale (as of the last listing check).</div>'}
    <div class="sub">${esc(c('nearest_town') || '')} area · ${esc(c('county'))} Co. · ${esc(c('city'))} · ID ${esc(c('gislink'))}<br>Owner: ${esc(c('owner') || '—')}${c('mail_city') ? ` (${esc(c('mail_city'))}, ${esc(c('mail_state'))})` : ''}</div>
    <div class="flags">${flags.join('')}</div>
    <div class="actions">
      <button class="btn small ${user.stars.has(i) ? 'on' : ''}" data-act="star">${user.stars.has(i) ? '★ Shortlisted' : '☆ Shortlist'}</button>
      <button class="btn small" data-act="hide">${user.hidden.has(i) ? 'Unhide' : 'Hide'}</button>
      <button class="btn small hide-phone" data-act="cmp">${compareSet.has(i) ? 'Remove from compare' : 'Add to compare'}</button>
      <button class="btn small" data-act="zoom">Show on map</button>
      <a class="btn small" href="https://maps.apple.com/?daddr=${c('lat')},${c('lon')}&dirflg=d" target="_blank" rel="noopener">Directions (Apple)</a>
      <a class="btn small" href="https://www.google.com/maps/dir/?api=1&destination=${c('lat')},${c('lon')}" target="_blank" rel="noopener">Directions (Google)</a>
      <button class="btn small" data-act="share">Share this parcel</button>
    </div>
    <div class="score-big"><b>${Math.round(SCORE[i])}</b><span class="muted">overall score · rank ${nf0.format(sortedByScoreRank(i))} of ${nf0.format(filtered.length)} matches</span></div>
    <div class="subscores">${CATEGORIES.map(cat => `<span title="${esc(explain(ROWS[i], ctxScore, cat.key).map(e => `${e.label}: ${e.v == null ? '—' : Math.round(e.v)}`).join('\n'))}">${cat.label}</span><div class="bar"><i style="width:${Math.round(sub[cat.key] ?? 0)}%"></i></div><output>${sub[cat.key] == null ? '—' : Math.round(sub[cat.key])}</output>`).join('')}</div>

    <div class="kv-group"><h3>Skyline from house site (6 m eye height, bare earth)</h3><div id="skyline"></div></div>
    <div class="kv-group"><h3>Research links</h3><div class="links">${links(i)}</div></div>
    <div class="kv-group"><h3>My notes</h3>
      <textarea placeholder="Notes (saved in this browser)" data-note>${esc(user.notes[i] || '')}</textarea></div>
    ${kvGroups}
    <p class="muted" style="margin-top:14px">Data year: ${c('data_year') || '—'}. Values are screening estimates; verify on site and with the county.</p>`;
  d.querySelector('.close').onclick = () => closeDetail();
  wireSheet(d);
  d.querySelector('.actions').onclick = e => {
    const a = e.target.dataset.act; if (!a) return;
    if (a === 'star') toggleStar(i);
    if (a === 'hide') { user.hidden.has(i) ? user.hidden.delete(i) : user.hidden.add(i); saveUser(); recompute({ keepTable: true }); }
    if (a === 'cmp') { compareSet.has(i) ? compareSet.delete(i) : compareSet.add(i); renderTable(); }
    if (a === 'zoom') { if (isMobile()) d.classList.remove('sheet-full'); focusParcel(i); }
    if (a === 'share') { shareUrl(location.href.split('#')[0] + '#s=' + b64.enc({ ...serialize(), sel: COLS.gislink[i] }), `${c('address') || 'Parcel'} · ${fmt('acres', c('acres'))}`); return; }
    renderDetail(i);
  };
  d.querySelector('[data-note]').oninput = e => { user.notes[i] = e.target.value; if (!e.target.value) delete user.notes[i]; saveUser(); };
  drawSkyline(i);
}
function closeDetail() {
  const d = DOM.detail; d.hidden = true; d.classList.remove('sheet-full'); d.style.removeProperty('--sheet-h'); delete d.dataset.for;
  selected = null; clearHighlight(); parcelLayer.redraw();
  $$('#cards .card.is-sel').forEach(el => el.classList.remove('is-sel'));
}
// Bottom sheet on phones: tap the handle to expand/collapse, drag it to resize or swipe down to close.
function wireSheet(d) {
  const h = d.querySelector('.sheet-handle'); if (!h) return;
  h.onclick = () => { d.classList.toggle('sheet-full'); d.style.removeProperty('--sheet-h'); };
  let y0 = null, h0 = 0;
  h.addEventListener('touchstart', e => { y0 = e.touches[0].clientY; h0 = d.getBoundingClientRect().height; d.classList.add('dragging'); }, { passive: true });
  h.addEventListener('touchmove', e => {
    if (y0 == null) return;
    e.preventDefault();
    const nh = Math.max(80, Math.min(window.innerHeight * 0.92, h0 + (y0 - e.touches[0].clientY)));
    d.style.setProperty('--sheet-h', nh + 'px');
  }, { passive: false });
  h.addEventListener('touchend', e => {
    if (y0 == null) return;
    const dy = e.changedTouches[0].clientY - y0; y0 = null;
    d.classList.remove('dragging'); d.style.removeProperty('--sheet-h');
    if (Math.abs(dy) < 8) return;                                   // a tap: handled by click
    if (dy > 0 && !d.classList.contains('sheet-full') && dy > 80) closeDetail();
    else d.classList.toggle('sheet-full', dy < 0);
  });
}
async function shareUrl(url, title) {
  if (navigator.share && TOUCH) {
    try { await navigator.share({ title: title || 'East TN Land Finder', url }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('Link copied'); }
  catch { openDialog(`<h2>Share link</h2><textarea readonly>${esc(url)}</textarea>`); }
}

function sortedByScoreRank(i) { let r = 1; const s = SCORE[i]; for (const j of filtered) if (SCORE[j] > s) r++; return r; }
function pctRank(key, v) {
  const f = FIELD[key]; if (!f.better) return '';
  const col = COLS[key]; let lo = 0, n = 0;
  for (let i = 0; i < N; i++) { const x = col[i]; if (x == null) continue; n++; if (f.better === 'high' ? x < v : x > v) lo++; }
  const p = Math.round(lo / n * 100);
  return p >= 50 ? `better than ${p}%` : `top ${100 - p}% worst`.replace('top', 'in bottom').replace(' worst', '');
}

async function drawSkyline(i) {
  const host = $('#skyline'); if (!host) return;
  const H = await loadHorizon();
  const step = LAYERS.horizon_az_step || 5, n = 360 / step;
  const ang = Array.from({ length: n }, (_, k) => H[i * n + k] / 10);
  const W = 400, Hh = 132, base = 100;
  const mx = Math.max(4, ...ang), mn = Math.min(-1, ...ang);
  const y = a => base - (a - Math.min(0, mn)) / (mx - Math.min(0, mn)) * 85;
  const x = az => ((az - 0 + 360) % 360) / 360 * W; // 0° (N) at left
  let path = `M0,${base} `;
  for (let k = 0; k <= n; k++) path += `L${(k / n) * W},${y(ang[k % n]).toFixed(1)} `;
  path += `L${W},${base} Z`;
  const lat = COLS.lat[i], lon = COLS.lon[i];
  const az = t => { const dy = t.lat - lat, dx = (t.lon - lon) * Math.cos(lat * Math.PI / 180); return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360; };
  const ticks = LAYERS.targets.map(t => `<line class="${t.kind === 'crest' ? 'crest' : 'foot'}" x1="${x(az(t)).toFixed(1)}" x2="${x(az(t)).toFixed(1)}" y1="${base + 3}" y2="${base + (t.kind === 'crest' ? 11 : 7)}"/>`).join('');
  const lbl = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].map((t, k) => `<text x="${x(k * 45) + 2}" y="${Hh - 2}">${t}</text>`).join('');
  host.innerHTML = `<svg class="skyline" style="height:132px" viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none" role="img" aria-label="Terrain skyline">
    <line class="axis" x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke-dasharray="3 3"/>
    <path class="terrain" d="${path}"/>${ticks}${lbl}
    <text x="${W - 2}" y="10" text-anchor="end">max ${mx.toFixed(1)}° above level</text></svg>
    <div class="muted" style="font-size:11px">Red ticks = Smokies crest directions, gold = foothills. Smokies crest visible: ${fmt('view_smokies', COLS.view_smokies[i])} of points; foothills ${fmt('view_foothills', COLS.view_foothills[i])}.</div>`;
}

function toggleStar(i) {
  user.stars.has(i) ? user.stars.delete(i) : user.stars.add(i);
  saveUser(); renderTable(); parcelLayer.redraw();
  if (state.onlyStar) recompute({ keepTable: true });
}

// ---------------------------------------------------------------------------------------------
// Presets, saved searches, URL state
// ---------------------------------------------------------------------------------------------
function applyPreset(id) {
  const p = PRESETS.find(x => x.id === id); if (!p) return;
  state.preset = id;
  if (p.scope) state.scope = p.scope;
  state.weights = { ...p.weights };
  state.filters = JSON.parse(JSON.stringify(p.filters));
  for (const [k, s] of Object.entries(state.filters)) {
    const f = FIELD[k];
    if (f?.type === 'num') state.filters[k] = { min: s.min ?? f.min, max: s.max ?? f.max };
  }
  syncControls();
  recompute();
}
function syncControls() {
  $$('#weights input').forEach(inp => { inp.value = state.weights[inp.dataset.w]; inp.nextElementSibling.textContent = inp.value; });
  $('#minscore').value = state.minScore; $('#minscore-out').textContent = state.minScore;
  $('#q').value = state.q;
  $$('#spatial-mode button').forEach(b => b.classList.toggle('on', b.dataset.v === state.spatial.mode));
  $('#radius-ctl').hidden = state.spatial.mode !== 'radius';
  $('#radius').value = state.spatial.radius; $('#radius-out').textContent = state.spatial.radius;
  $$('#scope button').forEach(b => b.classList.toggle('on', b.dataset.v === state.scope));
  $('#only-star').checked = state.onlyStar; $('#show-hidden').checked = state.showHidden;
  $('#color-by').value = state.colorBy;
  $('#preset').value = PRESETS.some(p => p.id === state.preset) ? state.preset : '';
  if (map) drawRadius();
}
function serialize() {
  const f = {};
  for (const [k, s] of activeFilters()) f[k] = s;
  return { p: state.preset, f, w: state.weights, ms: state.minScore, q: state.q, sp: state.spatial, c: state.colorBy, os: state.onlyStar, ol: state.onlyListed, sc: state.scope, cols: state.columns, s: state.sort };
}
function deserialize(o) {
  state.preset = o.p ?? 'custom'; state.filters = o.f || {}; state.weights = { ...state.weights, ...(o.w || {}) };
  state.minScore = o.ms || 0; state.q = o.q || ''; state.spatial = { ...state.spatial, ...(o.sp || {}) };
  state.colorBy = o.c || 'score'; state.onlyStar = !!o.os; state.onlyListed = !!o.ol; state.scope = o.sc || 'sale';
  if (Array.isArray(o.cols)) state.columns = o.cols.filter(k => k === 'score' || k.startsWith('s_') || FIELD[k]);
  if (o.s) state.sort = o.s;
}
const b64 = { enc: o => btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: s => JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))))) };
let hashT;
function updateHash() { if (OFFLINE) return; clearTimeout(hashT); hashT = setTimeout(() => { try { history.replaceState(null, '', '#s=' + b64.enc(serialize())); } catch { /* ignore */ } }, 300); }

function savedDialog() {
  const saved = LS.get('saved', {});
  const names = Object.keys(saved);
  openDialog(`<h2>Saved searches</h2>
    <p class="hint">Saved in this browser. To send a search to someone, copy it as a code; they paste it here.</p>
    <div style="display:flex;gap:6px;margin-bottom:10px"><input id="save-name" placeholder="Name this search" style="flex:1;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--page)"><button class="btn primary" type="button" id="save-go">Save current</button></div>
    <div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap"><button class="btn" type="button" id="code-copy">Copy current search as code</button><input id="code-in" placeholder="…or paste a search code" style="flex:1;min-width:160px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--page)"><button class="btn" type="button" id="code-load">Load code</button></div>
    ${names.length ? `<table class="cmp"><tbody>${names.map(n => `<tr><td>${esc(n)}</td><td><button class="btn small" type="button" data-load="${esc(n)}">Load</button> <button class="btn small" type="button" data-del="${esc(n)}">Delete</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No saved searches yet.</p>'}`);
  $('#code-copy').onclick = () => { const c = b64.enc(serialize()); navigator.clipboard.writeText(c).then(() => toast('Search code copied')).catch(() => { $('#code-in').value = c; $('#code-in').select(); }); };
  $('#code-load').onclick = () => { try { deserialize(b64.dec($('#code-in').value.trim())); syncControls(); recompute(); $('#dlg').close(); toast('Search loaded'); } catch { toast('That code could not be read'); } };
  $('#save-go').onclick = () => { const n = $('#save-name').value.trim(); if (!n) return; saved[n] = serialize(); LS.set('saved', saved); toast('Saved'); savedDialog(); };
  $('#dlg-body').onclick = e => {
    if (e.target.dataset.load) { deserialize(saved[e.target.dataset.load]); syncControls(); recompute(); $('#dlg').close(); }
    if (e.target.dataset.del) { delete saved[e.target.dataset.del]; LS.set('saved', saved); savedDialog(); }
  };
}

function openDialog(html) { $('#dlg-body').innerHTML = html; const d = $('#dlg'); if (!d.open) d.showModal(); }

// ---------------------------------------------------------------------------------------------
// Dialogs: compare, columns, import, help
// ---------------------------------------------------------------------------------------------
function compareDialog() {
  const ids = [...compareSet];
  const keys = ['score', ...CATEGORIES.map(c => 's_' + c.key), ...META.fields.filter(f => f.type !== 'text').map(f => f.key)];
  const val = (k, i) => (k === 'score' ? SCORE[i] : k.startsWith('s_') ? SUB[i][k.slice(2)] : COLS[k][i]);
  const rows = keys.map(k => {
    const f = FIELD[k]; const vs = ids.map(i => val(k, i));
    let best = null;
    if (f?.type === 'num' && f.better) { const nums = vs.filter(v => v != null); if (nums.length > 1) best = f.better === 'high' ? Math.max(...nums) : Math.min(...nums); }
    return `<tr><td>${esc(colLabel(k))}</td>${vs.map(v => `<td class="${best != null && v === best ? 'best' : ''}">${esc(k === 'score' || k.startsWith('s_') ? (v == null ? '—' : Math.round(v)) : fmt(k, v))}</td>`).join('')}</tr>`;
  }).join('');
  openDialog(`<h2>Compare parcels</h2><p class="hint">Green = best among these parcels.</p>
    <table class="cmp"><thead><tr><th></th>${ids.map(i => `<th>${esc(COLS.address[i] || COLS.gislink[i])}<br><span class="muted">${fmt('acres', COLS.acres[i])}</span></th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
    <div class="dlg-foot" style="justify-content:flex-start"><button class="btn" type="button" id="cmp-clear">Clear comparison</button></div>`);
  $('#cmp-clear').onclick = () => { compareSet.clear(); renderTable(); $('#dlg').close(); };
}

function columnsDialog() {
  const all = ['score', ...CATEGORIES.map(c => 's_' + c.key), ...META.fields.map(f => f.key)];
  openDialog(`<h2>Table columns</h2><div class="colgrid">${all.map(k => `<label><input type="checkbox" value="${k}" ${state.columns.includes(k) ? 'checked' : ''}> ${esc(colLabel(k))}</label>`).join('')}</div>`);
  $('#dlg-body').onchange = () => { state.columns = $$('#dlg-body input:checked').map(x => x.value); renderTable(); updateHash(); };
}

function helpDialog() {
  openDialog(`<div class="about"><h2>About this dashboard</h2>
    <p><b>${nf0.format(N)}</b> land listings for sale in Blount, Loudon and northern Monroe counties (LandSearch.com, checked ${esc(META.listings_fetched || '—')}). Data built ${META.generated}.</p>
    <ul>${META.sources.map(s => `<li>${esc(s)}</li>`).join('')}</ul>
    <h3>How to use it</h3>
    <ul><li>Open <b>Filters</b> (top left) to show or hide the filter panel. <b>Quick filters</b> hold the most-used ones; every other metric is under <b>All filters by topic</b>.</li>
    <li>Start with a <b>preset</b>, then tune filters. Every metric is a filter; histograms show the whole dataset (gray) and what passes your <i>other</i> filters (blue).</li>
    <li>Adjust <b>scoring weights</b> to rank what remains. Hover a sub-score in the detail panel to see how it was computed.</li>
    <li>Click a parcel for its skyline toward the Smokies, research links (assessor, flood map, broadband, listings), notes and listing info.</li>
    <li>Shortlist (★), hide, compare, save searches, share links, and export CSV/GeoJSON.</li></ul>
    <h3>Important caveats</h3>
    <ul><li>Listings come from LandSearch.com, which aggregates MLS and broker listings. A few listings elsewhere may be missing. Each listing is matched to the parcel under its map point, so a listing spanning several parcels shows on one. </li>
    <li>Views use a bare-earth LiDAR model: trees are ignored. Check canopy on imagery.</li>
    <li>Noise is a screening model by road class and distance, with no terrain shielding. Drive times are free-flow (add 10–25% at rush hour).</li>
    <li>Loudon/Monroe assessor attributes are a 2023 snapshot. “Sold since snapshot” flags changed owners. “Structures detected” uses building footprints.</li>
    <li>Sinkhole risk comes from USGS-mapped depressions plus soils. It is not a geotechnical survey. Septic ratings are SSURGO map-unit level, and a TDEC perc test is still required.</li></ul>
    <p>Full criteria list and due-diligence checklist: <code>docs/CRITERIA.md</code> in the repository.</p></div>`);
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------
async function download(name, text, type) {
  if (OFFLINE) {
    // sandboxed host: hand the file to the viewer's save prompt when the host offers one
    const dl = await window.claude?.use?.('downloads').catch(() => null);
    if (dl) {
      try { await dl.save({ filename: name.replace(/\.geojson$/, '.json'), data: new Blob([text]) }); toast('Saved'); return; }
      catch (err) { if (err?.code === 'declined' || err?.code === 'rate_limited') return; }
    }
    // no save prompt available: show the text with a copy button instead
    const big = text.length > 3e6;
    openDialog(`<h2>${esc(name)}</h2><p class="hint">Saving files isn't available here. Copy the text and save it as <code>${esc(name)}</code>${big ? ' (large: the preview below is truncated, but Copy takes everything)' : ''}.</p>
      <textarea id="exp-text" readonly style="min-height:260px">${esc(big ? text.slice(0, 200000) + '\n…' : text)}</textarea>
      <div class="dlg-foot" style="justify-content:flex-start"><button class="btn primary" type="button" id="exp-copy">Copy to clipboard</button><span class="muted" id="exp-res"></span></div>`);
    $('#exp-copy').onclick = () => navigator.clipboard.writeText(text).then(() => { $('#exp-res').textContent = 'Copied'; })
      .catch(() => { const t = $('#exp-text'); t.focus(); t.select(); $('#exp-res').textContent = 'Press Ctrl/Cmd+C to copy the selection'; });
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function toCSV(ids) {
  const keys = ['score', ...CATEGORIES.map(c => 's_' + c.key), ...META.fields.map(f => f.key), 'lat', 'lon'];
  const q = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const head = [...keys, 'list_url', 'shortlisted', 'notes'];
  const lines = ids.map(i => [...keys.map(k => (k === 'score' ? Math.round(SCORE[i]) : k.startsWith('s_') ? (SUB[i][k.slice(2)] == null ? '' : Math.round(SUB[i][k.slice(2)])) : COLS[k][i])),
    COLS.list_url[i], user.stars.has(i) ? 1 : 0, user.notes[i] || ''].map(q).join(','));
  return [head.join(','), ...lines].join('\n');
}
async function doExport(kind) {
  const ids = sortedRows;
  if (kind === 'csv') download('east-tn-parcels.csv', toCSV(ids), 'text/csv');
  if (kind === 'csv-star') download('east-tn-shortlist.csv', toCSV([...user.stars]), 'text/csv');
  if (kind === 'ids') {
    const txt = ids.map(i => COLS.gislink[i]).join('\n');
    try { await navigator.clipboard.writeText(txt); toast(`Copied ${ids.length} IDs`); } catch { download('parcel-ids.txt', txt, 'text/plain'); }
  }
  if (kind === 'geojson') {
    if (!GEOM) GEOM = await fetch('data/geom.json').then(r => r.json());
    const feats = ids.map(i => ({ type: 'Feature', properties: Object.fromEntries([['score', Math.round(SCORE[i])], ...META.fields.map(f => [f.key, COLS[f.key][i]])]),
      geometry: { type: 'MultiPolygon', coordinates: (GEOM[i] || []).map(r => [r.map(([a, b]) => [b, a])]) } }));
    download('east-tn-parcels.geojson', JSON.stringify({ type: 'FeatureCollection', features: feats }), 'application/geo+json');
  }
}

// ---------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------
const isMobile = () => matchMedia('(max-width: 900px)').matches;
function sidebarOpen() { return isMobile() ? document.body.classList.contains('side-open') : !document.body.classList.contains('side-closed'); }
function setSidebar(open) {
  if (isMobile()) document.body.classList.toggle('side-open', open);
  else { document.body.classList.toggle('side-closed', !open); LS.set('sideClosed', !open); }
  $('#btn-filters').setAttribute('aria-expanded', open);
  setTimeout(() => map && map.invalidateSize(), 60);
}
function setTable(open) {
  state.tableCollapsed = !open; LS.set('tableCollapsed', !open);
  $('#main').classList.toggle('table-collapsed', !open);
  const b = $('#btn-table-toggle'); b.textContent = open ? '▾ Hide list' : '▴ Show list'; b.setAttribute('aria-expanded', open);
  setTimeout(() => map && map.invalidateSize(), 60);
}
function setAllPanels(open) {
  for (const h of $$('#filter-groups .panel-h, #panel-weights .panel-h, #panel-special .panel-h')) h.setAttribute('aria-expanded', open);
  state.openGroups = open ? GROUPS.slice() : []; LS.set('openGroups2', state.openGroups);
  if (open) updateFilterWidgets();
}

// "Listings as of …" so viewers know how fresh the data is (red once it is more than a week old).
function showAsOf() {
  const d = META.listings_fetched || META.generated; if (!d) return;
  const day = new Date(d + 'T12:00:00');
  const ago = Math.round((Date.now() - day.getTime()) / 86400000);
  const when = day.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const rel = ago <= 0 ? 'today' : ago === 1 ? 'yesterday' : `${ago} days ago`;
  const el = $('#asof');
  el.textContent = `Listings as of ${when} (${rel})`;
  el.title = `For-sale listings were last checked on ${when}. Prices and status can change daily; confirm on the listing page.`;
  el.classList.toggle('stale', ago > 7);
}

// Phone "⋯" menu: everything that lives in the desktop top bar.
function moreMenu() {
  const theme = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  openDialog(`<h2>Options</h2><div class="more-list">
    <label for="m-preset" class="muted">Start from a preset</label>
    <select id="m-preset">${PRESETS.map(p => `<option value="${p.id}" ${p.id === state.preset ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}${PRESETS.some(p => p.id === state.preset) ? '' : '<option selected disabled>Custom</option>'}</select>
    ${OFFLINE ? '' : '<button class="btn" type="button" data-m="share">Share this search…</button>'}
    <button class="btn" type="button" data-m="saved">Saved searches</button>
    <button class="btn" type="button" data-m="csv">Export results (CSV)</button>
    <button class="btn" type="button" data-m="theme">${theme === 'dark' ? 'Light mode' : 'Dark mode'}</button>
    <button class="btn" type="button" data-m="help">About this data</button></div>`);
  $('#m-preset').onchange = e => { applyPreset(e.target.value); $('#dlg').close(); toast('Preset applied'); };
  $('#dlg-body').onclick = e => {
    const m = e.target.dataset.m; if (!m) return;
    if (m === 'share') { $('#dlg').close(); $('#btn-share').click(); }
    if (m === 'saved') savedDialog();
    if (m === 'csv') { $('#dlg').close(); doExport('csv'); }
    if (m === 'theme') { $('#btn-theme').click(); $('#dlg').close(); }
    if (m === 'help') helpDialog();
  };
}

let debT;
function debounced() { clearTimeout(debT); debT = setTimeout(() => recompute(), 120); }

function wire() {
  DOM.detail = $('#detail');
  $('#preset').innerHTML = PRESETS.map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join('') + '<option value="" disabled>Custom</option>';
  $('#preset').onchange = e => applyPreset(e.target.value);
  const cb = $('#color-by');
  const opts = [['score', 'Overall score'], ...CATEGORIES.map(c => ['s_' + c.key, c.label + ' score'])];
  cb.innerHTML = `<optgroup label="Scores">${opts.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</optgroup>` +
    GROUPS.map(g => `<optgroup label="${esc(g)}">${META.fields.filter(f => f.group === g && f.type !== 'text').map(f => `<option value="${f.key}">${esc(f.label)}</option>`).join('')}</optgroup>`).join('');
  cb.onchange = () => { state.colorBy = cb.value; renderLegend(); parcelLayer.redraw(); updateHash(); };

  $('#q').addEventListener('input', e => { state.q = e.target.value; debounced(); });
  $('#filter-find').addEventListener('input', e => {
    const t = e.target.value.toLowerCase();
    for (const panel of $$('#filter-groups .panel')) {
      let any = false;
      for (const el of $$('.flt', panel)) { const f = FIELD[el.dataset.key]; const ok = !t || f.label.toLowerCase().includes(t) || f.desc.toLowerCase().includes(t); el.hidden = !ok; any ||= ok; }
      panel.hidden = !any;
      if (t && any) panel.querySelector('.panel-h').setAttribute('aria-expanded', 'true');
    }
    if (t) updateFilterWidgets();
  });
  $('#btn-reset').onclick = () => { state.filters = {}; state.minScore = 0; state.q = ''; state.spatial.mode = 'none'; state.onlyStar = state.onlyListed = false; state.preset = 'none'; syncControls(); recompute(); toast('Filters cleared'); };
  $('#active-chips').addEventListener('click', e => {
    const k = e.target.dataset.k; if (!k) return;
    if (k === '__score') state.minScore = 0; else if (k === '__spatial') state.spatial.mode = 'none'; else delete state.filters[k];
    state.preset = 'custom'; syncControls(); recompute();
  });
  $('#spatial-mode').addEventListener('click', e => {
    const v = e.target.dataset.v; if (!v) return;
    state.spatial.mode = v;
    if (v === 'radius' && !state.spatial.center) { const c = map.getCenter(); state.spatial.center = [c.lat, c.lng]; }
    syncControls(); recompute();
  });
  $('#radius').addEventListener('input', e => { state.spatial.radius = +e.target.value; $('#radius-out').textContent = e.target.value; drawRadius(); debounced(); });
  $('#only-star').onchange = e => { state.onlyStar = e.target.checked; recompute(); };
  $('#show-hidden').onchange = e => { state.showHidden = e.target.checked; recompute(); };
  $('#btn-saved').onclick = savedDialog;
  $('#btn-help').onclick = helpDialog;
  if (OFFLINE) $('#btn-share').hidden = true;
  $('#btn-share').onclick = () => shareUrl(location.href.split('#')[0] + '#s=' + b64.enc(serialize()), 'East TN Land Finder search');
  $('#btn-export').onclick = e => { e.stopPropagation(); $('#export-menu').hidden = !$('#export-menu').hidden; };
  $('#export-menu').onclick = e => { const k = e.target.dataset.exp; if (k) { doExport(k); $('#export-menu').hidden = true; } };
  document.addEventListener('click', () => { $('#export-menu').hidden = true; });
  $('#btn-theme').onclick = () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next; LS.set('theme', next); renderLegend(); parcelLayer.redraw(); restyleVectors();
  };
  $('#btn-filters').onclick = () => setSidebar(!sidebarOpen());
  $('#tabbar').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const t = b.dataset.tab;
    if (t === 'filters') { setSidebar(true); return; }
    if (t === 'star') { state.onlyStar = true; syncControls(); recompute({ keepTable: true }); setView('list'); if (!user.stars.size) toast('Tap ☆ Save on a parcel to add it to your shortlist'); return; }
    if (state.onlyStar) { state.onlyStar = false; syncControls(); recompute({ keepTable: true }); }
    setView(t);
  });
  $('#cards').addEventListener('click', e => {
    const card = e.target.closest('.card'); const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'more') { tableLimit += 100; renderCards(); return; }
    if (!card || e.target.closest('a')) return;
    const i = +card.dataset.i;
    if (act === 'star') { toggleStar(i); return; }
    select(i);
  });
  $('#m-sort-by').onchange = e => {
    const [key, dir] = e.target.value.split(':');
    const go = () => { state.sort = { key, dir: +dir }; sortRows(); tableLimit = 150; renderTable(); $('.table-scroll').scrollTop = 0; };
    if (key === 'near' && !DIST) locateMe(go); else go();
  };
  $('#btn-more-menu').onclick = moreMenu;
  $('#btn-close-side').onclick = () => setSidebar(false);
  $('#backdrop').onclick = () => setSidebar(false);
  $('#btn-show').onclick = () => { setSidebar(false); if (state.tableCollapsed) setTable(true); };
  $('#btn-expand-all').onclick = () => setAllPanels(true);
  $('#btn-collapse-all').onclick = () => setAllPanels(false);
  $('#btn-table-toggle').onclick = () => setTable(state.tableCollapsed);
  $('#btn-legend').onclick = () => {
    const ctl = $('#map-ctl'), col = !ctl.classList.contains('collapsed');
    ctl.classList.toggle('collapsed', col); $('#btn-legend').textContent = col ? '+' : '–';
    $('#btn-legend').setAttribute('aria-expanded', !col); $('#btn-legend').title = col ? 'Show legend' : 'Hide legend';
  };
  $('#btn-cols').onclick = columnsDialog;
  $('#btn-compare').onclick = compareDialog;
  $('#btn-more').onclick = () => { tableLimit += 300; renderTable(); };
  $('#btn-table-size').onclick = () => {
    const sizes = ['36vh', '60vh', '14vh']; const cur = getComputedStyle(document.querySelector('.main')).getPropertyValue('--table-h').trim() || '36vh';
    document.querySelector('.main').style.setProperty('--table-h', sizes[(sizes.indexOf(cur) + 1) % sizes.length]);
    setTimeout(() => map.invalidateSize(), 50);
  };
  const thead = $('#results thead');
  thead.addEventListener('click', e => {
    const k = e.target.closest('th')?.dataset.k; if (!k) return;
    state.sort = state.sort.key === k ? { key: k, dir: -state.sort.dir } : { key: k, dir: FIELD[k]?.better === 'low' ? 1 : -1 };
    sortRows(); renderTable(); updateHash();
  });
  const tbody = $('#results tbody');
  tbody.addEventListener('mouseover', e => { const tr = e.target.closest('tr'); if (tr) hoverHighlight(+tr.dataset.i); });
  tbody.addEventListener('mouseleave', () => hoverHighlight(null));
  tbody.addEventListener('click', e => {
    if (e.target.closest('a')) return;
    if (e.target.dataset.star) { toggleStar(+e.target.dataset.star); return; }
    if (e.target.dataset.cmp) { const i = +e.target.dataset.cmp; e.target.checked ? compareSet.add(i) : compareSet.delete(i); renderTable(); return; }
    const tr = e.target.closest('tr'); if (tr) select(+tr.dataset.i);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isMobile() && sidebarOpen()) { setSidebar(false); return; }
    if (e.key === 'Escape' && !DOM.detail.hidden && !$('#dlg').open) closeDetail();
  });
}

async function main() {
  const theme = LS.get('theme', null); if (theme) document.documentElement.dataset.theme = theme;
  try { await load(); } catch (err) {
    $('#loading').innerHTML = `<p>Could not load data (${esc(err.message)}).<br>Serve this folder over HTTP, e.g. <code>python3 -m http.server</code> in <code>dashboard/</code>.</p>`;
    return;
  }
  buildWeights(); buildFilters(); wire(); initMap();
  showAsOf();
  if (isMobile() || LS.get('sideClosed', false)) setSidebar(false);
  if (LS.get('tableCollapsed', false)) setTable(false);
  let fromHash = false;
  if (!OFFLINE && location.hash.startsWith('#s=')) { try { deserialize(b64.dec(location.hash.slice(3))); fromHash = true; } catch { /* bad link */ } }
  let selFromLink = null;
  if (fromHash) { try { selFromLink = b64.dec(location.hash.slice(3)).sel; } catch { /* ignore */ } }
  if (fromHash) { syncControls(); recompute(); } else applyPreset('balanced');
  if (isMobile()) { setView('map'); $('#btn-legend').click(); }   // phones start with the legend folded away
  if (selFromLink) { const i = COLS.gislink.indexOf(selFromLink); if (i >= 0) setTimeout(() => select(i), 300); }
  $('#loading').remove();
}
main();
