"""Fetch vacant candidate parcels for Blount, Loudon and northern Monroe and normalise them."""
import json
import re
from datetime import datetime, timezone
from urllib.parse import quote

import geopandas as gpd
import numpy as np
import pandas as pd

from config import (LISTED_ONLY, BLOUNT_URL, CACHE, EXCLUDE_CLASSES, EXCLUDE_OWNER_PATTERNS, HNTB_LAYERS, HNTB_URL,
                    MAX_ACRES, MIN_ACRES, STATEWIDE_URL, STUDY_BBOX)
from util import arcgis_query

ROAD = {"0": "US Highway", "1": "Interchange", "2": "State Highway", "3": "Paved", "4": "Gravel", "5": "Dirt",
        "6": "Urban Paved", "7": "Curb/Gutter Paved", "8": "Private/None"}
TOPO = {"0": "Level", "1": "Rolling", "2": "Mountainous", "3": "High", "4": "Low", "5": "Gully/Waste"}
CLASS = {"00": "Residential", "10": "Farm", "11": "Agricultural", "12": "Forest", "08": "Commercial",
         "09": "Industrial"}


def code(v):
    v = v.strip() if isinstance(v, str) else ""
    return v.split(" ")[0] if v else ""


def blount(where=f"BLDGS=0 AND CALC_ACRE>={MIN_ACRES} AND CALC_ACRE<={MAX_ACRES}", geometry=None,
           key="blount_vacant"):
    cols = ("GISLINK,PARID,CALC_ACRE,CAMADEEDAC,ADDRESS,OWNER,OWNER2,MAILADDR,MAILCITY,STATE,ZIP,PT,ZONING,"
            "WATERSEWER,ELEC,GAS,TOPO,ROADTYPE,LANDUSE,SUBDIV,LOT,LANDVAL,LANDUSEVAL,IMPVAL,OBYVAL,APPRAISAL,"
            "SALEDATE,PRICE,BLDGS,NUM_MH,TAXYR,LASTUPD")
    g = arcgis_query(BLOUNT_URL, where=where, out_fields=cols, geometry=geometry, cache_key=key)
    if g.empty:
        return None
    ws = g["WATERSEWER"].fillna("").str.replace(r"^\d+\s*", "", regex=True).str.split("/")
    out = pd.DataFrame({
        "gislink": g["GISLINK"], "county": "Blount",
        "address": g["ADDRESS"], "owner": g["OWNER"], "owner2": g["OWNER2"],
        "mail_addr": g["MAILADDR"], "mail_city": g["MAILCITY"], "mail_state": g["STATE"], "mail_zip": g["ZIP"],
        "deed_ac": g["CAMADEEDAC"], "land_val": g["LANDVAL"], "use_val": g["LANDUSEVAL"],
        "imp_val": g["IMPVAL"].fillna(0) + g["OBYVAL"].fillna(0), "appraisal": g["APPRAISAL"],
        "class_code": g["PT"].map(code), "landuse": g["LANDUSE"], "zoning": g["ZONING"],
        "water": ws.str[0].fillna(""), "sewer": ws.str[1].fillna(""),
        "elec": g["ELEC"].fillna("").str.replace(r"^\d+\s*", "", regex=True),
        "gas": g["GAS"].fillna("").str.replace(r"^\d+\s*", "", regex=True),
        "topo_code": g["TOPO"].map(code).map(TOPO).fillna(""),
        "road_type": g["ROADTYPE"].map(code).map(ROAD).fillna(""),
        "subdivision": g["SUBDIV"], "last_price": g["PRICE"],
        "last_sale": pd.to_datetime(g["SALEDATE"].str.strip(), format="%m/%d/%Y", errors="coerce"),
        "bldgs": g["BLDGS"], "mobile_homes": g["NUM_MH"], "data_year": g["TAXYR"],
        "owner_now": g["OWNER"],
    })
    return gpd.GeoDataFrame(out, geometry=g.geometry, crs=4326)


