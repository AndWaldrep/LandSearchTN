# Land Search Criteria: Retirement Build Site, East Tennessee

Study area: **Blount, Loudon and northern Monroe counties**. That covers Maryville, Alcoa,
Louisville, Friendsville, Greenback, Loudon, Lenoir City, Vonore, Tellico Village, Townsend
and Walland, with Knoxville as the regional hub.

This is the full list of factors that matter when buying raw land to build a retirement home.
For each factor it says how the pipeline measures it (the dashboard field name is in
`code`), where the data comes from, and what it **cannot** tell you. Anything marked
**Manual** cannot be automated reliably from public data. Put those items on your
due-diligence checklist before you make an offer.

Legend: ✅ automated in the dashboard · 🟡 partially automated / proxy · ✋ manual check

---

## 1. Availability and ownership

| # | Factor | Why it matters | Measure / field | Source | Status |
|---|--------|----------------|-----------------|--------|--------|
| 1.1 | Vacant (no structures) | You are looking for land to build on | `vacant`: assessor building count = 0 **and** improvement value < $5k **and** no building footprint detected inside the parcel (`bldg_fp`) | County CAMA via TN Comptroller; Overture/Microsoft/Google building footprints | ✅ |
| 1.2 | Listed for sale | Only listed parcels are easy to buy | `listed`, `list_price`, `list_ppa`, `list_acres`, `days_listed`, `list_status` (active, coming-soon, pending), linked to the listing page. Each listing is matched to the parcel under its map point. You can also mark parcels as listed yourself | LandSearch.com county listings (its robots.txt allows crawling), refreshed each pipeline run | ✅ |
| 1.3 | Off-market acquisition likelihood | Absentee, estate and long-held owners can be approached directly | Computed by the pipeline but **not shown**: the dashboard lists only land that is for sale | CAMA owner and mailing fields | — |
| 1.4 | Ownership changed since snapshot | Loudon/Monroe CAMA is a 2023 snapshot. A newer owner means it sold recently, so it may be built on or not for sale | `owner_changed` (2023 CAMA owner vs. current statewide parcel owner) | TN Property Boundaries (public use) | ✅ |
| 1.5 | Excluded owners | Public, utility and common-area land is not buyable | Filtered out at build time: USA/TVA/NPS/State/County/City/utility boards/HOA common areas/churches/cemeteries | CAMA owner | ✅ |
| 1.6 | Size | Room for home, septic field, garden and privacy buffer | `acres` (GIS-calculated) | Parcel polygons | ✅ |
| 1.7 | Value / price proxy | Budget screening | `land_val` (appraised land), `land_val_per_ac`, `last_price`, `last_sale_year` | CAMA | 🟡 Appraisal ≠ asking price |
| 1.8 | Title, liens, back taxes, easements, mineral rights | Deal-breakers | Assessor and Register of Deeds links per parcel | Register of Deeds | ✋ |
| 1.9 | Deed restrictions / HOA / covenants | Can block modular homes, outbuildings, livestock, short-term rentals | `subdivision` name is shown; restrictions require reading the recorded plat/covenants | Register of Deeds | ✋ |

## 2. Terrain and buildability (LiDAR)

All terrain metrics come from the **USGS 3DEP** elevation service, built from
Tennessee's statewide QL2 LiDAR. For a site this size, a 10 m grid resampled from the
1 m LiDAR bare-earth model is accurate for slope.

