// Transparent, piecewise-linear sub-scores (0–100). Each category is a weighted average of its parts.
// Missing values are skipped (the remaining parts carry the category).

export const CATEGORIES = [
  { key: 'build', label: 'Buildability', w: 8 },
  { key: 'view', label: 'Mountain view', w: 7 },
  { key: 'quiet', label: 'Quiet & privacy', w: 6 },
  { key: 'access', label: 'Town access', w: 5 },
  { key: 'health', label: 'Healthcare', w: 7 },
  { key: 'hazard', label: 'Hazard safety', w: 7 },
  { key: 'value', label: 'Value', w: 4 },
];

// interpolate y for x over [[x0,y0],[x1,y1],...] (x ascending), clamped at the ends
export function pw(x, pts) {
  if (x == null || Number.isNaN(x)) return null;
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}

function avg(parts) {
  let s = 0, w = 0;
  for (const [v, wt] of parts) if (v != null) { s += v * wt; w += wt; }
  return w ? s / w : null;
}

// Each rule: [label, weight, fn(row) -> 0..100|null]. Exported so the UI can explain scores.
export const RULES = {
  build: [
    ['Largest pad size', 3, r => pw(r.pad_ac, [[0, 0], [0.25, 40], [0.5, 70], [1, 90], [2, 100]])],
    ['Mean slope', 2, r => pw(r.slope_mean, [[3, 100], [10, 90], [15, 70], [25, 30], [40, 0]])],
    ['Very steep share', 1, r => pw(r.steep_pct, [[0, 100], [20, 60], [50, 10], [100, 0]])],
    ['Flood zone share', 1.5, r => pw(r.flood_pct, [[0, 100], [10, 70], [50, 20], [100, 0]])],
    ['Septic soils / sewer', 1.5, r => (r.sewer === 'Public' ? 100 : pw(r.septic_ok_pct, [[0, 40], [30, 70], [60, 100]]))],
    ['Driveway length', 1, r => pw(r.road_dist_ft, [[0, 100], [300, 90], [800, 60], [1500, 30], [3000, 0]])],
  ],
  view: [
    ['Smokies crest visible', 3, r => pw(r.view_smokies, [[0, 0], [5, 35], [15, 65], [30, 90], [45, 100]])],
    ['Foothills visible', 1.5, r => pw(r.view_foothills, [[0, 0], [10, 50], [25, 90], [35, 100]])],
    ['Nearest visible peak', 1, r => (r.view_dist_mi == null ? 0 : pw(r.view_dist_mi, [[3, 100], [10, 80], [20, 55], [40, 20]]))],
    ['Hilltop position', 1, r => pw(r.tpi_m, [[-20, 0], [0, 40], [10, 70], [30, 100]])],
  ],
  quiet: [
    ['Road noise', 3, r => pw(r.noise_db, [[40, 100], [45, 90], [50, 70], [55, 45], [60, 20], [65, 0]])],
    ['Airport', 1.5, r => {
      const s = pw(r.d_airport_mi, [[1, 0], [3, 50], [6, 90], [10, 100]]);
      return r.under_approach ? Math.min(s ?? 30, 30) : s;
    }],
    ['Railroad', 1, r => pw(r.d_rail_mi, [[0.1, 0], [0.5, 50], [1, 85], [2, 100]])],
    ['Big-box retail', 0.7, r => pw(r.d_bigbox_mi, [[0.2, 20], [0.5, 60], [1, 90], [2, 100]])],
    ['Industrial', 0.8, r => pw(r.d_industrial_mi, [[0.1, 10], [0.5, 60], [1, 90], [2, 100]])],
    ['Quarry', 1, r => pw(r.d_quarry_mi, [[0.5, 0], [1, 50], [2, 85], [3, 100]])],
    ['Transmission line', 0.5, r => pw(r.d_powerline_mi, [[0.05, 20], [0.2, 70], [0.5, 100]])],
    ['Neighbor density', 1, r => pw(r.bldgs_500m, [[0, 100], [20, 85], [60, 60], [150, 30], [300, 10]])],
  ],
  access: [
    ['Nearest town', 1, r => pw(r.dt_town_min, [[5, 100], [10, 85], [15, 65], [25, 30], [40, 0]])],
    ['Grocery', 1.5, r => pw(r.dt_grocery_min, [[5, 100], [10, 85], [15, 60], [25, 25], [40, 0]])],
    ['Maryville', 0.7, r => pw(r.dt_maryville_min, [[10, 100], [20, 80], [30, 50], [45, 15]])],
    ['Knoxville', 0.7, r => pw(r.dt_knoxville_min, [[20, 100], [30, 80], [45, 45], [60, 10]])],
    ['Airport (TYS)', 0.6, r => pw(r.dt_airport_min, [[15, 100], [25, 80], [40, 40], [60, 0]])],
  ],
  health: [
    ['Nearest ER', 3, r => pw(r.dt_ed_min, [[8, 100], [15, 85], [20, 65], [30, 30], [45, 0]])],
    ['Level I trauma', 1.5, r => pw(r.dt_trauma_min, [[20, 100], [30, 80], [45, 45], [60, 15]])],
    ['Stroke center', 1, r => pw(r.dt_stroke_min, [[20, 100], [30, 80], [45, 45], [60, 15]])],
    ['Fire station', 0.7, r => pw(r.d_fire_mi, [[1, 100], [3, 80], [5, 50], [8, 20]])],
  ],
  hazard: [
    ['Sinkhole composite', 2.5, r => ({ Low: 100, Moderate: 60, High: 15 }[r.sinkhole_risk] ?? null)],
    ['Depressions on parcel', 1, r => pw(r.sink_on_parcel, [[0, 100], [1, 60], [3, 30]])],
    ['Flood zone', 1.5, r => pw(r.flood_pct, [[0, 100], [5, 80], [25, 40], [60, 0]])],
    ['Steep / landslide', 0.7, r => pw(r.steep_pct, [[0, 100], [15, 70], [40, 20]])],
    ['Wetlands', 0.7, r => pw(r.wetland_pct, [[0, 100], [5, 70], [30, 10]])],
  ],
  value: [
    // listed parcels are judged on asking price; others on the county's land appraisal
    ['$/acre vs. area median', 2, (r, ctx) => {
      if (r.list_ppa != null && ctx.medListPpa) return pw(r.list_ppa / ctx.medListPpa, [[0.3, 100], [0.7, 80], [1, 60], [1.5, 35], [3, 0]]);
      return r.land_val_per_ac == null || !ctx.medPerAc ? null : pw(r.land_val_per_ac / ctx.medPerAc, [[0.3, 100], [0.7, 80], [1, 60], [1.5, 35], [3, 0]]);
    }],
    ['Total price', 1, r => pw(r.list_price ?? r.land_val, [[30000, 100], [75000, 80], [150000, 55], [300000, 25], [600000, 0]])],
    ['Asking vs. appraisal', 1, r => (r.list_price == null || !r.land_val ? null : pw(r.list_price / r.land_val, [[0.8, 100], [1.2, 80], [2, 50], [4, 15]]))],
    ['Long-held', 0.5, r => pw(r.years_held, [[0, 30], [10, 60], [25, 90]])],
    ['Absentee / estate owner', 0.5, r => (r.absentee || r.estate_flag ? 100 : 40)],
  ],
};

export function subscores(row, ctx) {
  const out = {};
  for (const c of CATEGORIES) out[c.key] = avg(RULES[c.key].map(([, w, f]) => [f(row, ctx), w]));
  return out;
}

export function explain(row, ctx, key) {
  return RULES[key].map(([label, w, f]) => ({ label, w, v: f(row, ctx) }));
}

export function total(sub, weights) {
  let s = 0, w = 0;
  for (const c of CATEGORIES) {
    const wt = weights[c.key] ?? 0;
    if (wt > 0 && sub[c.key] != null) { s += sub[c.key] * wt; w += wt; }
  }
  return w ? s / w : 0;
}