def hntb(county, where=None, geometry=STUDY_BBOX, key=None):
    lid, p = HNTB_LAYERS[county]
    where = where or f"{p}_BLDGS=0 AND Parcels_CALC_ACRE>={MIN_ACRES} AND Parcels_CALC_ACRE<={MAX_ACRES}"
    g = arcgis_query(f"{HNTB_URL}/{lid}", where=where, geometry=geometry, cache_key=key or f"{county.lower()}_vacant")
    if g.empty:
        return None

    def c(name, default=None):
        k = f"{p}_{name}"
        return g[k] if k in g else pd.Series([default] * len(g), index=g.index)

    imp = c("IMPVAL")
    if imp.isna().all():
        imp = (c("APPRAISAL").fillna(0) - c("LANDMKTVAL").fillna(0)).clip(lower=0)
    sale = pd.to_datetime(c("SALEDATE"), unit="ms", errors="coerce")
    out = pd.DataFrame({
        "gislink": g["Parcels_GISLINK"].fillna(c("GISLINK")), "county": county,
        "address": c("ADDRESS"), "owner": c("OWNER"), "owner2": c("OWNER2"),
        "mail_addr": c("MAILADDR", ""), "mail_city": c("MAILCITY", ""), "mail_state": c("STATE", ""),
        "mail_zip": c("ZIP", ""), "deed_ac": c("DEEDAC"), "land_val": c("LANDMKTVAL"),
        "use_val": c("LANDUSEVAL", 0).fillna(0) + c("USEVALUE", 0).fillna(0),
        "imp_val": imp, "appraisal": c("APPRAISAL"), "class_code": c("CLASS", "").map(code),
        "landuse": c("LANDUSE", ""), "zoning": c("ZONING", ""),
        "water": c("WATER", "").fillna("").str.title(), "sewer": c("SEWER", "").fillna("").str.title(),
        "elec": c("ELEC", "").fillna("").str.title(), "gas": c("GAS", "").fillna("").str.title(),
        "topo_code": c("TOPO", "").map(code).map(TOPO).fillna(""),
        "road_type": c("ROADTYPE", "").map(code).map(ROAD).fillna(""),
        "subdivision": c("SUBDIV", ""), "last_price": c("PRICE"), "last_sale": sale,
        "bldgs": c("BLDGS"), "mobile_homes": c("NUM_MH", 0), "data_year": c("TAXYR_NUM", 2023).fillna(2023),
    })
    out = gpd.GeoDataFrame(out, geometry=g.geometry, crs=4326)
    # Current owner from the statewide public-use layer to detect sales since the CAMA snapshot.
    prefix = out["gislink"].dropna().iloc[0][:3]
    sw = arcgis_query(STATEWIDE_URL, where=f"GISLINK LIKE '{prefix}%'", out_fields="GISLINK,OWNER",
                      return_geometry=False, cache_key=f"statewide_owner_{prefix}")
    cur = sw.drop_duplicates("GISLINK").set_index("GISLINK")["OWNER"]
    out["owner_now"] = out["gislink"].map(cur)
    return out


def norm_owner(s):
    return re.sub(r"[^A-Z ]", "", s.upper() if isinstance(s, str) else "").split()


def prep(frames):
    g = pd.concat([f for f in frames if f is not None], ignore_index=True)
    g = gpd.GeoDataFrame(g, geometry="geometry", crs=4326)
    g = g[g.geometry.notna() & ~g.geometry.is_empty].copy()
    g["geometry"] = g.geometry.make_valid()
    return g.dissolve(by="gislink", aggfunc="first", as_index=False)  # multi-part parcels


def load_listings():
    """Land listings (no house) inside the study box, as points."""
    p = CACHE / "listings.json"
    if not p.exists():
        return gpd.GeoDataFrame(columns=["geometry"], geometry="geometry", crs=4326)
    rows = [r for r in json.loads(p.read_text())["listings"] if not r["has_home"]]
    chk = CACHE / "listing_links.json"
    if chk.exists():  # drop listings whose page no longer opens (sold / withdrawn)
        status = json.loads(chk.read_text())
        dead = [r["id"] for r in rows if status.get(str(r["id"]), 200) != 200]
        print(f"dropping {len(dead)} listings whose page no longer opens")
        rows = [r for r in rows if r["id"] not in dead]
    x0, y0, x1, y1 = STUDY_BBOX
    rows = [r for r in rows if x0 <= r["lon"] <= x1 and y0 <= r["lat"] <= y1]
    df = pd.DataFrame(rows)
    return gpd.GeoDataFrame(df, geometry=gpd.points_from_xy(df["lon"], df["lat"]), crs=4326)


def listed_parcels(lst, have):
    """Fetch parcels (any vacancy status) under listing points that the vacant set does not cover."""
    j = gpd.sjoin(lst, have[["gislink", "geometry"]], predicate="within", how="left")
    miss = lst[lst["id"].isin(j[j["gislink"].isna()]["id"])]
    print(f"listings: {len(lst)} in study area, {len(lst) - len(miss)} fall on vacant candidates, "
          f"fetching parcels for {len(miss)}")
    frames = []
    by_cty = {"Blount": blount, "Loudon": lambda **k: hntb("Loudon", **k), "Monroe": lambda **k: hntb("Monroe", **k)}
    for cty, fn in by_cty.items():
        pts = miss[miss["county"] == cty]
        for i in range(0, len(pts), 60):
            chunk = pts.iloc[i:i + 60]
            geom = {"points": [[round(x, 6), round(y, 6)] for x, y in zip(chunk["lon"], chunk["lat"])]}
            key = f"listed_{cty.lower()}_{abs(hash(tuple(sorted(chunk['id'])))) % 10**10}"
            frames.append(fn(where="1=1", geometry=geom, key=key))
    return prep(frames) if any(f is not None for f in frames) else None


