// Starting points. Each sets scoring weights and hard filters; everything stays editable afterwards.
// Filter spec: numeric {min,max}; categorical {values:[...]}; boolean 'yes'|'no'.
const W = (o = {}) => ({ build: 8, view: 7, quiet: 6, access: 5, health: 7, hazard: 7, value: 4, ...o });

export const PRESETS = [
  {
    id: 'balanced', label: 'Balanced retirement (default)', weights: W(),
    filters: { flood_pct: { max: 50 }, dt_ed_min: { max: 30 } },
  },
  {
    id: 'view', label: 'Smokies-view homesite',
    weights: W({ view: 10, build: 7, hazard: 6, quiet: 5, health: 5, access: 3, value: 3 }),
    filters: { view_smokies: { min: 10 }, pad_ac: { min: 0.25 }, slope_mean: { max: 25 } },
  },
  {
    id: 'quiet', label: 'Quiet acreage & privacy',
    weights: W({ quiet: 10, build: 7, value: 6, view: 5, access: 3, health: 4 }),
    filters: { acres: { min: 3 }, noise_db: { max: 50 }, bldgs_500m: { max: 60 }, under_approach: 'no' },
  },
  {
    id: 'health', label: 'Close to hospitals & town',
    weights: W({ health: 10, access: 9, build: 6, view: 3, quiet: 4 }),
    filters: { dt_ed_min: { max: 15 }, dt_grocery_min: { max: 12 } },
  },
  {
    id: 'easy', label: 'Easy build: flat & low-risk',
    weights: W({ build: 10, hazard: 9, value: 5 }),
    filters: { slope_mean: { max: 12 }, pad_ac: { min: 0.25 }, flood_pct: { max: 0 }, sinkhole_risk: { values: ['Low', 'Moderate'] } },
  },
  {
    id: 'lake', label: 'Near the lake (Tellico / Fort Loudoun)',
    weights: W({ view: 6, access: 6 }),
    filters: { water_dist_ft: { max: 1500 }, flood_pct: { max: 30 } },
  },
  {
    id: 'safe', label: 'Lowest sinkhole & flood risk',
    weights: W({ hazard: 10, build: 8 }),
    filters: { sinkhole_risk: { values: ['Low'] }, flood_pct: { max: 0 }, wetland_pct: { max: 0 }, sink_on_parcel: { max: 0 } },
  },
  { id: 'none', label: 'No filters', weights: W(), filters: {} },
];
