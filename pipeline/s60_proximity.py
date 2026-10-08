"""Proximity, noise, hazards, soils and neighbourhood metrics for each parcel's house site (pad point)."""
import re

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import LineString, Point

from config import CACHE, CRS_M, RAW, TYS_RUNWAYS

# Reference daytime noise at 15 m from the road edge (dBA) by road class – typical traffic for East TN.
NOISE_REF = {"motorway": 78, "trunk": 74, "primary": 70, "secondary": 65, "tertiary": 60, "local": 52}
NOISE_FLOOR = 35.0

BIGBOX = re.compile(r"^(walmart supercenter|walmart$|wal-mart|lowe'?s home|lowe'?s$|the home depot|home depot|"
                    r"target$|costco|sam'?s club|kohl'?s|menards|academy sports|bass pro|dick'?s sporting|"
                    r"best buy|tj maxx|marshalls|ross dress|hobby lobby|big lots|at home$)", re.I)
GROCERY = re.compile(r"^(kroger|food city|publix|walmart supercenter|walmart neighborhood market|aldi|ingles|"
                     r"food lion|lidl|the fresh market|earth fare|three rivers market|sprouts|save a lot|"
                     r"save-a-lot|piggly wiggly|weigel'?s farm)", re.I)
NUISANCE = re.compile(r"(?:speedway|raceway|dragway|motorsports park|shooting|gun club|rifle|sporting clays|"
                      r"gun range|pistol range|race ?track|motocross)", re.I)


def pname(n):
    return (n or {}).get("primary") if isinstance(n, dict) else None


def polys_only(gdf):
    g = gdf.explode(index_parts=False)
    return g[g.geometry.geom_type == "Polygon"]


def nearest(src, feats, col):
    """Distance (m) from each src point to the nearest geometry in feats."""
    if len(feats) == 0:
        return pd.Series(np.nan, index=src.index)
    j = gpd.sjoin_nearest(src[["geometry"]], feats[["geometry"]], how="left", distance_col=col)
    return j[~j.index.duplicated()][col].round(0)


def count_within(src, feats, radius):
    buf = src[["geometry"]].copy()
    buf["geometry"] = buf.buffer(radius)
    j = gpd.sjoin(buf, feats[["geometry"]], predicate="intersects", how="left")
    return j.groupby(level=0)["index_right"].count().reindex(src.index).fillna(0).astype(int)