STATUS_RANK = {"active": 0, "coming-soon": 1, "pending": 2}
LIST_COLS = ["listed", "list_id", "list_price", "list_acres", "list_status", "list_url", "list_title", "list_date",
             "list_match"]


def _list_fields(r, match):
    return {"listed": True, "list_id": r["id"], "list_price": r["price"], "list_acres": r["acres"],
            "list_status": r["status"], "list_url": r["url"], "list_title": r["title"],
            "list_date": r["listed_at"], "list_match": match}


def attach_listings(g, lst):
    """Give every listing exactly one entry, so every for-sale row links to its listing.

    * A listing whose acreage fits the parcel under its pin is attached to that parcel.
    * Other listings (no parcel under the pin, a much larger parent tract, or a second listing on
      the same parcel) get their own entry: a circle of the listed acreage around the pin, clipped
      to the parcel it sits in, carrying that parcel's assessor attributes.
    """
    for c in LIST_COLS:
        g[c] = False if c == "listed" else (np.nan if c in ("list_id", "list_price", "list_acres") else "")
    g_m = g.to_crs(32136)
    g["_ac"] = g_m.area / 4046.8564
    lst = lst.copy()
    lst["rank"] = lst["status"].map(STATUS_RANK).fillna(3)
    j = gpd.sjoin(lst, g[["gislink", "_ac", "geometry"]], predicate="within", how="left")
    j = j[~j.index.duplicated()]
    la = j["acres"].fillna(0)
    fits = j["gislink"].notna() & (j["_ac"] <= np.maximum(3 * la, la + 10)) & (j["_ac"] >= 0.05)
    j["fit"] = np.abs(np.log((j["_ac"] + 0.01) / (la + 0.01)))
    prim = j[fits].sort_values(["rank", "fit", "listed_at"], ascending=[True, True, False]).drop_duplicates("gislink")
    idx = g.set_index("gislink").index
    for _, r in prim.iterrows():
        ratio = r["_ac"] / r["acres"] if r["acres"] else np.nan
        match = "Parcel matches listing" if 0.75 <= ratio <= 1.33 else "Listing covers part / several parcels"
        pos = idx.get_loc(r["gislink"])
        for k, v in _list_fields(r, match).items():
            g.iat[pos, g.columns.get_loc(k)] = v

    rest = j[~j["id"].isin(prim["id"])]
    synth = []
    for _, r in rest.iterrows():
        pt = gpd.GeoSeries([r.geometry], crs=4326).to_crs(32136).iloc[0]
        ac = r["acres"] if pd.notna(r["acres"]) and r["acres"] > 0 else 0.25
        area = min(max(ac, 0.25), 200) * 4046.8564
        circ = pt.buffer(np.sqrt(area / np.pi))
        base = {}
        if isinstance(r["gislink"], str):
            row = g.iloc[idx.get_loc(r["gislink"])]
            base = row.drop(labels=["geometry", "_ac"] + LIST_COLS).to_dict()
            parcel = gpd.GeoSeries([row.geometry], crs=4326).to_crs(32136).iloc[0]
            clipped = circ.intersection(parcel)
            if clipped.area > 0.3 * circ.area:
                circ = clipped
            match = "Separate listing inside a larger parcel (approx. area)"
        else:
            match = "Approximate area (no parcel found under the listing pin)"
            base = {"county": r["county"], "address": r["title"]}
        base.update(_list_fields(r, match))
        base["gislink"] = f"LS{int(r['id'])}"
        base["from_listing"] = True
        base["synthetic"] = True
        base["geometry"] = gpd.GeoSeries([circ], crs=32136).to_crs(4326).iloc[0]
        synth.append(base)
    g = g.drop(columns=["_ac"])
    g["synthetic"] = False
    if synth:
        g = gpd.GeoDataFrame(pd.concat([g, gpd.GeoDataFrame(synth, geometry="geometry", crs=4326)], ignore_index=True),
                             geometry="geometry", crs=4326)
    g["listed"] = g["listed"].fillna(False).astype(bool)
    today = pd.Timestamp(datetime.now(timezone.utc).date())
    g["days_listed"] = (today - pd.to_datetime(g["list_date"], errors="coerce")).dt.days
    g["list_ppa"] = (g["list_price"] / g["list_acres"].where(g["list_acres"] >= 0.05)).round(0)
    print(f"listings: {len(lst)} -> {len(prim)} on matching parcels, {len(synth)} as their own approx. entries "
          f"({(rest['gislink'].isna()).sum()} with no parcel under the pin)")
    return g


