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
const ctxScore = {};

const user = { stars: new Set(LS.get('stars', [])), hidden: new Set(LS.get('hidden', [])), notes: LS.get('notes', {}), listed: LS.get('listed', {}) };
function saveUser() {
  LS.set('stars', [...user.stars]); LS.set('hidden', [...user.hidden]); LS.set('notes', user.notes); LS.set('listed', user.listed);
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
  columns: ['score', 'acres', 'nearest_town', 'city', 'view_smokies', 'slope_mean', 'pad_ac', 'noise_db', 'dt_ed_min',
    'dt_grocery_min', 'sinkhole_risk', 'flood_pct', 'land_val', 'land_val_per_ac', 'address'],
  openGroups: LS.get('openGroups', ['Terrain', 'Views']),
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
  SUB = ROWS.map(r => subscores(r, ctxScore));
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
  if (state.onlyListed) extra.push(i => !!user.listed[i]);
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

function buildFilters() {
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
      LS.set('openGroups', state.openGroups);
      if (open) updateFilterWidgets();
    }
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
  for (const panel of $$('#filter-groups .panel')) {
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
    total += n;
  }
  void total;
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
  $('#stats').innerHTML = [
    [nf0.format(n), `of ${nf0.format(N)} parcels`],
    [fmt('acres', median(take('acres'))), 'median size'],
    [fmt('land_val_per_ac', median(take('land_val_per_ac'))), 'median $/acre'],
    [fmt('dt_ed_min', median(take('dt_ed_min'))), 'median to ER'],
    [nf0.format(filtered.filter(i => (COLS.view_smokies[i] || 0) >= 15).length), 'with Smokies view'],
  ].map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join('');
}