def main():
    parcels = gpd.read_parquet(CACHE / "parcels.parquet").to_crs(CRS_M)
    terr = pd.read_parquet(CACHE / "terrain.parquet").set_index("pid")
    parcels = parcels.set_index("pid")
    parcels.index.name = None
    pads = gpd.GeoDataFrame(index=parcels.index,
                            geometry=gpd.points_from_xy(terr.loc[parcels.index, "pad_x"],
                                                        terr.loc[parcels.index, "pad_y"]), crs=CRS_M)
    out = pd.DataFrame(index=parcels.index)

    # Roads -------------------------------------------------------------------------------
    seg = gpd.read_parquet(RAW / "overture_segment.parquet").to_crs(CRS_M)
    roads = seg[seg["subtype"] == "road"]
    cls = roads["class"].replace({"residential": "local", "unclassified": "local", "living_street": "local"})
    for c in ["motorway", "trunk", "primary", "secondary", "tertiary", "local"]:
        out[f"d_{c}_m"] = nearest(pads, roads[cls == c], f"d_{c}_m")
    drivable = roads[roads["class"].isin(["motorway", "trunk", "primary", "secondary", "tertiary", "residential",
                                          "unclassified", "living_street", "service", "track"])]
    out["road_dist_m"] = nearest(pads, drivable, "road_dist_m")
    out["d_freeway_m"] = out["d_motorway_m"]
    out["d_major_m"] = out[["d_trunk_m", "d_primary_m"]].min(axis=1)
    energy = np.full(len(out), 10 ** (NOISE_FLOOR / 10))
    for c, ref in NOISE_REF.items():
        d = out[f"d_{c}_m"].fillna(1e6).clip(lower=15).values
        energy += 10 ** ((ref - 15 * np.log10(d / 15)) / 10)
    out["noise_db"] = np.round(10 * np.log10(energy), 1)
    rail = seg[(seg["subtype"] == "rail") & seg["class"].isin(["standard_gauge"])]
    out["d_rail_m"] = nearest(pads, rail, "d_rail_m")
    print("roads done", flush=True)

    # Airport -----------------------------------------------------------------------------
    rws = gpd.GeoSeries([LineString([(a[1], a[0]), (b[1], b[0])]) for a, b in TYS_RUNWAYS], crs=4326).to_crs(CRS_M)
    out["d_airport_m"] = pads.geometry.apply(lambda p: min(r.distance(p) for r in rws)).round(0)
    under = np.zeros(len(pads), bool)
    px, py = pads.geometry.x.values, pads.geometry.y.values
    for r in rws:
        (x0, y0), (x1, y1) = r.coords[0], r.coords[-1]
        L = np.hypot(x1 - x0, y1 - y0)
        ux, uy = (x1 - x0) / L, (y1 - y0) / L
        along = (px - x0) * ux + (py - y0) * uy
        lat = np.abs(-(px - x0) * uy + (py - y0) * ux)
        beyond = np.where(along < 0, -along, np.where(along > L, along - L, 0))
        under |= (beyond > 0) & (beyond <= 12000) & (lat <= 600 + 0.08 * beyond)
    out["under_approach"] = under

    # Places --------------------------------------------------------------------------------
    pl = gpd.read_parquet(RAW / "overture_place.parquet").to_crs(CRS_M)
    pl["nm"] = pl["names"].map(pname).fillna("")
    pl = pl[pl["confidence"].fillna(0) >= 0.5]
    cat = pl["basic_category"].fillna("")
    lu = gpd.read_parquet(RAW / "overture_land_use.parquet").to_crs(CRS_M)
    lu["area"] = lu.area
    big_retail = lu[(lu["class"] == "retail") & (lu["area"] > 40000)]
    bigbox = pd.concat([pl[pl["nm"].str.match(BIGBOX)][["geometry"]], big_retail[["geometry"]]])
    out["d_bigbox_m"] = nearest(pads, gpd.GeoDataFrame(bigbox, crs=CRS_M), "d_bigbox_m")
    groc = pl[pl["nm"].str.match(GROCERY) & ~pl["nm"].str.contains("pharmacy|gas|fuel|vision|auto", case=False)]
    groc[["nm", "geometry"]].to_crs(4326).to_parquet(CACHE / "groceries.parquet")
    out["d_grocery_m"] = nearest(pads, groc, "d_grocery_m")
    out["d_pharmacy_m"] = nearest(pads, pl[cat == "pharmacy_and_drug_store"], "d_pharmacy_m")
    out["d_fire_m"] = nearest(pads, pl[cat == "fire_station"], "d_fire_m")
    clinics = pl[cat.isin(["emergency_or_urgent_care_facility", "urgent_care_clinic", "primary_care_or_general_clinic",
                           "emergency_department"])]
    out["n_clinics_10km"] = count_within(pads, clinics, 10000)
    golf = pd.concat([pl[cat == "golf_course"][["geometry"]], lu[lu["class"] == "golf_course"][["geometry"]]])
    out["d_golf_m"] = nearest(pads, gpd.GeoDataFrame(golf, crs=CRS_M), "d_golf_m")
    parks = lu[lu["class"].isin(["park", "nature_reserve", "recreation_ground"])]
    out["d_park_m"] = nearest(pads, parks, "d_park_m")
    marinas = pd.concat([lu[lu["class"] == "marina"][["geometry"]], pl[cat.str.contains("marina")][["geometry"]]])
    out["d_marina_m"] = nearest(pads, gpd.GeoDataFrame(marinas, crs=CRS_M), "d_marina_m")
    nuis_pl = pl[pl["nm"].str.contains(NUISANCE)]
    print("places done", flush=True)

    # Industrial / nuisance land uses ------------------------------------------------------
    industrial = lu[(lu["class"].isin(["industrial", "works"])) & (lu["area"] > 20000)]
    out["d_industrial_m"] = nearest(pads, industrial, "d_industrial_m")
    out["d_quarry_m"] = nearest(pads, lu[lu["class"] == "quarry"], "d_quarry_m")
    out["d_landfill_m"] = nearest(pads, lu[lu["class"] == "landfill"], "d_landfill_m")
    water = gpd.read_parquet(RAW / "overture_water.parquet").to_crs(CRS_M)
    ww = water[water["class"].isin(["wastewater", "sewage"])]
    nuis = pd.concat([nuis_pl[["geometry"]], ww[["geometry"]]])
    out["d_nuisance_m"] = nearest(pads, gpd.GeoDataFrame(nuis, crs=CRS_M), "d_nuisance_m")
    infra = gpd.read_parquet(RAW / "overture_infrastructure.parquet").to_crs(CRS_M)
    out["d_powerline_m"] = nearest(pads, infra[infra["class"] == "power_line"], "d_powerline_m")
    out["d_substation_m"] = nearest(pads, infra[infra["class"] == "substation"], "d_substation_m")
    out["d_celltower_m"] = nearest(pads, infra[infra["class"].isin(["mobile_phone_tower", "communication_tower"])],
                                   "d_celltower_m")

    # Water / lakes -------------------------------------------------------------------------
    wb = water[water.geometry.geom_type.isin(["Polygon", "MultiPolygon"]) &
               water["subtype"].isin(["reservoir", "lake", "river", "water"])].copy()
    wb = wb[wb.area > 40000]
    poly = gpd.GeoDataFrame(geometry=parcels.geometry, crs=CRS_M)
    out["water_dist_m"] = nearest(poly, wb, "water_dist_m")
    out["waterfront"] = out["water_dist_m"] <= 30
    print("water done", flush=True)

    # Buildings -----------------------------------------------------------------------------
    b = gpd.read_parquet(RAW / "overture_building.parquet", columns=["geometry"]).to_crs(CRS_M)
    b = b[b.area >= 40]
    bc = gpd.GeoDataFrame(geometry=b.geometry.centroid, crs=CRS_M)
    j = gpd.sjoin(bc, poly, predicate="within", how="inner")
    out["bldg_fp"] = j.groupby("index_right").size().reindex(out.index).fillna(0).astype(int)
    out["bldgs_500m"] = count_within(pads, bc, 500)
    print("buildings done", flush=True)

    # City limits ---------------------------------------------------------------------------
    cities = gpd.read_parquet(CACHE / "cities.parquet").to_crs(CRS_M)
    j = gpd.sjoin(pads, cities[["NAME", "geometry"]], predicate="within", how="left")
    out["city"] = j[~j.index.duplicated()]["NAME"].fillna("")

    # Soils ---------------------------------------------------------------------------------
    soils = gpd.read_parquet(CACHE / "soils.parquet").to_crs(CRS_M)
    soils = polys_only(soils[soils.geometry.notna() & ~soils.geometry.is_empty])
    j = gpd.sjoin(pads, soils, predicate="within", how="left")
    j = j[~j.index.duplicated()]
    out["soil_name"] = j["muname"]
    out["septic_rating"] = j["septic"].fillna("Unknown")
    out["septic_limits"] = j["septic_limits"].fillna("")
    out["basement_rating"] = j["basement"].fillna("Unknown")
    out["rock_depth_cm"] = pd.to_numeric(j["brockdepmin"], errors="coerce")
    out["drainage"] = j["drclassdcd"].fillna("")
    out["parent_mat"] = j["parent_mat"].fillna("")
    pm = out["parent_mat"].str.lower()
    out["karst_geology"] = pm.str.contains("residuum|creep") & pm.str.contains("limestone|dolomite")
    ov = gpd.overlay(polys_only(gpd.GeoDataFrame({"pid": parcels.index}, geometry=parcels.geometry.values,
                                                 crs=CRS_M)),
                     soils[["septic", "hydclprs", "geometry"]], how="intersection", keep_geom_type=True)
    ov["a"] = ov.area
    tot = ov.groupby("pid")["a"].sum()
    good = ov[ov["septic"].isin(["Not limited", "Somewhat limited"])].groupby("pid")["a"].sum()
    out["septic_ok_pct"] = (good.reindex(out.index).fillna(0) / tot.reindex(out.index) * 100).round(0)
    hyd = (ov["a"] * pd.to_numeric(ov["hydclprs"], errors="coerce").fillna(0) / 100).groupby(ov["pid"]).sum()
    out["hydric_pct"] = (hyd.reindex(out.index) / tot.reindex(out.index) * 100).round(0)
    print("soils done", flush=True)

    # Sinkholes (USGS LiDAR-derived closed depressions) --------------------------------------
    dep = gpd.read_parquet(CACHE / "depressions.parquet").to_crs(CRS_M)
    dep = dep[dep["is_lakepnd"] == 0]
    out["sink_dist_m"] = nearest(pads, dep, "sink_dist_m")
    out["sink_count_1km"] = count_within(pads, dep, 1000)
    j = gpd.sjoin(poly, dep[["depth", "area", "geometry"]], predicate="intersects", how="inner")
    out["sink_on_parcel"] = j.groupby(level=0).size().reindex(out.index).fillna(0).astype(int)
    out["sink_max_depth_ft"] = j.groupby(level=0)["depth"].max().reindex(out.index).round(1)
    high = (out["sink_dist_m"] <= 50) | ((out["sink_on_parcel"] > 0) & out["karst_geology"]) | \
           (out["sink_count_1km"] >= 15)
    mod = (out["sink_on_parcel"] > 0) | (out["sink_count_1km"] >= 4) | out["karst_geology"] | \
          (out["sink_dist_m"] <= 200)
    out["sinkhole_risk"] = np.where(high, "High", np.where(mod, "Moderate", "Low"))
    print("sinkholes", out["sinkhole_risk"].value_counts().to_dict())

    out.index.name = "pid"
    out.reset_index().to_parquet(CACHE / "proximity.parquet")
    print(out.describe().T[["mean", "50%", "min", "max"]].round(1).to_string())


if __name__ == "__main__":
    main()