def build():
    g = prep([blount(), hntb("Loudon"), hntb("Monroe")])
    n0 = len(g)
    g["from_listing"] = False
    lst = load_listings()
    if len(lst):
        extra = listed_parcels(lst, g)
        if extra is not None:
            extra = extra[~extra["gislink"].isin(g["gislink"])]
            extra["from_listing"] = True
            g = gpd.GeoDataFrame(pd.concat([g, extra], ignore_index=True), geometry="geometry", crs=4326)

    cen = g.to_crs(32136).geometry.centroid.to_crs(4326)
    x0, y0, x1, y1 = STUDY_BBOX
    g = g[(cen.x.between(x0, x1)) & (cen.y.between(y0, y1)).values].copy()
    g = attach_listings(g, lst) if len(lst) else g.assign(listed=False, synthetic=False)

    owners = (g["owner"].fillna("") + " " + g["owner2"].fillna("")).str.upper()
    pat = re.compile("|".join(EXCLUDE_OWNER_PATTERNS))
    excl_owner = owners.str.contains(pat)
    excl_class = g["class_code"].isin(EXCLUDE_CLASSES)
    excl_imp = g["imp_val"].fillna(0) >= 5000
    print(f"parcels {n0} -> in bbox {len(g)}; excluded owner={excl_owner.sum()} class={excl_class.sum()} "
          f"improved={excl_imp.sum()}")
    g = g[g["listed"] | ~(excl_owner | excl_class | excl_imp)].copy()

    g["acres"] = (g.to_crs(32136).area / 4046.8564).round(3)
    g = g[g["listed"] | g["acres"].between(MIN_ACRES, MAX_ACRES)].copy()
    if LISTED_ONLY:  # the dashboard shows land for sale; skip metrics for unlisted parcels
        g = g[g["listed"]].copy()

    # Ownership signals
    home_county_city = {"Blount": ["MARYVILLE", "ALCOA", "LOUISVILLE", "FRIENDSVILLE", "TOWNSEND", "WALLAND",
                                   "ROCKFORD", "GREENBACK"],
                        "Loudon": ["LOUDON", "LENOIR CITY", "GREENBACK", "PHILADELPHIA"],
                        "Monroe": ["MADISONVILLE", "VONORE", "SWEETWATER", "TELLICO PLAINS", "LOUDON", "GREENBACK"]}
    mc = g["mail_city"].fillna("").str.upper().str.strip()
    ms = g["mail_state"].fillna("").str.upper().str.strip()
    g["out_of_state"] = (ms != "") & (ms != "TN")
    g["absentee"] = g["out_of_state"] | np.array([
        (c != "" and c not in home_county_city.get(k, [])) for c, k in zip(mc, g["county"])])
    g["estate_flag"] = owners.loc[g.index].str.contains(r"\bESTATE\b|\bHEIRS\b|\bETAL\b|\bET AL\b|\bTRUST\b|\bTRUSTEE")
    g["corp_owner"] = owners.loc[g.index].str.contains(
        r"\bLLC\b|\bINC\b|\bCORP|\bCOMPANY\b|\bCO\b|\bLP\b|\bLTD\b|DEVELOP|PROPERTIES|HOMES\b|BUILDERS|INVEST|REALTY|PARTNERS")
    g.loc[g["last_sale"].dt.year < 1900, "last_sale"] = pd.NaT
    now = pd.Timestamp(datetime.now(timezone.utc).date())
    g["years_held"] = ((now - g["last_sale"]).dt.days / 365.25).round(1)
    g["last_sale_year"] = g["last_sale"].dt.year
    g["greenbelt"] = g["use_val"].fillna(0) > 0
    a = g["owner"].map(norm_owner)
    b = g["owner_now"].map(norm_owner)
    g["owner_changed"] = [bool(y) and bool(x) and len(set(x[:2]) & set(y[:2])) == 0 for x, y in zip(a, b)]
    g["land_val_per_ac"] = (g["land_val"] / g["acres"]).round(0)
    g["tpad_url"] = "https://assessment.cot.tn.gov/TPAD/Parcel/GIS?gislink=" + g["gislink"].map(quote)
    g["map_url"] = "https://tnmap.tn.gov/assessment/#/parcel/" + g["gislink"].map(quote)
    g = g.drop(columns=["last_sale"])
    g = g.reset_index(drop=True)
    g["pid"] = np.arange(len(g))
    print(f"candidates: {len(g)}  by county: {g['county'].value_counts().to_dict()}")
    g.to_parquet(CACHE / "parcels.parquet")
    return g


if __name__ == "__main__":
    build()