function colLabel(k) { return k === 'score' ? 'Score' : (FIELD[k]?.label ?? k); }
function renderTable() {
  const cols = state.columns;
  const thead = $('#results thead'), tbody = $('#results tbody');
  thead.innerHTML = `<tr><th class="l" data-k="star">★</th>${cols.map(k => {
    const f = FIELD[k]; const left = f && f.type !== 'num' && f.type !== 'bool';
    return `<th class="${left ? 'l' : ''}${state.sort.key === k ? ' sorted' : ''}" data-k="${k}" title="${esc(f?.desc || '')}">${esc(colLabel(k))}${state.sort.key === k ? (state.sort.dir < 0 ? ' ↓' : ' ↑') : ''}</th>`;
  }).join('')}<th class="l">Cmp</th></tr>`;
  const rows = sortedRows.slice(0, tableLimit);
  tbody.innerHTML = rows.map(i => `<tr data-i="${i}" class="${i === selected ? 'is-sel' : ''}"><td><button class="star${user.stars.has(i) ? ' on' : ''}" data-star="${i}" aria-label="Shortlist">${user.stars.has(i) ? '★' : '☆'}</button></td>${cols.map(k => {
    if (k === 'score') { const s = SCORE[i]; return `<td><span class="scorecell"><i style="width:${Math.round(s * 0.4)}px"></i>${Math.round(s)}</span></td>`; }
    const f = FIELD[k]; const left = f && f.type !== 'num' && f.type !== 'bool';
    const v = k.startsWith('s_') ? SUB[i][k.slice(2)] : COLS[k][i];
    let txt = k.startsWith('s_') ? (v == null ? '—' : Math.round(v)) : fmt(k, v);
    if (k === 'sinkhole_risk' && v) txt = `<span class="badge ${v === 'Low' ? 'good' : v === 'Moderate' ? 'warn' : 'bad'}">${v}</span>`;
    else txt = esc(txt);
    return `<td class="${left ? 'l' : ''}">${txt}</td>`;
  }).join('')}<td><input type="checkbox" data-cmp="${i}" ${compareSet.has(i) ? 'checked' : ''} aria-label="Compare"></td></tr>`).join('');
  $('#table-sub').textContent = `${nf0.format(filtered.length)} matches · sorted by ${colLabel(state.sort.key)}`;
  $('#btn-more').hidden = sortedRows.length <= tableLimit;
  $('#btn-compare').textContent = `Compare (${compareSet.size})`;
  $('#btn-compare').disabled = compareSet.size < 2;
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
  map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([35.73, -84.08], 10);
  const topo = L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16, maxNativeZoom: 16, attribution: 'USGS The National Map' });
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

  const hosp = L.layerGroup(LAYERS.hospitals.map(h => L.marker([h.lat, h.lon], { icon: L.divIcon({ className: '', html: `<div style="background:#d03b3b;color:#fff;border-radius:4px;font-weight:700;width:18px;height:18px;display:grid;place-items:center;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4)">H</div>`, iconSize: [18, 18] }) })
    .bindTooltip(`${esc(h.name)}${h.tags.includes('trauma') ? ' — Level I trauma' : ''}`))).addTo(map);
  const towns = L.layerGroup(LAYERS.towns.map(t => L.circleMarker([t.lat, t.lon], { radius: 4, color: '#0b0b0b', weight: 1.5, fillColor: '#fff', fillOpacity: 1 })
    .bindTooltip(esc(t.name), { permanent: true, direction: 'right', className: 'town-label', offset: [6, 0] }))).addTo(map);
  const peaks = L.layerGroup(LAYERS.targets.map(t => L.circleMarker([t.lat, t.lon], { radius: 3, color: t.kind === 'crest' ? '#d03b3b' : '#c98500', weight: 1, fillOpacity: 0.8 })
    .bindTooltip(`${t.kind === 'crest' ? 'Smokies crest' : 'Foothill'} view target · ${Math.round(t.z * 3.2808)} ft`)));
  const groc = L.layerGroup(LAYERS.groceries.map(g => L.circleMarker([g.lat, g.lon], { radius: 3, color: '#1baf7a', weight: 1, fillOpacity: 0.9 }).bindTooltip(esc(g.name))));

  L.control.layers({ 'USGS Topo': topo, 'USGS Imagery + Topo': imgTopo, 'Esri Satellite': esriImg, 'OpenStreetMap': osm, 'Dark': dark },
    { 'LiDAR hillshade': hill, 'Slope (LiDAR)': slope, 'Contours (25 ft)': contours, 'FEMA flood zones': flood, 'NWI wetlands (z12+)': wet,
      'Hospitals': hosp, 'Towns': towns, 'Grocery stores': groc, 'Mountain view targets': peaks }, { position: 'topright', collapsed: true }).addTo(map);
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
    const i = parcelLayer.pick(e.containerPoint);
    if (i != null) select(i, false);
  });
  let hoverT;
  map.on('mousemove', e => {
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

async function loadGeom() {
  if (geomLoading) return;
  geomLoading = true;
  toast('Loading parcel outlines…');
  GEOM = await fetch('data/geom.json').then(r => r.json());
  parcelLayer.redraw();
}
async function loadHorizon() {
  if (HORIZON) return HORIZON;
  const buf = await fetch('data/horizon.bin').then(r => r.arrayBuffer());
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
  renderDetail(i);
  if (fly) map.flyTo([COLS.lat[i], COLS.lon[i]], Math.max(map.getZoom(), 15), { duration: 0.6 });
  parcelLayer.redraw();
  $$('#results tbody tr').forEach(tr => tr.classList.toggle('is-sel', +tr.dataset.i === i));
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
  const c = k => COLS[k][i];
  const flags = [];
  const badge = (txt, cls) => flags.push(`<span class="badge ${cls}">${esc(txt)}</span>`);
  if (c('view_smokies') >= 15) badge(`Smokies view ${Math.round(c('view_smokies'))}%`, 'good');
  if (c('sinkhole_risk') === 'High') badge('High sinkhole risk', 'bad'); else if (c('sinkhole_risk') === 'Low') badge('Low sinkhole risk', 'good');
  if (c('flood_pct') > 0) badge(`${Math.round(c('flood_pct'))}% in flood zone`, c('flood_pct') > 20 ? 'bad' : 'warn');
  if (c('under_approach')) badge('Under TYS flight path', 'bad');
  if (c('noise_db') >= 58) badge(`Noisy (~${Math.round(c('noise_db'))} dBA)`, 'warn');
  if (c('bldg_fp') > 0) badge(`${c('bldg_fp')} structure(s) detected`, 'warn');
  if (c('owner_changed')) badge('Sold since 2023 snapshot', 'warn');
  if (c('greenbelt')) badge('Greenbelt', 'warn');
  if (c('waterfront')) badge('Waterfront', 'good');
  if (c('estate_flag')) badge('Estate/heirs/trust owner', 'warn');
  if (c('out_of_state')) badge(`Owner in ${c('mail_state') || 'another state'}`, 'warn');
  if (user.listed[i]) badge('Marked as listed', 'good');

  const sub = SUB[i];
  const kvGroups = GROUPS.map(g => {
    const fs = META.fields.filter(f => f.group === g && !['address', 'owner', 'gislink'].includes(f.key));
    return `<div class="kv-group"><h3>${esc(g)}</h3><div class="kv">${fs.map(f => `<div title="${esc(f.desc)}">${esc(f.label)}</div><div>${esc(fmt(f.key, c(f.key)))}${f.type === 'num' && c(f.key) != null ? `<span class="pct">${pctRank(f.key, c(f.key))}</span>` : ''}</div>`).join('')}</div></div>`;
  }).join('');
  const listed = user.listed[i] || {};
  d.innerHTML = `<button class="icon-btn close" aria-label="Close">✕</button>
    <h2>${esc(c('address') || 'Vacant parcel')} · ${fmt('acres', c('acres'))}</h2>
    <div class="sub">${esc(c('nearest_town') || '')} area · ${esc(c('county'))} Co. · ${esc(c('city'))} · ID ${esc(c('gislink'))}<br>Owner: ${esc(c('owner') || '—')}${c('mail_city') ? ` (${esc(c('mail_city'))}, ${esc(c('mail_state'))})` : ''}</div>
    <div class="flags">${flags.join('')}</div>
    <div class="score-big"><b>${Math.round(SCORE[i])}</b><span class="muted">overall score · rank ${nf0.format(sortedByScoreRank(i))} of ${nf0.format(filtered.length)} matches</span></div>
    <div class="subscores">${CATEGORIES.map(cat => `<span title="${esc(explain(ROWS[i], ctxScore, cat.key).map(e => `${e.label}: ${e.v == null ? '—' : Math.round(e.v)}`).join('\n'))}">${cat.label}</span><div class="bar"><i style="width:${Math.round(sub[cat.key] ?? 0)}%"></i></div><output>${sub[cat.key] == null ? '—' : Math.round(sub[cat.key])}</output>`).join('')}</div>
    <div class="actions">
      <button class="btn small ${user.stars.has(i) ? 'on' : ''}" data-act="star">${user.stars.has(i) ? '★ Shortlisted' : '☆ Shortlist'}</button>
      <button class="btn small" data-act="hide">${user.hidden.has(i) ? 'Unhide' : 'Hide'}</button>
      <button class="btn small" data-act="cmp">${compareSet.has(i) ? 'Remove from compare' : 'Add to compare'}</button>
      <button class="btn small" data-act="zoom">Zoom to</button>
    </div>
    <div class="kv-group"><h3>Skyline from house site (6 m eye height, bare earth)</h3><div id="skyline"></div></div>
    <div class="kv-group"><h3>Research links</h3><div class="links">${links(i)}</div></div>
    <div class="kv-group"><h3>My notes &amp; listing info</h3>
      <div class="listing"><input placeholder="Asking price" data-l="price" value="${esc(listed.price || '')}"><input placeholder="Listing URL" data-l="url" value="${esc(listed.url || '')}"></div>
      <label class="check"><input type="checkbox" data-l="on" ${user.listed[i] ? 'checked' : ''}> Listed for sale</label>
      ${listed.url ? `<a href="${esc(listed.url)}" target="_blank" rel="noopener">Open listing ↗</a>` : ''}
      <textarea placeholder="Notes (saved in this browser)" data-note>${esc(user.notes[i] || '')}</textarea></div>
    ${kvGroups}
    <p class="muted" style="margin-top:14px">Data year: ${c('data_year') || '—'}. Values are screening estimates; verify on site and with the county.</p>`;
  d.querySelector('.close').onclick = () => { d.hidden = true; selected = null; parcelLayer.redraw(); };
  d.querySelector('.actions').onclick = e => {
    const a = e.target.dataset.act; if (!a) return;
    if (a === 'star') toggleStar(i);
    if (a === 'hide') { user.hidden.has(i) ? user.hidden.delete(i) : user.hidden.add(i); saveUser(); recompute({ keepTable: true }); }
    if (a === 'cmp') { compareSet.has(i) ? compareSet.delete(i) : compareSet.add(i); renderTable(); }
    if (a === 'zoom') map.flyTo([COLS.lat[i], COLS.lon[i]], 16);
    renderDetail(i);
  };
  d.querySelector('[data-note]').oninput = e => { user.notes[i] = e.target.value; if (!e.target.value) delete user.notes[i]; saveUser(); };
  d.querySelectorAll('[data-l]').forEach(inp => inp.onchange = () => {
    const cur = user.listed[i] || {};
    if (inp.dataset.l === 'on') { if (inp.checked) user.listed[i] = cur; else delete user.listed[i]; }
    else { cur[inp.dataset.l] = inp.value; user.listed[i] = cur; }
    saveUser(); renderDetail(i);
  });
  drawSkyline(i);
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
  $('#only-star').checked = state.onlyStar; $('#only-listed').checked = state.onlyListed; $('#show-hidden').checked = state.showHidden;
  $('#color-by').value = state.colorBy;
  $('#preset').value = PRESETS.some(p => p.id === state.preset) ? state.preset : '';
  if (map) drawRadius();
}
function serialize() {
  const f = {};
  for (const [k, s] of activeFilters()) f[k] = s;
  return { p: state.preset, f, w: state.weights, ms: state.minScore, q: state.q, sp: state.spatial, c: state.colorBy, os: state.onlyStar, ol: state.onlyListed, cols: state.columns, s: state.sort };
}
function deserialize(o) {
  state.preset = o.p ?? 'custom'; state.filters = o.f || {}; state.weights = { ...state.weights, ...(o.w || {}) };
  state.minScore = o.ms || 0; state.q = o.q || ''; state.spatial = { ...state.spatial, ...(o.sp || {}) };
  state.colorBy = o.c || 'score'; state.onlyStar = !!o.os; state.onlyListed = !!o.ol;
  if (Array.isArray(o.cols)) state.columns = o.cols.filter(k => k === 'score' || k.startsWith('s_') || FIELD[k]);
  if (o.s) state.sort = o.s;
}
const b64 = { enc: o => btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: s => JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))))) };
let hashT;
function updateHash() { clearTimeout(hashT); hashT = setTimeout(() => { try { history.replaceState(null, '', '#s=' + b64.enc(serialize())); } catch { /* ignore */ } }, 300); }

