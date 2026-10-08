/* global L */
// Fast canvas layer: draws thousands of parcels as dots (zoomed out) or polygons (zoomed in),
// with hit-testing for hover/click. Leaflet's vector layers are too slow to rebuild on every filter change.

export const ParcelCanvas = L.Layer.extend({
  initialize(opts) {
    this.opts = opts; // { lat, lon, getRows, getColor, getGeom, getSelected, getStars, polyZoom }
    this._xs = new Float32Array(0);
    this._ys = new Float32Array(0);
    this._rows = [];
    this._polys = [];
  },
  onAdd(map) {
    this._map = map;
    const c = (this._canvas = L.DomUtil.create('canvas', 'leaflet-zoom-hide parcel-canvas'));
    c.style.pointerEvents = 'none';
    map.getPane('overlayPane').appendChild(c);
    map.on('moveend zoomend resize viewreset', this._reset, this);
    this._reset();
  },
  onRemove(map) {
    this._canvas.remove();
    map.off('moveend zoomend resize viewreset', this._reset, this);
  },
  _reset() {
    const map = this._map;
    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;
    const c = this._canvas;
    L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));
    c.width = size.x * dpr;
    c.height = size.y * dpr;
    c.style.width = size.x + 'px';
    c.style.height = size.y + 'px';
    this.redraw();
  },
  redraw() {
    const map = this._map;
    if (!map) return;
    const c = this._canvas;
    const ctx = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const { lat, lon } = this.opts;
    const rows = this.opts.getRows();
    const size = map.getSize();
    const zoom = map.getZoom();
    const geom = zoom >= this.opts.polyZoom ? this.opts.getGeom() : null;
    const sel = this.opts.getSelected();
    const stars = this.opts.getStars();
    const n = rows.length;
    const xs = (this._xs = new Float32Array(n));
    const ys = (this._ys = new Float32Array(n));
    this._rows = rows;
    this._polys = [];
    const r = zoom <= 10 ? 2.5 : zoom <= 12 ? 3.5 : 5;
    const pad = 40;
    for (let k = 0; k < n; k++) {
      const i = rows[k];
      const p = map.latLngToContainerPoint([lat[i], lon[i]]);
      xs[k] = p.x; ys[k] = p.y;
    }
    const surface = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() || '#fff';
    if (geom) {
      ctx.lineWidth = 1.5;
      for (let k = 0; k < n; k++) {
        if (xs[k] < -pad * 8 || ys[k] < -pad * 8 || xs[k] > size.x + pad * 8 || ys[k] > size.y + pad * 8) continue;
        const i = rows[k];
        const rings = geom[i];
        if (!rings) continue;
        const col = this.opts.getColor(i);
        const scr = rings.map(ring => ring.map(([a, b]) => map.latLngToContainerPoint([a, b])));
        this._polys.push([k, scr]);
        ctx.beginPath();
        for (const ring of scr) {
          ring.forEach((p, j) => (j ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
          ctx.closePath();
        }
        ctx.globalAlpha = 0.38;
        ctx.fillStyle = col;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = col;
        ctx.stroke();
        if (stars.has(i)) { ctx.strokeStyle = '#c98500'; ctx.lineWidth = 3; ctx.stroke(); ctx.lineWidth = 1.5; }
      }
    } else {
      for (let k = 0; k < n; k++) {
        const x = xs[k], y = ys[k];
        if (x < -pad || y < -pad || x > size.x + pad || y > size.y + pad) continue;
        const i = rows[k];
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = this.opts.getColor(i);
        ctx.fill();
        if (r >= 3.5) { ctx.lineWidth = 1; ctx.strokeStyle = surface; ctx.stroke(); }
        if (stars.has(i)) { ctx.lineWidth = 2; ctx.strokeStyle = '#c98500'; ctx.beginPath(); ctx.arc(x, y, r + 2.5, 0, Math.PI * 2); ctx.stroke(); }
      }
    }
    if (sel != null) {
      const p = map.latLngToContainerPoint([lat[sel], lon[sel]]);
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#d03b3b';
      ctx.beginPath();
      ctx.arc(p.x, p.y, geom ? 9 : r + 6, 0, Math.PI * 2);
      ctx.stroke();
      if (geom && geom[sel]) {
        ctx.beginPath();
        for (const ring of geom[sel]) {
          ring.forEach(([a, b], j) => { const q = map.latLngToContainerPoint([a, b]); j ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
          ctx.closePath();
        }
        ctx.stroke();
      }
    }
  },
  pick(pt) {
    // polygons first (zoomed in), topmost = last drawn
    for (let j = this._polys.length - 1; j >= 0; j--) {
      const [k, rings] = this._polys[j];
      if (rings.some(ring => inside(pt, ring))) return this._rows[k];
    }
    let best = -1, bd = 81;
    for (let k = 0; k < this._rows.length; k++) {
      const dx = this._xs[k] - pt.x, dy = this._ys[k] - pt.y;
      const d = dx * dx + dy * dy;
      if (d <= bd) { bd = d; best = k; }
    }
    return best >= 0 ? this._rows[best] : null;
  },
});

function inside(p, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

// ArcGIS ImageServer/MapServer "export" rendered per web-mercator tile (for LiDAR slope/hillshade, FEMA flood).
export const ArcGISExportLayer = L.TileLayer.extend({
  initialize(base, params, options) {
    this._base = base;
    this._params = params;
    L.TileLayer.prototype.initialize.call(this, '', options);
  },
  getTileUrl(coords) {
    const ts = this.getTileSize();
    const nw = this._map.unproject(coords.scaleBy(ts), coords.z);
    const se = this._map.unproject(coords.scaleBy(ts).add(ts), coords.z);
    const a = L.CRS.EPSG3857.project(nw), b = L.CRS.EPSG3857.project(se);
    const q = new URLSearchParams({
      bbox: [a.x, b.y, b.x, a.y].map(v => v.toFixed(1)).join(','), bboxSR: 3857, imageSR: 3857,
      size: `${ts.x},${ts.y}`, f: 'image', transparent: 'true', ...this._params,
    });
    return `${this._base}?${q}`;
  },
});
