"""Join all metrics and export compact files for the static dashboard.

dashboard/data/parcels.json  – columnar attributes + field metadata
dashboard/data/geom.json     – simplified parcel polygons (lazy-loaded)
dashboard/data/horizon.bin   – int16 skyline angles (0.1°) per parcel, 72 azimuths (lazy-loaded)
dashboard/data/layers.json   – context layers (hospitals, towns, view targets, groceries)
"""
import json
from datetime import date

import geopandas as gpd
import numpy as np
import pandas as pd
from pyproj import Transformer

from config import CACHE, CRS_M, HOSPITALS, KEY_DESTS, OUT, TOWNS

M2MI = 1 / 1609.344
M2FT = 3.28084

# key, label, group, type, unit, better ('low'|'high'|None), description
FIELDS = [
    ("county", "County", "Parcel", "cat", "", None, "County the parcel is in"),
    ("city", "City limits", "Parcel", "cat", "", None, "Municipality if inside city limits (city tax + codes apply)"),
    ("nearest_town", "Nearest town (drive)", "Parcel", "cat", "", None, "Closest town center by drive time"),
    ("acres", "Acres", "Parcel", "num", "ac", None, "GIS-calculated parcel area"),
    ("zoning", "Zoning", "Parcel", "cat", "", None, "Assessor zoning code (verify with planning dept.)"),
    ("prop_class", "Property class", "Parcel", "cat", "", None, "Assessor property class"),
    ("address", "Address", "Parcel", "text", "", None, "Situs address (often blank/approx. for vacant land)"),
    ("owner", "Owner", "Parcel", "text", "", None, "Owner of record"),
    ("subdivision", "Subdivision", "Parcel", "text", "", None, "Platted subdivision – check covenants/HOA"),
    ("gislink", "Parcel ID", "Parcel", "text", "", None, "State GIS link ID"),

    ("land_val", "Appraised land value", "Value", "num", "$", "low", "County appraisal of land (not asking price)"),
    ("land_val_per_ac", "Land value / acre", "Value", "num", "$", "low", "Appraised land value per acre"),
    ("last_price", "Last sale price", "Value", "num", "$", None, "Last recorded sale price ($0 = non-market transfer)"),
    ("last_sale_year", "Last sale year", "Value", "num", "", None, "Year of last recorded transfer"),
    ("years_held", "Years held", "Value", "num", "yr", "high", "Years since last transfer (long-held owners may sell)"),
    ("greenbelt", "Greenbelt", "Value", "bool", "", None, "Enrolled in greenbelt (ag/forest use value) – rollback taxes on development"),

    ("absentee", "Absentee owner", "Ownership", "bool", "", None, "Mailing address outside the county's towns"),
    ("out_of_state", "Out-of-state owner", "Ownership", "bool", "", None, "Mailing address outside Tennessee"),
    ("estate_flag", "Estate / heirs / trust", "Ownership", "bool", "", None, "Owner name contains ESTATE, HEIRS, ETAL or TRUST"),
    ("corp_owner", "Company / developer owner", "Ownership", "bool", "", None, "LLC, INC, developer, builder or investor owner"),
    ("owner_changed", "Sold since snapshot", "Ownership", "bool", "", None, "Owner differs between 2023 CAMA and current statewide roll (Loudon/Monroe)"),
    ("bldg_fp", "Structures detected", "Ownership", "num", "", "low", "Building footprints (Overture/MS/Google) inside parcel – may be built since assessment"),

    ("slope_mean", "Mean slope", "Terrain", "num", "%", "low", "Average slope from 3DEP LiDAR DEM (10 m)"),
    ("slope_p90", "90th pct slope", "Terrain", "num", "%", "low", "Steepest 10% of the parcel"),
    ("steep_pct", "Very steep area", "Terrain", "num", "%", "low", "Share of parcel steeper than 30%"),
    ("build_ac", "Buildable acres", "Terrain", "num", "ac", "high", "Area ≤15% slope, outside flood zone & wetlands"),
    ("build_pct", "Buildable share", "Terrain", "num", "%", "high", "Buildable acres / parcel acres"),
    ("pad_ac", "Largest building pad", "Terrain", "num", "ac", "high", "Largest contiguous ≤15% slope area"),
    ("pad_slope", "House-site slope", "Terrain", "num", "%", "low", "Slope at the chosen house site"),
    ("elev_ft", "House-site elevation", "Terrain", "num", "ft", None, "Elevation at the chosen house site"),
    ("relief_ft", "Relief within parcel", "Terrain", "num", "ft", None, "Max − min elevation on the parcel"),
    ("tpi_m", "Topographic position", "Terrain", "num", "m", "high", "House site minus mean elevation within 500 m (+ hilltop, − hollow)"),
    ("aspect", "Aspect", "Terrain", "cat", "", None, "Dominant facing direction of buildable ground"),
    ("topo_code", "Assessor topography", "Terrain", "cat", "", None, "Assessor topo code"),
    ("road_type", "Road frontage type", "Terrain", "cat", "", None, "Assessor road type (paved, gravel, private…)"),
    ("road_dist_ft", "Driveway length (est.)", "Terrain", "num", "ft", "low", "House site to nearest road"),

    ("view_smokies", "Smokies crest visible", "Views", "num", "%", "high", "Share of Smokies crest points (≥1,200 m) with line-of-sight from 6 m above the house site (bare earth – trees ignored)"),
    ("view_foothills", "Foothills visible", "Views", "num", "%", "high", "Share of Chilhowee/foothill summits (650–1,200 m) visible"),
    ("view_n_peaks", "Peaks visible", "Views", "num", "", "high", "Number of mountain sample points visible"),
    ("view_dist_mi", "Nearest visible peak", "Views", "num", "mi", "low", "Distance to the closest visible mountain point"),

    ("noise_db", "Road noise (est.)", "Noise", "num", "dBA", "low", "Modeled daytime road noise at the house site (screening model)"),
    ("d_freeway_mi", "To interstate/freeway", "Noise", "num", "mi", "high", "Distance to I-75 / I-140 / Pellissippi / freeway"),
    ("d_major_mi", "To US/state highway", "Noise", "num", "mi", "high", "Distance to trunk/primary highways"),
    ("d_rail_mi", "To railroad", "Noise", "num", "mi", "high", "Distance to active rail line"),
    ("d_airport_mi", "To TYS runway", "Noise", "num", "mi", "high", "Distance to McGhee Tyson runways (incl. Air National Guard jets)"),
    ("under_approach", "Under TYS approach", "Noise", "bool", "", None, "Within the runway approach/departure corridor (12 km)"),
    ("d_bigbox_mi", "To big-box retail", "Noise", "num", "mi", "high", "Distance to Walmart/Lowe's/Home Depot/large retail"),
    ("d_industrial_mi", "To industrial site", "Noise", "num", "mi", "high", "Distance to industrial land (>2 ha)"),
    ("d_quarry_mi", "To quarry", "Noise", "num", "mi", "high", "Distance to quarry (blasting, trucks, dust)"),
    ("d_landfill_mi", "To landfill", "Noise", "num", "mi", "high", "Distance to landfill"),
    ("d_nuisance_mi", "To other nuisance", "Noise", "num", "mi", "high", "Wastewater plant, raceway, shooting range"),
    ("d_powerline_mi", "To transmission line", "Noise", "num", "mi", "high", "Distance to high-voltage power line"),

    ("dt_town_min", "Drive to nearest town", "Access", "num", "min", "low", "Free-flow drive time to nearest town center"),
    ("dt_maryville_min", "Drive to Maryville", "Access", "num", "min", "low", "Downtown Maryville"),
    ("dt_knoxville_min", "Drive to Knoxville", "Access", "num", "min", "low", "Downtown Knoxville"),
    ("dt_turkeycreek_min", "Drive to Turkey Creek", "Access", "num", "min", "low", "Turkey Creek / Farragut shopping"),
    ("dt_airport_min", "Drive to TYS airport", "Access", "num", "min", "low", "McGhee Tyson Airport"),
    ("dt_townsend_min", "Drive to Townsend/GSMNP", "Access", "num", "min", "low", "Townsend entrance to the Smokies"),
    ("dt_grocery_min", "Drive to grocery", "Access", "num", "min", "low", "Nearest full-service grocery"),
    ("d_pharmacy_mi", "To pharmacy", "Access", "num", "mi", "low", "Straight-line distance"),
    ("d_golf_mi", "To golf course", "Access", "num", "mi", "low", "Straight-line distance"),
    ("d_marina_mi", "To marina", "Access", "num", "mi", "low", "Straight-line distance"),
    ("water_dist_ft", "To lake/river", "Access", "num", "ft", "low", "Parcel edge to lake/reservoir/river"),
    ("waterfront", "Waterfront", "Access", "bool", "", None, "Parcel within 30 m of a lake or river"),

    ("dt_ed_min", "Drive to ER", "Healthcare", "num", "min", "low", "Nearest 24/7 hospital emergency department"),
    ("nearest_ed", "Nearest ER", "Healthcare", "cat", "", None, "Hospital with the shortest drive"),
    ("dt_trauma_min", "Drive to Level I trauma", "Healthcare", "num", "min", "low", "UT Medical Center, Knoxville"),
    ("dt_stroke_min", "Drive to stroke center", "Healthcare", "num", "min", "low", "UTMC / Fort Sanders comprehensive stroke centers"),
    ("n_clinics_10km", "Clinics within 6 mi", "Healthcare", "num", "", "high", "Urgent care / primary care locations within 10 km"),
    ("d_fire_mi", "To fire station", "Healthcare", "num", "mi", "low", "Nearest fire station (response time, ISO rating)"),

    ("sinkhole_risk", "Sinkhole risk", "Hazards", "cat", "", None, "Composite of mapped LiDAR depressions + carbonate soils"),
    ("sink_on_parcel", "Depressions on parcel", "Hazards", "num", "", "low", "USGS-mapped closed depressions intersecting the parcel"),
    ("sink_dist_ft", "To nearest depression", "Hazards", "num", "ft", "high", "House site to nearest mapped depression"),
    ("sink_count_1km", "Depressions within 0.6 mi", "Hazards", "num", "", "low", "Mapped depressions within 1 km of house site"),
    ("sink_max_depth_ft", "Deepest depression on parcel", "Hazards", "num", "ft", "low", ""),
    ("karst_geology", "Carbonate (karst) soils", "Hazards", "bool", "", None, "Soil parent material is limestone/dolomite residuum"),
    ("flood_pct", "In FEMA flood zone", "Hazards", "num", "%", "low", "Share of parcel in the 1% annual-chance floodplain"),
    ("wetland_pct", "Wetlands", "Hazards", "num", "%", "low", "Share of parcel mapped as NWI palustrine wetland"),

    ("septic_rating", "Septic suitability (site)", "Soils & Utilities", "cat", "", None, "SSURGO septic absorption rating at house site"),
    ("septic_ok_pct", "Septic-suitable soils", "Soils & Utilities", "num", "%", "high", "Share of parcel rated Not/Somewhat limited for septic"),
    ("septic_limits", "Septic limitations", "Soils & Utilities", "text", "", None, "Main soil limitations for a drain field"),
    ("basement_rating", "Basement suitability", "Soils & Utilities", "cat", "", None, "SSURGO dwellings-with-basements rating"),
    ("rock_depth_cm", "Depth to bedrock", "Soils & Utilities", "num", "in", "high", "Minimum depth to bedrock (blank = >80 in)"),
    ("hydric_pct", "Hydric soils", "Soils & Utilities", "num", "%", "low", "Area-weighted hydric soil share (wet ground)"),
    ("drainage", "Soil drainage", "Soils & Utilities", "cat", "", None, ""),
    ("soil_name", "Soil map unit", "Soils & Utilities", "text", "", None, ""),
    ("water", "Water", "Soils & Utilities", "cat", "", None, "Assessor water source"),
    ("sewer", "Sewer", "Soils & Utilities", "cat", "", None, "Assessor sewer (Individual = septic)"),
    ("elec", "Electric", "Soils & Utilities", "cat", "", None, ""),
    ("gas", "Natural gas", "Soils & Utilities", "cat", "", None, ""),

    ("bldgs_500m", "Buildings within 1/3 mi", "Neighborhood", "num", "", None, "Building footprints within 500 m (privacy / density)"),
    ("d_celltower_mi", "To cell tower", "Neighborhood", "num", "mi", "low", "Nearest mapped cell/communication tower"),
]