function savedDialog() {
  const saved = LS.get('saved', {});
  const names = Object.keys(saved);
  openDialog(`<h2>Saved searches</h2>
    <p class="hint">Saved in this browser. Use “Share link” to send a search to someone else.</p>
    <div style="display:flex;gap:6px;margin-bottom:10px"><input id="save-name" placeholder="Name this search" style="flex:1;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--page)"><button class="btn primary" type="button" id="save-go">Save current</button></div>
    ${names.length ? `<table class="cmp"><tbody>${names.map(n => `<tr><td>${esc(n)}</td><td><button class="btn small" type="button" data-load="${esc(n)}">Load</button> <button class="btn small" type="button" data-del="${esc(n)}">Delete</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No saved searches yet.</p>'}`);
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

function importDialog() {
  openDialog(`<h2>Mark parcels as listed for sale</h2>
    <p class="hint">Paste one per line: a parcel ID (e.g. <code>005 034 01200</code>), a GIS link, or a street address from a listing. Matches are marked “listed” (saved in this browser) so you can filter to them with every other criterion.</p>
    <textarea id="imp-text" placeholder="053 012 03400&#10;1234 Example Rd"></textarea>
    <div class="dlg-foot" style="justify-content:flex-start"><button class="btn primary" type="button" id="imp-go">Match &amp; mark</button><span id="imp-res" class="muted"></span></div>`);
  $('#imp-go').onclick = () => {
    const norm = s => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const byId = new Map(); const byAddr = new Map();
    for (let i = 0; i < N; i++) {
      byId.set(norm(COLS.gislink[i]), i);
      const a = norm(COLS.address[i]); if (a.length > 4) byAddr.set(a, i);
    }
    let hit = 0, miss = [];
    for (const line of $('#imp-text').value.split(/\n+/).map(s => s.trim()).filter(Boolean)) {
      const n = norm(line);
      let i = byId.get(n);
      if (i == null) for (const [k, v] of byId) if (k.endsWith(n) || n.endsWith(k)) { i = v; break; }
      if (i == null) {
        // addresses in CAMA are "ROAD NAME 123"; listings are "123 Road Name" – compare token sets
        const toks = line.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(t => t.length > 1 && !['RD', 'ROAD', 'DR', 'DRIVE', 'LN', 'LANE', 'TN', 'WAY', 'ST', 'PIKE', 'HWY'].includes(t));
        for (let j = 0; j < N && i == null; j++) {
          const a = (COLS.address[j] || '').toUpperCase();
          if (a && toks.length >= 2 && toks.every(t => a.includes(t))) i = j;
        }
      }
      if (i != null) { user.listed[i] = user.listed[i] || {}; hit++; } else miss.push(line);
    }
    saveUser();
    $('#imp-res').textContent = `Marked ${hit}. ${miss.length ? `Not matched (may be improved/not in candidate set): ${miss.slice(0, 5).join('; ')}${miss.length > 5 ? '…' : ''}` : ''}`;
    recompute({ keepTable: true });
  };
}

function helpDialog() {
  openDialog(`<div class="about"><h2>About this dashboard</h2>
    <p><b>${nf0.format(N)}</b> vacant candidate parcels (0.5–500 acres, no buildings on the assessor roll, public/utility/HOA land removed) in Blount, Loudon and northern Monroe counties. Data built ${META.generated}.</p>
    <ul>${META.sources.map(s => `<li>${esc(s)}</li>`).join('')}</ul>
    <h3>How to use it</h3>
    <ul><li>Start with a <b>preset</b>, then tune filters. Every metric is a filter; histograms show the whole dataset (gray) and what passes your <i>other</i> filters (blue).</li>
    <li>Adjust <b>scoring weights</b> to rank what remains. Hover a sub-score in the detail panel to see how it was computed.</li>
    <li>Click a parcel for its skyline toward the Smokies, research links (assessor, flood map, broadband, listings), notes and listing info.</li>
    <li>Shortlist (★), hide, compare, save searches, share links, and export CSV/GeoJSON.</li></ul>
    <h3>Important caveats</h3>
    <ul><li><b>For-sale status is not scraped.</b> Listing sites forbid it. Use the listing links or paste listing IDs/addresses (“Where &amp; my lists”) to mark parcels as listed.</li>
    <li>Views use a bare-earth LiDAR model: trees are ignored. Check canopy on imagery.</li>
    <li>Noise is a screening model by road class and distance, with no terrain shielding. Drive times are free-flow (add 10–25% at rush hour).</li>
    <li>Loudon/Monroe assessor attributes are a 2023 snapshot. “Sold since snapshot” flags changed owners. “Structures detected” uses building footprints.</li>
    <li>Sinkhole risk comes from USGS-mapped depressions plus soils. It is not a geotechnical survey. Septic ratings are SSURGO map-unit level, and a TDEC perc test is still required.</li></ul>
    <p>Full criteria list and due-diligence checklist: <code>docs/CRITERIA.md</code> in the repository.</p></div>`);
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function toCSV(ids) {
  const keys = ['score', ...CATEGORIES.map(c => 's_' + c.key), ...META.fields.map(f => f.key), 'lat', 'lon'];
  const q = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const head = [...keys, 'shortlisted', 'listed', 'asking_price', 'listing_url', 'notes'];
  const lines = ids.map(i => [...keys.map(k => (k === 'score' ? Math.round(SCORE[i]) : k.startsWith('s_') ? (SUB[i][k.slice(2)] == null ? '' : Math.round(SUB[i][k.slice(2)])) : COLS[k][i])),
    user.stars.has(i) ? 1 : 0, user.listed[i] ? 1 : 0, user.listed[i]?.price || '', user.listed[i]?.url || '', user.notes[i] || ''].map(q).join(','));
  return [head.join(','), ...lines].join('\n');
}
async function doExport(kind) {
  const ids = sortedRows;
  if (kind === 'csv') download('east-tn-parcels.csv', toCSV(ids), 'text/csv');
  if (kind === 'csv-star') download('east-tn-shortlist.csv', toCSV([...user.stars]), 'text/csv');
  if (kind === 'ids') { await navigator.clipboard.writeText(ids.map(i => COLS.gislink[i]).join('\n')); toast(`Copied ${ids.length} IDs`); }
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
  $('#btn-reset').onclick = () => { state.filters = {}; state.minScore = 0; state.q = ''; state.spatial.mode = 'none'; state.onlyStar = state.onlyListed = false; state.preset = 'none'; syncControls(); recompute(); };
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
  $('#only-listed').onchange = e => { state.onlyListed = e.target.checked; recompute(); };
  $('#show-hidden').onchange = e => { state.showHidden = e.target.checked; recompute(); };
  $('#btn-import').onclick = importDialog;
  $('#btn-saved').onclick = savedDialog;
  $('#btn-help').onclick = helpDialog;
  $('#btn-share').onclick = async () => {
    const url = location.href.split('#')[0] + '#s=' + b64.enc(serialize());
    try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { openDialog(`<h2>Share link</h2><textarea readonly>${esc(url)}</textarea>`); }
  };
  $('#btn-export').onclick = e => { e.stopPropagation(); $('#export-menu').hidden = !$('#export-menu').hidden; };
  $('#export-menu').onclick = e => { const k = e.target.dataset.exp; if (k) { doExport(k); $('#export-menu').hidden = true; } };
  document.addEventListener('click', () => { $('#export-menu').hidden = true; });
  $('#btn-theme').onclick = () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next; LS.set('theme', next); renderLegend(); parcelLayer.redraw();
  };
  $('#btn-filters').onclick = () => $('#sidebar').classList.toggle('open');
  $('#btn-close-side').onclick = () => $('#sidebar').classList.remove('open');
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
  tbody.addEventListener('click', e => {
    if (e.target.dataset.star) { toggleStar(+e.target.dataset.star); return; }
    if (e.target.dataset.cmp) { const i = +e.target.dataset.cmp; e.target.checked ? compareSet.add(i) : compareSet.delete(i); renderTable(); return; }
    const tr = e.target.closest('tr'); if (tr) select(+tr.dataset.i);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !DOM.detail.hidden && !$('#dlg').open) { DOM.detail.hidden = true; selected = null; parcelLayer.redraw(); }
  });
}

async function main() {
  const theme = LS.get('theme', null); if (theme) document.documentElement.dataset.theme = theme;
  try { await load(); } catch (err) {
    $('#loading').innerHTML = `<p>Could not load data (${esc(err.message)}).<br>Serve this folder over HTTP, e.g. <code>python3 -m http.server</code> in <code>dashboard/</code>.</p>`;
    return;
  }
  buildWeights(); buildFilters(); wire(); initMap();
  let fromHash = false;
  if (location.hash.startsWith('#s=')) { try { deserialize(b64.dec(location.hash.slice(3))); fromHash = true; } catch { /* bad link */ } }
  if (fromHash) { syncControls(); recompute(); } else applyPreset('balanced');
  $('#loading').remove();
}
main();
