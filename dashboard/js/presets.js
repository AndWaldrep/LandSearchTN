// Starting points. Each sets scoring weights and hard filters; everything stays editable afterwards.
// Filter spec: numeric {min,max}; categorical {values:[...]}; boolean 'yes'|'no'.
const W = (o = {}) => ({ build: 8, view: 7, quiet: 6, access: 5, health: 7, hazard: 7, value: 4, ...o });

export const PRESETS = [
  {
    id: 'balanced', label: 'Balanced retirement (default)', weights: W(),
    filters: { bldg_fp: { max: 0 }, acres: { min: 1 }, pad_ac: { min: 0.25 }, flood_pct: { max: 50 }, dt_ed_min: { max: 30 } },
  },
  {
    id: 'view', label: 'Smokies-view homesite',
    weights: W({ view: 10, build: 7, hazard: 6, quiet: 5, health: 5, access: 3, value: 3 }),
    filters: { bldg_fp: { max: 0 }, view_smokies: { min: 15 }, pad_ac: { min: 0.5 }, slope_mean: { max: 25 } },
  },
  {
    id: 'quiet', label: 'Quiet acreage & privacy',
    weights: W({ quiet: 10, build: 7, value: 6, view: 5, access: 3, health: 4 }),
    filters: {
      bldg_fp: { max: 0 }, acres: { min: 5 }, noise_db: { max: 48 }, bldgs_500m: { max: 40 },
      under_approach: 'no', d_quarry_mi: { min: 1.5 },
    },
  },
  {
    id: 'health', label: 'Close to hospitals & town',
    weights: W({ health: 10, access: 9, build: 6, view: 3, quiet: 4 }),
    filters: { bldg_fp: { max: 0 }, acres: { min: 0.5, max: 10 }, dt_ed_min: { max: 15 }, dt_grocery_min: { max: 12 } },
  },
  {
    id: 'easy', label: 'Easy build: flat, low-risk, public water',
    weights: W({ build: 10, hazard: 9, value: 5 }),
    filters: {
      bldg_fp: { max: 0 }, slope_mean: { max: 10 }, pad_ac: { min: 0.5 }, flood_pct: { max: 0 },
      sinkhole_risk: { values: ['Low', 'Moderate'] }, water: { values: ['Public'] },
    },
  },
  {
    id: 'lake', label: 'Near the lake (Tellico / Fort Loudoun)',
    weights: W({ view: 6, access: 6 }),
    filters: { bldg_fp: { max: 0 }, water_dist_ft: { max: 1500 }, pad_ac: { min: 0.25 }, flood_pct: { max: 30 } },
  },
  {
    id: 'safe', label: 'Lowest sinkhole & flood risk',
    weights: W({ hazard: 10, build: 8 }),
    filters: {
      bldg_fp: { max: 0 }, sinkhole_risk: { values: ['Low'] }, flood_pct: { max: 0 }, wetland_pct: { max: 0 },
      karst_geology: 'no', sink_on_parcel: { max: 0 },
    },
  },
  {
    id: 'leads', label: 'Off-market leads (long-held, private owner)',
    weights: W({ value: 10, build: 6 }),
    filters: { bldg_fp: { max: 0 }, acres: { min: 2 }, years_held: { min: 15 }, corp_owner: 'no', owner_changed: 'no' },
  },
  { id: 'none', label: 'No filters (everything)', weights: W(), filters: {} },
];
