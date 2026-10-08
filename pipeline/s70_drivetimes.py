"""Drive times (minutes, free-flow) from each house site to towns, hospitals, groceries and key places.

Uses the public OSRM demo server (OpenStreetMap road network). Requests are batched (<=100 coordinates),
throttled to ~1/s, and cached so reruns are cheap.
"""
import time

import geopandas as gpd
import numpy as np
import pandas as pd
from pyproj import Transformer
from scipy.spatial import cKDTree

from config import CACHE, CRS_M, HOSPITALS, KEY_DESTS, OSRM_URL, TOWNS
from util import cached_json, http_get

BATCH = 70


def table(src, dst, key):
    """src/dst: lists of (lon, lat). Returns minutes matrix [len(src), len(dst)]."""
    def go():
        coords = ";".join(f"{x:.5f},{y:.5f}" for x, y in list(src) + list(dst))
        n = len(src)
        url = (f"{OSRM_URL}/table/v1/driving/{coords}?sources={';'.join(map(str, range(n)))}"
               f"&destinations={';'.join(map(str, range(n, n + len(dst))))}&annotations=duration")
        js = http_get(url, timeout=120).json()
        if js.get("code") != "Ok":
            raise RuntimeError(js)
        time.sleep(1.0)
        return js["durations"]
    d = cached_json(f"osrm_{key}", go)
    return np.array([[np.nan if v is None else v / 60 for v in row] for row in d])


def clean_groceries():
    g = gpd.read_parquet(CACHE / "groceries.parquet")
    g = g[~g["nm"].str.contains("ingleside|money|school|pool|tennis", case=False)].to_crs(CRS_M)
    xy = np.c_[g.geometry.x, g.geometry.y]
    keep, used = [], np.zeros(len(g), bool)
    tree = cKDTree(xy)
    for i in range(len(g)):
        if used[i]:
            continue
        used[tree.query_ball_point(xy[i], 200)] = True
        keep.append(i)
    g = g.iloc[keep].to_crs(4326)
    print("grocery stores:", len(g))
    return g


def main():
    terr = pd.read_parquet(CACHE / "terrain.parquet")
    t = Transformer.from_crs(CRS_M, 4326, always_xy=True)
    lon, lat = t.transform(terr["pad_x"].values, terr["pad_y"].values)
    pids = terr["pid"].values
    # spatially coherent ordering so batches share nearby destinations
    order = np.lexsort((np.round(lon / 0.03), np.round(lat / 0.03)))

    fixed = [(f"town:{k}", (v[1], v[0])) for k, v in TOWNS.items()]
    fixed += [(f"key:{k}", (v[1][1], v[1][0])) for k, v in KEY_DESTS.items()]
    fixed += [(f"hosp:{i}", (h[2][1], h[2][0])) for i, h in enumerate(HOSPITALS)]
    fnames = [f[0] for f in fixed]
    fcoords = [f[1] for f in fixed]

    groc = clean_groceries()
    gxy = np.c_[groc.geometry.x, groc.geometry.y]
    gtree = cKDTree(gxy * [np.cos(np.radians(35.75)), 1])
    _, gnear = gtree.query(np.c_[lon * np.cos(np.radians(35.75)), lat], k=3)

    res_fixed = np.full((len(pids), len(fixed)), np.nan)
    res_groc = np.full(len(pids), np.nan)
    nb = int(np.ceil(len(order) / BATCH))
    for b in range(nb):
        idx = order[b * BATCH:(b + 1) * BATCH]
        src = list(zip(lon[idx], lat[idx]))
        res_fixed[idx] = table(src, fcoords, f"fixed_v1_{b}")
        cand = np.unique(gnear[idx].ravel())
        m = table(src, [tuple(gxy[c]) for c in cand], f"groc_v1_{b}")
        res_groc[idx] = np.nanmin(m, axis=1)
        if b % 20 == 0:
            print(f"  osrm batch {b}/{nb}", flush=True)

    df = pd.DataFrame({"pid": pids})
    F = pd.DataFrame(res_fixed, columns=fnames)
    towns = [c for c in fnames if c.startswith("town:")]
    df["dt_town_min"] = F[towns].min(axis=1).round(1)
    df["nearest_town"] = F[towns].idxmin(axis=1).str.replace("town:", "")
    for k in KEY_DESTS:
        df[f"dt_{k}_min"] = F[f"key:{k}"].round(1)
    ed = [f"hosp:{i}" for i, h in enumerate(HOSPITALS) if "ed" in h[3]]
    tr = [f"hosp:{i}" for i, h in enumerate(HOSPITALS) if "trauma" in h[3]]
    st = [f"hosp:{i}" for i, h in enumerate(HOSPITALS) if "stroke" in h[3]]
    df["dt_ed_min"] = F[ed].min(axis=1).round(1)
    df["nearest_ed"] = F[ed].idxmin(axis=1).map(lambda c: HOSPITALS[int(c.split(":")[1])][0])
    df["dt_trauma_min"] = F[tr].min(axis=1).round(1)
    df["dt_stroke_min"] = F[st].min(axis=1).round(1)
    df["dt_grocery_min"] = np.round(res_groc, 1)
    df.to_parquet(CACHE / "drivetimes.parquet")
    print(df.describe().round(1).to_string())
    print(df["nearest_ed"].value_counts().to_dict())


if __name__ == "__main__":
    main()
