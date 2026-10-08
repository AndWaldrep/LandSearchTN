"""Self-contained basemap for offline/sandboxed hosting (no third-party tile servers).

dashboard/data/basemap/
  relief_region.jpg  – shaded relief + hypsometric tint, regional (incl. the Smokies), web-mercator
  relief_study.jpg   – same at higher resolution over the study area
  slope.png          – LiDAR slope classes (15–25%, 25–40%, >40%) with transparency
  vectors.json       – roads by class, water, city limits, county lines (simplified)
  overlays.json      – FEMA flood zones and NWI wetlands (simplified)
  meta.json          – image bounds
"""
import json

import geopandas as gpd
import numpy as np
import rasterio
from PIL import Image
from rasterio.warp import Resampling, calculate_default_transform, reproject
from scipy import ndimage
from shapely.ops import linemerge, unary_union

from config import CACHE, CONTEXT_BBOX, CRS_M, OUT, RAW, STUDY_BBOX
from util import arcgis_query

BM = OUT / "basemap"
BM.mkdir(exist_ok=True)
COUNTIES = "https://tnmap.tn.gov/arcgis/rest/services/ADMINISTRATIVE_BOUNDARIES/COUNTY_BOUNDARIES_AND_CITY_BOUNDARIES/MapServer/1"

# muted elevation ramp (m): valley sage -> ridge tan -> high-peak stone
RAMP = [(150, (226, 233, 219)), (300, (232, 236, 222)), (450, (236, 231, 214)), (700, (226, 214, 192)),
        (1100, (208, 194, 172)), (1600, (196, 186, 172)), (2100, (230, 228, 224))]


def warp(src_path, bbox, res):
    with rasterio.open(src_path) as src:
        dst_crs = "EPSG:3857"
        from pyproj import Transformer
        t = Transformer.from_crs(4326, 3857, always_xy=True)
        x0, y0 = t.transform(bbox[0], bbox[1])
        x1, y1 = t.transform(bbox[2], bbox[3])
        w, h = int((x1 - x0) / res), int((y1 - y0) / res)
        transform = rasterio.transform.from_bounds(x0, y0, x1, y1, w, h)
        arr = np.full((h, w), np.nan, "float32")
        z = src.read(1).astype("float32")
        z[z <= -9000] = np.nan
        reproject(z, arr, src_transform=src.transform, src_crs=src.crs, dst_transform=transform, dst_crs=dst_crs,
                  resampling=Resampling.bilinear, src_nodata=np.nan, dst_nodata=np.nan)
    lat_mid = (bbox[1] + bbox[3]) / 2
    ground = res * np.cos(np.radians(lat_mid))
    return arr, ground, [[bbox[1], bbox[0]], [bbox[3], bbox[2]]]


def relief(z, ground):
    zf = np.where(np.isnan(z), np.nanmin(z), z)
    dy, dx = np.gradient(zf, ground)
    slope = np.arctan(np.hypot(dx, dy) * 1.6)
    aspect = np.arctan2(-dx, dy)
    shade = np.zeros_like(zf)
    for az, w in ((315, 0.5), (270, 0.25), (360, 0.25)):   # multidirectional
        a = np.radians(az)
        alt = np.radians(42)
        shade += w * (np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(a - aspect))
    shade = np.clip(shade, 0, 1)
    xs = [e for e, _ in RAMP]
    rgb = np.stack([np.interp(zf, xs, [c[k] for _, c in RAMP]) for k in range(3)], axis=-1)
    k = (0.55 + 0.6 * shade)[..., None]
    out = np.clip(rgb * k, 0, 255).astype("uint8")
    return out


def slope_png(z, ground):
    zf = np.where(np.isnan(z), np.nanmean(z), z)
    zf = ndimage.gaussian_filter(zf, 0.6)
    dy, dx = np.gradient(zf, ground)
    s = np.hypot(dx, dy) * 100
    rgba = np.zeros(s.shape + (4,), "uint8")
    for lo, hi, col in ((15, 25, (250, 178, 25, 120)), (25, 40, (236, 131, 90, 150)), (40, 1e9, (208, 59, 59, 170))):
        m = (s >= lo) & (s < hi)
        rgba[m] = col
    return rgba


def to_lines(gdf, tol):
    m = gdf.to_crs(CRS_M)
    geom = linemerge(unary_union(list(m.geometry)))
    return gpd.GeoSeries([geom], crs=CRS_M).simplify(tol).to_crs(4326).iloc[0]