| # | Factor | Why it matters | Measure / field | Status |
|---|--------|----------------|-----------------|--------|
| 2.1 | Average slope | Grading, foundation and driveway cost; aging-in-place walkability | `slope_mean` (%), `slope_p90` (%) | ✅ |
| 2.2 | Buildable area | You need a flat-enough pad (≤ 15% slope) for house, drive and septic field | `build_ac` (acres ≤ 15% slope, outside the flood zone), `build_pct` | ✅ |
| 2.3 | Largest contiguous building pad | A scattered flat area is less useful than one usable pad | `pad_ac` (largest connected ≤ 15% region) | ✅ |
| 2.4 | Very steep ground | > 25–30% slope means retaining walls, landslide exposure, and some counties restrict building on it | `steep_pct` (% of parcel > 30%) | ✅ |
| 2.5 | Aspect | South/southeast exposure means passive solar, rooftop solar, faster snow/ice melt on the driveway, and morning sun | `aspect` (dominant direction of buildable area) | ✅ |
| 2.6 | Elevation and relief | Higher sites tend to have better views and breezes; relief within the lot drives drainage and driveway grade | `elev_ft` (house site), `relief_ft` (max−min in parcel) | ✅ |
| 2.7 | Topographic position | Ridge/hilltop vs. hollow: views, cold-air pooling, fog, drainage | `tpi_m` (pad elevation minus mean within 500 m; + = hilltop, − = valley) | ✅ |
| 2.8 | Driveway feasibility | Long, steep drives are hard in ice and for emergency vehicles | `road_dist_ft` (house site to nearest road), `slope_mean` | 🟡 |
| 2.9 | Assessor topo/road codes | Cross-check | `topo_code`, `road_type` (paved/gravel/none) | ✅ |

## 3. Views (Great Smoky Mountains)

| # | Factor | Measure / field | Status |
|---|--------|-----------------|--------|
| 3.1 | Smokies crest visibility | `view_smokies` = % of ~60 sample points along the main Smokies crest (≥ 1,200 m: Thunderhead → Clingmans Dome → Mt. Le Conte → Mt. Guyot) that have clear line-of-sight from 6 m above the pad (2nd-floor eye level). Uses a bare-earth DEM with earth curvature and refraction | ✅ |
| 3.2 | Foothills / Chilhowee view | `view_foothills` = % of sample points on Chilhowee Mountain and the front ranges (700–1,200 m) that are visible | ✅ |
| 3.3 | Nearest visible high peak | `view_dist_mi` = distance to the nearest visible crest point (closer = bigger mountains in the frame) | ✅ |
| 3.4 | Tree canopy blocking | **Bare-earth models ignore trees.** Most "no view" lots stay that way, but a "view" lot may need selective clearing. Check canopy on imagery | ✋ |
| 3.5 | Lake / water view or frontage | `water_dist_ft` to Tellico, Fort Loudoun, Melton Hill and Little River; `waterfront` (≤ 60 m). TVA shoreline permits and the 820 ft contour on Tellico limit docks and building | 🟡 |

## 4. Noise and nuisances