CLASS = {"00": "Residential", "10": "Farm", "11": "Agricultural", "12": "Forest"}


def main():
    p = gpd.read_parquet(CACHE / "parcels.parquet")
    t = pd.read_parquet(CACHE / "terrain.parquet")
    x = pd.read_parquet(CACHE / "proximity.parquet")
    d = pd.read_parquet(CACHE / "drivetimes.parquet")
    df = p.merge(t, on="pid").merge(x, on="pid").merge(d, on="pid")
    df = df.sort_values("pid").reset_index(drop=True)

    # unit conversions
    for c in [c for c in df.columns if c.startswith("d_") and c.endswith("_m")]:
        df[c[:-2] + "_mi"] = (df[c] * M2MI).round(2)
    df["road_dist_ft"] = (df["road_dist_m"] * M2FT).round(0)
    df["water_dist_ft"] = (df["water_dist_m"] * M2FT).round(0)
    df["sink_dist_ft"] = (df["sink_dist_m"] * M2FT).round(0)
    df["view_dist_mi"] = (df["view_dist_km"] * 1000 * M2MI).round(1)
    df["rock_depth_cm"] = (df["rock_depth_cm"] / 2.54).round(0)
    df["prop_class"] = df["class_code"].map(CLASS).fillna("Other")
    df["city"] = df["city"].replace("", "Unincorporated")
    for c in ["zoning", "water", "sewer", "elec", "gas", "topo_code", "road_type", "drainage"]:
        df[c] = df[c].fillna("").astype(str).str.strip().str.rstrip("%").replace("", "Unknown")

    # Sinkhole composite (tuned so 'High' means a mapped depression at/near the house site or dense karst)
    high = (df["sink_dist_m"] <= 60) | ((df["sink_on_parcel"] > 0) & df["karst_geology"] & (df["sink_max_depth_ft"] >= 3)) \
        | (df["sink_count_1km"] >= 25)
    mod = (df["sink_on_parcel"] > 0) | (df["sink_count_1km"] >= 8) | df["karst_geology"] | (df["sink_dist_m"] <= 200)
    df["sinkhole_risk"] = np.where(high, "High", np.where(mod, "Moderate", "Low"))
    print("sinkhole risk", df["sinkhole_risk"].value_counts().to_dict())

    tr = Transformer.from_crs(CRS_M, 4326, always_xy=True)
    lon, lat = tr.transform(df["pad_x"].values, df["pad_y"].values)

    cols = {}
    for key, label, group, typ, unit, better, desc in FIELDS:
        s = df[key]
        if typ == "num":
            v = pd.to_numeric(s, errors="coerce")
            cols[key] = [None if pd.isna(a) else (int(a) if float(a).is_integer() else round(float(a), 2)) for a in v]
        elif typ == "bool":
            cols[key] = [1 if bool(a) else 0 for a in s.fillna(False)]
        else:
            cols[key] = [None if (a is None or (isinstance(a, float) and np.isnan(a))) else str(a).strip() for a in s]
    cols["lat"] = [round(float(a), 5) for a in lat]
    cols["lon"] = [round(float(a), 5) for a in lon]
    cols["mail_city"] = df["mail_city"].fillna("").astype(str).str.strip().tolist()
    cols["mail_state"] = df["mail_state"].fillna("").astype(str).str.strip().tolist()
    cols["data_year"] = [int(a) if pd.notna(a) else None for a in df["data_year"]]

    meta = {
        "generated": date.today().isoformat(),
        "count": len(df),
        "fields": [dict(key=k, label=l, group=g, type=t_, unit=u, better=b, desc=de)
                   for k, l, g, t_, u, b, de in FIELDS],
        "sources": [
            "Parcels: Blount County GIS (current CAMA); TN Comptroller CAMA 2023 for Loudon & Monroe via HNTB statewide parcel map; TN Property Boundaries (current owners)",
            "Elevation: USGS 3DEP (Tennessee QL2 LiDAR) bare-earth DEM, 10 m & 30 m",
            "Roads, POIs, land use, buildings: Overture Maps Foundation (OpenStreetMap, Microsoft, Google, Meta)",
            "Drive times: OSRM (OpenStreetMap road network, free-flow)",
            "Flood: FEMA National Flood Hazard Layer; Wetlands: USFWS NWI",
            "Sinkholes: USGS SIR 2024-5134 LiDAR-derived karst depressions (TN Base Mapping Program)",
            "Soils: USDA NRCS SSURGO via Soil Data Access",
        ],
    }
    (OUT / "parcels.json").write_text(json.dumps({"meta": meta, "cols": cols}, separators=(",", ":")))

    # geometry: simplified polygons, 5-decimal coords
    g = gpd.GeoSeries(p.set_index("pid").loc[df["pid"]].geometry.values, crs=4326)
    g = g.to_crs(CRS_M).simplify(2.5).to_crs(4326)

    def rings(geom):
        polys = [geom] if geom.geom_type == "Polygon" else [q for q in getattr(geom, "geoms", []) if q.geom_type == "Polygon"]
        return [[[round(c[1], 5), round(c[0], 5)] for c in q.exterior.coords] for q in polys]
    (OUT / "geom.json").write_text(json.dumps([rings(a) for a in g], separators=(",", ":")))

    h = np.load(CACHE / "horizon.npy").astype("<i2")
    order = t.set_index("pid").index.get_indexer(df["pid"])
    h[order].tofile(OUT / "horizon.bin")

    targets = pd.read_csv(CACHE / "view_targets.csv")
    from s70_drivetimes import clean_groceries
    groc = clean_groceries()
    layers = {
        "hospitals": [{"name": n, "lat": c[0], "lon": c[1], "tags": sorted(tg)} for n, q, c, tg in HOSPITALS],
        "towns": [{"name": k, "lat": v[0], "lon": v[1]} for k, v in TOWNS.items()],
        "key": [{"name": v[0], "lat": v[1][0], "lon": v[1][1]} for v in KEY_DESTS.values()],
        "targets": [{"kind": r.kind, "lat": round(r.lat, 5), "lon": round(r.lon, 5), "z": round(r.z)}
                    for r in targets.itertuples()],
        "groceries": [{"name": r.nm, "lat": round(r.geometry.y, 5), "lon": round(r.geometry.x, 5)}
                      for r in groc.itertuples()],
        "horizon_az_step": 5,
    }
    (OUT / "layers.json").write_text(json.dumps(layers, separators=(",", ":")))
    for f in OUT.iterdir():
        print(f.name, round(f.stat().st_size / 1e6, 2), "MB")


if __name__ == "__main__":
    main()
