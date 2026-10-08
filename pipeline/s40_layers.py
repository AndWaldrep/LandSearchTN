"""Hazard / regulatory overlays: FEMA flood, NWI wetlands, USGS karst depressions, city limits, SSURGO soils."""
import io
import json
import zipfile

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely import wkt

from config import CACHE, RAW, STUDY_BBOX
from util import arcgis_query, cached_json, http_get

NFHL = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28"
NWI = "https://tnmap.tn.gov/arcgis/rest/services/ENVIRONMENTAL/NATIONAL_WETLANDS_INVENTORY/MapServer/0"
CITIES = "https://tnmap.tn.gov/arcgis/rest/services/ADMINISTRATIVE_BOUNDARIES/COUNTY_BOUNDARIES_AND_CITY_BOUNDARIES/MapServer/0"
KARST_ITEM = "https://www.sciencebase.gov/catalog/item/5a5fdc2ae4b06e28e9bfc643?format=json"
SDA = "https://SDMDataAccess.sc.egov.usda.gov/Tabular/post.rest"


def flood():
    g = arcgis_query(NFHL, where="SFHA_TF='T'", out_fields="FLD_ZONE,ZONE_SUBTY,SFHA_TF", geometry=STUDY_BBOX,
                     cache_key="nfhl_sfha", page=200)
    g.to_parquet(CACHE / "flood.parquet")
    print("flood polygons", len(g))


def wetlands():
    g = arcgis_query(NWI, out_fields="LABEL1,LABEL2", geometry=STUDY_BBOX, cache_key="nwi", page=500)
    # Exclude open-water lakes/rivers (L*, R* deepwater) – those are captured as water features.
    lab = g["LABEL1"].fillna("")
    g = g[lab.str.startswith("P")].copy()  # palustrine = vegetated wetlands
    g.to_parquet(CACHE / "wetlands.parquet")
    print("wetland polygons", len(g))


def cities():
    g = arcgis_query(CITIES, out_fields="NAME", geometry=STUDY_BBOX, cache_key="cities")
    g.to_parquet(CACHE / "cities.parquet")
    print("cities", sorted(g["NAME"]))


def karst():
    out = CACHE / "depressions.parquet"
    if out.exists():
        return
    meta = http_get(KARST_ITEM).json()
    url = next(f["url"] for f in meta["files"] if f["name"] == "TNBMP_depressions.zip")
    z = RAW / "TNBMP_depressions.zip"
    if not z.exists():
        z.write_bytes(http_get(url, timeout=600).content)
    with zipfile.ZipFile(z) as zf:
        names = zf.namelist()
        print("karst zip:", names[:20])
        zf.extractall(RAW / "karst")
    shp = next(p for p in (RAW / "karst").rglob("*") if p.suffix.lower() in (".shp", ".gdb") or p.name.endswith(".gdb"))
    g = gpd.read_file(shp, bbox=STUDY_BBOX if False else None)
    g = g.to_crs(4326)
    x0, y0, x1, y1 = STUDY_BBOX
    g = g.cx[x0 - 0.02:x1 + 0.02, y0 - 0.02:y1 + 0.02]
    print("depressions in area", len(g), list(g.columns))
    g.to_parquet(out)


def sda(query):
    r = http_get(SDA, method="POST", data=json.dumps({"format": "JSON+COLUMNNAME", "query": query}), timeout=300)
    t = r.json().get("Table", [])
    return pd.DataFrame(t[1:], columns=t[0]) if t else pd.DataFrame()


def soils():
    out = CACHE / "soils.parquet"
    if out.exists():
        return
    x0, y0, x1, y1 = STUDY_BBOX
    frames = []
    step = 0.05
    for xi, x in enumerate(np.arange(x0, x1, step)):
        for yi, y in enumerate(np.arange(y0, y1, step)):
            poly = f"POLYGON(({x} {y},{x+step} {y},{x+step} {y+step},{x} {y+step},{x} {y}))"
            q = ("SELECT mukey, mupolygongeo.STIntersection(geometry::STGeomFromText('%s',4326))"
                 ".Reduce(0.00003).STAsText() AS wkt FROM mupolygon "
                 "WHERE mupolygongeo.STIntersects(geometry::STGeomFromText('%s',4326))=1" % (poly, poly))
            df = cached_json(f"sda_{xi}_{yi}", lambda: sda(q).to_dict("list"))
            df = pd.DataFrame(df)
            frames.append(df)
            print(f"  soils tile {xi},{yi}: {len(df)}", flush=True)
    df = pd.concat(frames, ignore_index=True)
    g = gpd.GeoDataFrame(df[["mukey"]], geometry=df["wkt"].map(wkt.loads), crs=4326)
    g = g[~g.geometry.is_empty]

    keys = sorted(g["mukey"].unique())
    rows = []
    for i in range(0, len(keys), 300):
        ks = ",".join(keys[i:i + 300])
        q = f"""
        SELECT mu.mukey, mu.muname, ma.brockdepmin, ma.hydclprs, ma.drclassdcd, ma.flodfreqdcd, ma.hydgrpdcd,
               ma.wtdepannmin,
          (SELECT TOP 1 ci.interphrc FROM component c JOIN cointerp ci ON ci.cokey=c.cokey
             WHERE c.mukey=mu.mukey AND ci.mrulename='ENG - Septic Tank Absorption Fields' AND ci.ruledepth=0
             ORDER BY c.comppct_r DESC) AS septic,
          (SELECT TOP 1 ci.interphrc FROM component c JOIN cointerp ci ON ci.cokey=c.cokey
             WHERE c.mukey=mu.mukey AND ci.mrulename='ENG - Dwellings With Basements' AND ci.ruledepth=0
             ORDER BY c.comppct_r DESC) AS basement,
          (SELECT TOP 1 pm.pmgroupname FROM component c JOIN copmgrp pm ON pm.cokey=c.cokey
             WHERE c.mukey=mu.mukey AND pm.rvindicator='Yes' ORDER BY c.comppct_r DESC) AS parent_mat,
          STUFF((SELECT DISTINCT '; ' + ci.interphrc FROM component c JOIN cointerp ci ON ci.cokey=c.cokey
             WHERE c.mukey=mu.mukey AND c.majcompflag='Yes' AND ci.mrulename='ENG - Septic Tank Absorption Fields'
               AND ci.ruledepth=1 AND ci.interphr>=0.5 FOR XML PATH('')),1,2,'') AS septic_limits
        FROM mapunit mu JOIN muaggatt ma ON ma.mukey=mu.mukey WHERE mu.mukey IN ({ks})"""
        rows.append(sda(q))
    attrs = pd.concat(rows, ignore_index=True)
    g = g.merge(attrs, on="mukey", how="left")
    g.to_parquet(out)
    print("soil polygons", len(g), "mapunits", len(attrs))
    print(attrs["septic"].value_counts().to_dict())


if __name__ == "__main__":
    import sys
    steps = sys.argv[1:] or ["flood", "wetlands", "cities", "karst", "soils"]
    for s in steps:
        globals()[s]()