| # | Factor | Measure / field | Status |
|---|--------|-----------------|--------|
| 4.1 | Road noise | `noise_db`: estimated daytime road noise at the pad. Line-source model by road class (interstate ≈ 78 dBA @15 m, trunk/US hwy 72, primary 68, secondary 63, tertiary 58), −3 dB per doubling of distance, energy-summed over nearby roads. Screening only, no terrain shielding | 🟡 |
| 4.2 | Distance to highways | `d_freeway_mi` (I-75, I-140, Pellissippi and other freeways), `d_major_mi` (US/state highways: US-129, 321, 411, SR-72, 73, 95…) | ✅ |
| 4.3 | Airport noise | McGhee Tyson (TYS) plus the 134th ARW KC-135s: `d_airport_mi`, `under_approach` (within 1 km of the runway centerline extended 12 km) | ✅ |
| 4.4 | Railroads | `d_rail_mi` (Norfolk Southern main through Loudon/Lenoir City; horns at crossings) | ✅ |
| 4.5 | Big retail / commercial | `d_bigbox_mi` (Walmart, Lowe's, Home Depot, Target, Costco and similar: lights, traffic, delivery noise) | ✅ |
| 4.6 | Industrial / quarries / landfills | `d_industrial_mi`, `d_quarry_mi` (blasting, dust, trucks), `d_landfill_mi` | ✅ |
| 4.7 | Power transmission lines | `d_powerline_mi` (aesthetics, hum, easement limits) | ✅ |
| 4.8 | Gun ranges, racetracks, poultry/hog barns, wastewater plants | `d_nuisance_mi` (wastewater plants, shooting ranges, raceways in OSM/Overture). Agricultural CAFOs are not mapped publicly | 🟡 |

## 5. Access, drive time and daily life

Drive times are computed with OSRM (OpenStreetMap road network, free-flow speeds; add
10–25% for Knoxville rush hour).

| # | Destination | Field | Status |
|---|-------------|-------|--------|
| 5.1 | Nearest town center | `dt_town_min`, `nearest_town` | ✅ |
| 5.2 | Maryville / Alcoa (county seat, shopping) | `dt_maryville_min` | ✅ |
| 5.3 | Knoxville downtown | `dt_knoxville_min` | ✅ |
| 5.4 | Turkey Creek / Farragut (major shopping) | `dt_turkeycreek_min` | ✅ |
| 5.5 | McGhee Tyson Airport (TYS) for flights to family | `dt_airport_min` | ✅ |
| 5.6 | Nearest full-service grocery | `dt_grocery_min` | ✅ |
| 5.7 | Nearest pharmacy | `d_pharmacy_mi` | ✅ |
| 5.8 | Road type to the parcel | `road_type` (paved/gravel/private, from the assessor) | 🟡 |

## 6. Healthcare

| # | Factor | Field | Status |
|---|--------|-------|--------|
| 6.1 | Nearest 24/7 emergency department | `dt_ed_min`, `nearest_ed` (Blount Memorial, Fort Loudoun Medical Center, Sweetwater, Parkwest, Turkey Creek, Fort Sanders, UT Medical Center, Methodist Oak Ridge, Roane Medical) | ✅ |
| 6.2 | Level I trauma center (UT Medical Center, Knoxville) | `dt_trauma_min` | ✅ |
| 6.3 | Comprehensive stroke / cardiac center | `dt_stroke_min` (UTMC, Fort Sanders Regional) | ✅ |
| 6.4 | Urgent care / primary care density | `n_clinics_10km` (urgent/primary care within 10 km) | 🟡 |
| 6.5 | EMS / fire station response and ISO rating (affects insurance) | `d_fire_mi` (nearest fire station) | 🟡 |

## 7. Natural hazards

| # | Hazard | Field | Source | Status |
|---|--------|-------|--------|--------|
| 7.1 | **Sinkholes / karst** | `sink_on_parcel` (mapped closed depression intersects parcel), `sink_dist_ft`, `sink_count_1km`, `karst_geology` (carbonate bedrock, e.g. Knox Group) and `sinkhole_risk` (Low/Moderate/High composite) | USGS SIR 2024-5134 depression dataset (LiDAR-derived, TN Base Mapping Program), SSURGO parent material | ✅ |
| 7.2 | Flood zone | `flood_pct` (% of parcel in FEMA SFHA 1%-annual-chance zone), `flood_zone` | FEMA NFHL | ✅ |
| 7.3 | Wetlands | `wetland_pct` (NWI), permits needed to fill | USFWS NWI via TN | ✅ |
| 7.4 | Landslide | `steep_pct`. Helene-type (2024) slope failures happen on steep colluvium, so check the USGS landslide inventory | Derived | 🟡 |
| 7.5 | Wildfire | Steep wooded slopes near the park (2016 Gatlinburg fire). Use `steep_pct`/`slope_mean` with the satellite basemap. Check the USFS Wildfire Risk to Communities map | — | ✋ |
| 7.6 | Radon | East TN carbonate valleys are high-radon. Plan a passive radon system in new construction | EPA zones (county level) | ✋ |
| 7.7 | Tornado / ice storm | Regional, not parcel-specific. Ice storms make steep driveways a hazard (see 2.8) | — | ✋ |
| 7.8 | Earthquake | East Tennessee Seismic Zone: moderate. Affects foundation design only | USGS | ✋ |

## 8. Soils, septic and utilities

| # | Factor | Field | Source | Status |
|---|--------|-------|--------|--------|
| 8.1 | Septic suitability | `septic_rating` (SSURGO "ENG – Septic Tank Absorption Fields": Not / Somewhat / Very limited, area-weighted dominant), `septic_limits` (depth to rock, slow perc, flooding…), `septic_ok_pct` (% of parcel Not/Somewhat limited) | USDA Soil Data Access | ✅ |
| 8.2 | Depth to bedrock | `rock_depth_cm` (shown in inches) | SSURGO | ✅ |
| 8.3 | Hydric soils / seasonal water table | `hydric_pct` | SSURGO | ✅ |
| 8.4 | Dwellings-with-basement suitability | `basement_rating` | SSURGO | ✅ |
| 8.5 | Public sewer | `sewer` (CAMA) | CAMA | 🟡 |
| 8.6 | Public water | `water` (CAMA) | CAMA | 🟡 |
| 8.7 | Electric / natural gas | `elec`, `gas` | CAMA | 🟡 |
| 8.8 | **Perc test / state septic permit** | Required by TDEC before building where there's no sewer. **A failed perc test can make a lot unbuildable** | TDEC Division of Water Resources | ✋ |
| 8.9 | Broadband / fiber | FCC map blocks automated access. Check broadbandmap.fcc.gov for the address | FCC | ✋ |
| 8.10 | Cell coverage | Hollows near the mountains can be dead zones | Carrier maps | ✋ |

## 9. Regulatory and taxes

| # | Factor | Field | Status |
|---|--------|-------|--------|
| 9.1 | Inside city limits (city property tax plus city services and codes) | `city` (blank = unincorporated) | ✅ |
| 9.2 | Zoning | `zoning` (CAMA code; e.g. Blount R-1/R-2/RAC, Loudon A-1/R-1) | 🟡 Codes, not full ordinance |
| 9.3 | Greenbelt (agricultural use) status | `greenbelt` (use value > 0). Rollback taxes are owed if it's removed by development | 🟡 |
| 9.4 | Annual property tax estimate | County rate × 25% assessment (×city rate if inside limits). Rates change yearly: verify with the trustee | ✋ |
| 9.5 | Building permits / driveway permit / TVA shoreline permit | — | ✋ |

## 10. Neighborhood and lifestyle

| # | Factor | Field | Status |
|---|--------|-------|--------|
| 10.1 | Proximity to Smokies entrances (Townsend / Look Rock) | `dt_townsend_min` | ✅ |
| 10.2 | Lakes, marinas, golf | `d_marina_mi`, `d_golf_mi`, `water_dist_ft` | ✅ |
| 10.3 | Neighbor density (privacy) | `bldgs_500m` (building footprints within 500 m) | ✅ |
| 10.4 | Growth pressure (subdivisions coming) | `corp_owner` (developer/LLC) tracts; `owner_changed` | 🟡 |
| 10.5 | Crime | County sheriff data is not geocoded publicly | ✋ |

---

## Composite scores (dashboard)

Every 0–100 sub-score is a transparent piecewise function of the fields above
(`dashboard/js/scoring.js`). You can change the weights in the dashboard.

* **Buildability**: buildable pad size, mean slope, steep %, flood %, wetland %, septic rating
* **View**: Smokies crest % (primary), foothills %, nearest visible distance, TPI
* **Quiet**: modeled road dB, airport/approach, rail, big-box, industrial, quarry, power line
* **Access**: drive time to town, grocery, Maryville, Knoxville, airport
* **Healthcare**: drive time to nearest ED, Level I trauma, stroke center
* **Hazard safety**: sinkhole composite, flood, landslide/steepness, wetlands
* **Value**: land value per acre vs. the area median, years held, absentee owner

## Pre-offer due-diligence checklist (manual)

1. Confirm the listing, asking price and days on market with the listing agent.
2. Order a **soil/perc evaluation** (TDEC) if there's no sewer. Make the offer contingent on a septic permit.
3. Boundary **survey** and title search: easements, right-of-way, landlocked access, mineral rights.
4. Read the recorded **plat and restrictive covenants** / HOA rules.
5. Walk the site: look for sinkhole depressions, drainage swales, springs, rock outcrops and tree canopy blocking the view.
6. For LiDAR-flagged depressions on or near the pad, consider a geotechnical/geophysical survey (ERT or GPR) before siting the foundation.
7. Check broadband (FCC map) and cell signal on site.
8. Get quotes for utilities (water tap, electric line extension, gas), driveway and grading.
9. Visit at rush hour and on a weekend night (noise, traffic, neighbors).
10. Drive the route to the nearest ED at night and in bad weather.
