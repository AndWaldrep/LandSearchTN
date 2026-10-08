"""Download LiDAR-derived bare-earth DEMs from the USGS 3DEP elevation service.

* dem10.tif – 10 m grid over the study area (resampled from 3DEP 1 m / 1/3" LiDAR DEMs) for
  slope, aspect, buildable pads and topographic position.
* dem30.tif – 30 m grid over the wider region incl. the Smokies crest, for line-of-sight views.
"""
import io

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.merge import merge

from config import CACHE, CONTEXT_BBOX, CRS_M, STUDY_BBOX
from util import http_get

URL = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage"
EPSG = int(CRS_M.split(":")[1])


def to_m(bbox, pad=0):
    t = Transformer.from_crs(4326, EPSG, always_xy=True)
    xs, ys = t.transform([bbox[0], bbox[2], bbox[0], bbox[2]], [bbox[1], bbox[1], bbox[3], bbox[3]])
    return min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad


def fetch(bbox_m, res, out, tile_px=2000):
    if out.exists():
        return out
    x0, y0, x1, y1 = bbox_m
    step = tile_px * res
    tiles = []
    xs = np.arange(x0, x1, step)
    ys = np.arange(y0, y1, step)
    for i, tx in enumerate(xs):
        for j, ty in enumerate(ys):
            bx = (tx, ty, min(tx + step, x1), min(ty + step, y1))
            w = int(round((bx[2] - bx[0]) / res))
            h = int(round((bx[3] - bx[1]) / res))
            params = {"bbox": ",".join(f"{v:.2f}" for v in bx), "bboxSR": EPSG, "imageSR": EPSG,
                      "size": f"{w},{h}", "format": "tiff", "pixelType": "F32", "noData": -9999,
                      "interpolation": "RSP_BilinearInterpolation", "f": "image"}
            r = http_get(URL, params, timeout=300)
            ds = rasterio.open(io.BytesIO(r.content))
            mem = rasterio.io.MemoryFile()
            prof = ds.profile
            arr = ds.read(1)
            with mem.open(**prof) as dst:
                dst.write(arr, 1)
            tiles.append(mem)
            print(f"  {out.name} tile {i},{j} {w}x{h} min={np.nanmin(arr):.0f} max={np.nanmax(arr):.0f}", flush=True)
    srcs = [m.open() for m in tiles]
    mosaic, transform = merge(srcs, res=res, nodata=-9999)
    prof = srcs[0].profile
    prof.update(height=mosaic.shape[1], width=mosaic.shape[2], transform=transform, compress="deflate",
                tiled=True, nodata=-9999, crs=f"EPSG:{EPSG}")
    with rasterio.open(out, "w", **prof) as dst:
        dst.write(mosaic)
    return out


def main():
    fetch(to_m(STUDY_BBOX, pad=1500), 10, CACHE / "dem10.tif")
    fetch(to_m(CONTEXT_BBOX), 30, CACHE / "dem30.tif")


if __name__ == "__main__":
    main()