def rnd(o):
    if isinstance(o, float):
        return round(o, 5)
    if isinstance(o, (list, tuple)):
        return [rnd(x) for x in o]
    if isinstance(o, dict):
        return {k: rnd(v) for k, v in o.items()}
    return o


def fc(features):
    return {"type": "FeatureCollection", "features": [rnd(f) for f in features]}


def feature(geom, **props):
    return {"type": "Feature", "properties": props, "geometry": geom.__geo_interface__}


def main():
    meta = {}
    z, g, b = warp(CACHE / "dem30.tif", CONTEXT_BBOX, 45)
    Image.fromarray(relief(z, g)).save(BM / "relief_region.jpg", quality=82, optimize=True)
    meta["relief_region"] = b
    z, g, b = warp(CACHE / "dem10.tif", STUDY_BBOX, 16)
    Image.fromarray(relief(z, g)).save(BM / "relief_study.jpg", quality=80, optimize=True)
    meta["relief_study"] = b
    Image.fromarray(slope_png(z, g), "RGBA").quantize(colors=8, method=Image.Quantize.FASTOCTREE).save(BM / "slope.png", optimize=True)
    meta["slope"] = b

    seg = gpd.read_parquet(RAW / "overture_segment.parquet")
    roads = seg[seg["subtype"] == "road"]
    feats = []
    for cls, tol in (("motorway", 10), ("trunk", 10), ("primary", 10), ("secondary", 8), ("tertiary", 8)):
        feats.append(feature(to_lines(roads[roads["class"] == cls], tol), kind="road", cls=cls))
    x0, y0, x1, y1 = STUDY_BBOX
    local = roads[roads["class"].isin(["residential", "unclassified", "living_street"])].cx[x0:x1, y0:y1]
    feats.append(feature(to_lines(local, 6), kind="road", cls="local"))
    rail = seg[(seg["subtype"] == "rail") & (seg["class"] == "standard_gauge")]
    feats.append(feature(to_lines(rail, 8), kind="rail", cls="rail"))

    water = gpd.read_parquet(RAW / "overture_water.parquet").to_crs(CRS_M)
    wp = water[water.geometry.geom_type.isin(["Polygon", "MultiPolygon"]) &
               water["subtype"].isin(["reservoir", "lake", "river", "water", "pond"])]
    wp = wp[wp.area > 20000]
    wgeom = gpd.GeoSeries([unary_union(list(wp.geometry))], crs=CRS_M).simplify(8).to_crs(4326).iloc[0]
    feats.append(feature(wgeom, kind="water"))
    rivers = water[(water["class"].isin(["river"])) & water.geometry.geom_type.isin(["LineString", "MultiLineString"])]
    if len(rivers):
        feats.append(feature(to_lines(rivers.to_crs(4326), 10), kind="river"))

    cities = gpd.read_parquet(CACHE / "cities.parquet")
    for r in cities.itertuples():
        feats.append(feature(gpd.GeoSeries([r.geometry], crs=4326).to_crs(CRS_M).simplify(15).to_crs(4326).iloc[0].boundary,
                             kind="city", name=r.NAME))
    counties = arcgis_query(COUNTIES, out_fields="COUNTY", geometry=CONTEXT_BBOX, cache_key="counties")
    for r in counties.itertuples():
        geom = gpd.GeoSeries([r.geometry], crs=4326).to_crs(CRS_M).simplify(30).to_crs(4326).iloc[0]
        feats.append(feature(geom.boundary, kind="county", name=r.COUNTY))
    (BM / "vectors.json").write_text(json.dumps(fc(feats), separators=(",", ":")))

    ov = []
    fl = gpd.read_parquet(CACHE / "flood.parquet").to_crs(CRS_M)
    fl = fl[fl.geometry.notna()]
    ov.append(feature(gpd.GeoSeries([unary_union(list(fl.geometry))], crs=CRS_M).simplify(6).to_crs(4326).iloc[0], kind="flood"))
    wt = gpd.read_parquet(CACHE / "wetlands.parquet").to_crs(CRS_M)
    wt = wt[wt.geometry.notna()]
    ov.append(feature(gpd.GeoSeries([unary_union(list(wt.geometry))], crs=CRS_M).simplify(5).to_crs(4326).iloc[0], kind="wetland"))
    (BM / "overlays.json").write_text(json.dumps(fc(ov), separators=(",", ":")))
    (BM / "meta.json").write_text(json.dumps(meta))
    for f in sorted(BM.iterdir()):
        print(f.name, round(f.stat().st_size / 1e6, 2), "MB")


if __name__ == "__main__":
    main()
