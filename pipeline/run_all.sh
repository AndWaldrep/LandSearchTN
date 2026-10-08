#!/usr/bin/env bash
# Rebuild every dataset behind the dashboard. Steps cache their downloads in pipeline/cache/,
# so re-running is cheap; delete a cache file to refresh that source.
set -euo pipefail
cd "$(dirname "$0")"
python3 s05_listings.py     # current land-for-sale listings (LandSearch.com)
python3 s10_parcels.py      # vacant candidate parcels + ownership signals
python3 s20_overture.py     # roads, POIs, land use, water, building footprints
python3 s30_dem.py          # USGS 3DEP LiDAR DEMs (10 m study area, 30 m region)
python3 s40_layers.py       # FEMA flood, NWI wetlands, city limits, USGS sinkholes, SSURGO soils
python3 s50_terrain.py      # slope, buildable pad, aspect, Smokies line-of-sight, skyline
python3 s60_proximity.py    # noise, nuisances, water, soils, sinkholes, neighbors
python3 s70_drivetimes.py   # OSRM drive times to towns, ERs, trauma/stroke, grocery
python3 s80_export.py       # write dashboard/data/*
python3 s85_basemap.py      # self-contained relief/vector basemap (used by the artifact build)
