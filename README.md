# East TN Land Finder

An open-source (OSINT) dashboard for finding land to build a retirement home in East Tennessee.
It covers **Loudon, Greenback, Lenoir City, Tellico Village, Vonore, Maryville, Alcoa, Louisville,
Friendsville, Walland and Townsend**, which is all of Blount and Loudon counties plus northern Monroe.

It screens **12,585 vacant parcels** (0.5–500 acres, no structures, public/utility/HOA land removed)
against about 90 measured criteria:

| Category | What's measured |
|---|---|
| **Terrain (LiDAR)** | Mean and 90th-percentile slope, buildable acres (≤15% slope, outside flood and wetlands), largest contiguous building pad, steep share, best house site, elevation, relief, hilltop/hollow position, aspect |
| **Mountain views** | Line-of-sight from 6 m above the house site to about 70 Great Smoky Mountains crest points and 110 foothill summits (earth curvature included), plus a 360° skyline chart per parcel |
| **Noise and nuisances** | Modeled road noise (dBA), distance to interstates, highways, rail, McGhee Tyson runways and approach corridor, big-box retail, industrial land, quarries, landfills, wastewater plants and ranges, transmission lines |
| **Access** | OSRM drive times to the nearest town, Maryville, Knoxville, Turkey Creek, TYS airport, Townsend/GSMNP and the nearest grocery; distance to pharmacy, golf, marina and lake |
| **Healthcare** | Drive time to the nearest 24/7 ER, to the Level I trauma center (UT Medical Center) and to comprehensive stroke centers; clinic density; nearest fire station |
| **Hazards** | Sinkhole risk (USGS LiDAR-mapped karst depressions plus carbonate soils), FEMA flood %, NWI wetlands %, steep/landslide share |
| **Soils and utilities** | SSURGO septic suitability and limitations, basement suitability, depth to bedrock, drainage; assessor water, sewer, electric and gas |
| **Value and ownership** | Appraised land value and $/acre, last sale, years held, greenbelt, absentee, out-of-state, estate and corporate owners, sold-since-snapshot, detected structures |

The full criteria list, with how each item is measured, its limits, and a pre-offer due-diligence
checklist, is in **[docs/CRITERIA.md](docs/CRITERIA.md)**.

## Using the dashboard

```bash
cd dashboard
python3 -m http.server 8000
# open http://localhost:8000
```

You can also enable **GitHub Pages** for this repository (branch root). `index.html` redirects to `dashboard/`.

Features:

* **Presets**: Balanced retirement, Smokies-view homesite, Quiet acreage, Close to hospitals, Easy build,
  Near the lake, Lowest sinkhole/flood risk, Off-market leads.
* **Every metric is a filter**:
  * Numeric fields get a dual-handle range slider, exact min/max boxes and a crossfilter histogram.
    Gray bars show the whole dataset; blue bars show what passes your *other* filters.
  * Categorical fields get checkboxes with live counts and "only", "invert" and search.
  * Yes/no fields get Any/Yes/No.
  * Text fields support "contains" with `-word` to exclude.
  * A "find a filter" box searches the filters themselves. Active filters appear as removable chips.
* **Weighted scoring**: seven sub-scores (buildability, view, quiet, access, healthcare, hazard safety,
  value) with adjustable weights and a minimum-score cutoff. Hover a sub-score in the detail panel to see its inputs.
* **Spatial filters**: limit to the current map view, or to a radius around a point you click.
* **Map layers**: LiDAR hillshade, LiDAR slope, 25 ft contours, FEMA flood zones, NWI wetlands,
  hospitals, towns, groceries and the mountain view targets, over USGS Topo, imagery, OSM or dark basemaps.
  You can color parcels by any metric.
* **Parcel detail**: score breakdown, warning badges, a skyline toward the Smokies, every metric with its
  percentile, and links to the county assessor (TPAD), TN parcel viewer, Google satellite and 3D,
  Zillow/Realtor/LandWatch, the FEMA flood map, the FCC broadband map and SoilWeb.
* **Your own lists** (saved in your browser): shortlist ★, hide, notes, mark as listed with asking price
  and URL, paste listing IDs or addresses to bulk-mark, compare parcels side by side,
  saved searches, shareable URL links, and CSV/GeoJSON export.

### Important limitations

* **Listing status is not scraped.** Zillow, Realtor.com and LandWatch prohibit it. The dashboard finds
  the *best land*. Use the listing links, or paste IDs/addresses from listings you find, to overlay
  "for sale" status. Parcels flagged absentee, estate or long-held are candidates for an off-market letter.
* Views use a bare-earth model, so trees are ignored. Noise is a screening model. Drive times are free-flow.
* Loudon and Monroe assessor attributes are a 2023 snapshot. Blount's are current. Parcels sold since
  the snapshot are flagged.
* The sinkhole and septic metrics are screening tools, not a geotechnical survey or perc test.

## Rebuilding the data

```bash
pip install -r pipeline/requirements.txt
./pipeline/run_all.sh        # ~20 min; downloads are cached in pipeline/cache/ (git-ignored)
```

| Step | Source |
|---|---|
| `s10_parcels.py` | Blount County GIS parcels/CAMA (current); TN Comptroller CAMA for Loudon and Monroe via the public statewide parcel map; *TN Property Boundaries* for current owners |
| `s20_overture.py` | Overture Maps (OpenStreetMap roads/POIs/land use; Microsoft/Google building footprints) |
| `s30_dem.py` | USGS 3DEP elevation service (Tennessee QL2 LiDAR bare-earth) |
| `s40_layers.py` | FEMA NFHL; USFWS NWI (via TN); TN city limits; USGS SIR 2024-5134 karst depressions; USDA SSURGO via Soil Data Access |
| `s50_terrain.py` | Slope, pads, aspect, line-of-sight and skyline computed from the DEMs |
| `s60_proximity.py` | Distances, noise model, overlays, soils and sinkhole composite |
| `s70_drivetimes.py` | OSRM public routing server (OpenStreetMap) |
| `s80_export.py` | Writes `dashboard/data/` |

To change the study area, minimum acreage, destinations or excluded owners, edit `pipeline/config.py`.
To change the scoring curves, edit `dashboard/js/scoring.js`.
