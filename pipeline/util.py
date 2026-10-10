"""Shared helpers: cached HTTP, ArcGIS paging, small geo utilities."""
import hashlib
import json
import time

import geopandas as gpd
import requests
from shapely.geometry import shape

from config import CACHE

SESSION = requests.Session()
SESSION.headers["User-Agent"] = "LandSearchTN/1.0 (personal retirement land research)"


def http_get(url, params=None, timeout=120, retries=5, method="GET", data=None):
    last = None
    for i in range(retries):
        try:
            if method == "POST":
                r = SESSION.post(url, data=data or params, timeout=timeout)
            else:
                r = SESSION.get(url, params=params, timeout=timeout)
            if r.status_code in (429, 500, 502, 503, 504):
                raise requests.HTTPError(f"{r.status_code}")
            r.raise_for_status()
            return r
        except Exception as e:  # noqa: BLE001 - retry anything transient
            last = e
            time.sleep(2 ** i)
    raise RuntimeError(f"GET failed {url}: {last}")


def cached_json(key, fn):
    """Cache the JSON-serialisable result of fn() under cache/json/<key>.json."""
    d = CACHE / "json"
    d.mkdir(exist_ok=True)
    p = d / f"{key}.json"
    if p.exists():
        return json.loads(p.read_text())
    val = fn()
    p.write_text(json.dumps(val))
    return val


def arcgis_query(layer_url, where="1=1", out_fields="*", geometry=None, extra=None,
                 return_geometry=True, page=2000, cache_key=None):
    """Page through an ArcGIS FeatureServer/MapServer layer, returning a GeoDataFrame (EPSG:4326)."""
    if cache_key is None:
        cache_key = hashlib.md5(json.dumps([layer_url, where, out_fields, geometry, extra]).encode()).hexdigest()
    p = CACHE / "arcgis" / f"{cache_key}.geojson"
    p.parent.mkdir(exist_ok=True)
    if p.exists():
        return gpd.read_file(p)

    base = {"where": where, "outFields": out_fields, "f": "geojson", "outSR": 4326,
            "returnGeometry": "true" if return_geometry else "false"}
    if isinstance(geometry, dict):  # e.g. {"points": [[lon, lat], ...]} multipoint
        base.update({"geometry": json.dumps({**geometry, "spatialReference": {"wkid": 4326}}),
                     "geometryType": "esriGeometryMultipoint" if "points" in geometry else "esriGeometryPolygon",
                     "inSR": 4326, "spatialRel": "esriSpatialRelIntersects"})
    elif geometry is not None:
        base.update({"geometry": ",".join(map(str, geometry)), "geometryType": "esriGeometryEnvelope",
                     "inSR": 4326, "spatialRel": "esriSpatialRelIntersects"})
    if extra:
        base.update(extra)

    # Use object-id paging: robust for services that cap resultRecordCount.
    ids = http_get(f"{layer_url}/query", {**base, "returnIdsOnly": "true", "f": "json"}, method="POST").json()
    oids = sorted(ids.get("objectIds") or [])
    def fetch(ids_chunk):
        """POST the object IDs (no URL-length limit); fall back to short GETs for servers that reject POST."""
        params = {k: v for k, v in base.items() if k not in ("where", "geometry", "geometryType", "inSR", "spatialRel")}
        params["objectIds"] = ",".join(map(str, ids_chunk))
        for attempt in range(3):
            try:
                js = http_get(f"{layer_url}/query", params, method="POST").json()
                if "error" not in js:
                    return js.get("features", [])
            except (ValueError, RuntimeError):
                pass
            time.sleep(3 * (attempt + 1))
        out = []
        for j in range(0, len(ids_chunk), 100):
            params["objectIds"] = ",".join(map(str, ids_chunk[j:j + 100]))
            js = http_get(f"{layer_url}/query", params).json()
            if "error" in js:
                raise RuntimeError(js["error"])
            out.extend(js.get("features", []))
        return out

    feats = []
    for i in range(0, len(oids), page):
        feats.extend(fetch(oids[i:i + page]))
        print(f"  {layer_url.split('/')[-3]}: {len(feats)}/{len(oids)}", flush=True)
    rows = []
    geoms = []
    for f in feats:
        rows.append(f.get("properties") or {})
        g = f.get("geometry")
        geoms.append(shape(g) if g else None)
    gdf = gpd.GeoDataFrame(rows, geometry=geoms, crs="EPSG:4326")
    gdf.to_file(p, driver="GeoJSON")
    return gdf
