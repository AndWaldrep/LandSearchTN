"""Terrain metrics from the LiDAR-derived DEMs.

Per parcel:
  slope stats, buildable area (<=15% slope, outside flood/wetland), largest contiguous pad,
  best house site ("pad point" = highest cell of the usable pad), aspect, elevation, relief,
  topographic position, Smokies/foothill line-of-sight visibility and a 360° skyline.
"""
import numpy as np
import geopandas as gpd
import pandas as pd
import rasterio
from rasterio import features
from scipy import ndimage

from config import CACHE, CRS_M, OUT

BUILD_SLOPE = 15.0   # % – practical limit for a house pad + septic field
STEEP_SLOPE = 30.0
EYE_HEIGHT = 6.0     # m above pad: 2nd-floor window / deck
EARTH_R = 6371000.0
REFRACTION_K = 0.13
HORIZON_AZ_STEP = 5  # degrees
HORIZON_RANGE = 45000.0


def load_dem(path):
    ds = rasterio.open(path)
    z = ds.read(1).astype("float32")
    z[z <= -9000] = np.nan
    return ds, z


def slope_aspect(z, res):
    zf = np.where(np.isnan(z), np.nanmean(z), z)
    # light smoothing removes bilinear-resampling stair steps without flattening real grades
    zf = ndimage.gaussian_filter(zf, 0.7)
    dzdy, dzdx = np.gradient(zf, res)
    slope = np.hypot(dzdx, dzdy) * 100.0
    # rows run north->south: dzdy is d/d(south). Aspect = compass direction of steepest descent.
    aspect = (np.degrees(np.arctan2(-dzdx, dzdy)) + 360.0) % 360.0
    return slope.astype("float32"), aspect.astype("float32")


def mountain_targets(ds30, z30):
    """Pick sample points along the Smokies crest (>=1200 m) and the foothills (700-1200 m)."""
    res = ds30.res[0]
    rows, cols = np.indices(z30.shape)
    # only mountains to the south/east of the study area (Smokies, Chilhowee, Unicoi foothills)
    from pyproj import Transformer
    t = Transformer.from_crs(CRS_M, 4326, always_xy=True)
    X, Y = rasterio.transform.xy(ds30.transform, rows.ravel()[::1], cols.ravel()[::1])
    lon, lat = t.transform(np.array(X), np.array(Y))
    lon = lon.reshape(z30.shape)
    lat = lat.reshape(z30.shape)
    lon_mask = (lon > -84.35) & (lat < 35.90) & ~((lon < -84.0) & (lat > 35.75))
    zz = np.where(np.isnan(z30), 0, z30)
    peak = (zz == ndimage.maximum_filter(zz, size=int(1500 / res))) & lon_mask

    def thin(mask, cell):
        r, c = np.nonzero(mask)
        e = zz[r, c]
        key = (r * res // cell).astype(int) * 100000 + (c * res // cell).astype(int)
        order = np.argsort(-e)
        _, first = np.unique(key[order], return_index=True)
        sel = order[first]
        return r[sel], c[sel]

    crest = thin(peak & (zz >= 1200), 2500)
    foot = thin(peak & (zz >= 650) & (zz < 1200), 3000)
    out = []
    for kind, (r, c) in (("crest", crest), ("foothills", foot)):
        x, y = rasterio.transform.xy(ds30.transform, r, c)
        lo, la = t.transform(np.array(x), np.array(y))
        for xi, yi, zi, a, b in zip(x, y, zz[r, c], lo, la):
            out.append({"kind": kind, "x": xi, "y": yi, "z": float(zi), "lon": a, "lat": b})
    df = pd.DataFrame(out)
    print("view targets:", df["kind"].value_counts().to_dict())
    return df


def bilinear(z, ds, x, y):
    inv = ~ds.transform
    c, r = inv * (x, y)
    return ndimage.map_coordinates(z, [r - 0.5, c - 0.5], order=1, mode="nearest", prefilter=False)


def views(pads, ds30, z30, targets):
    zfill = np.where(np.isnan(z30), 0, z30).astype("float32")
    n = len(pads)
    S = 900
    tt = np.linspace(0.0, 1.0, S + 1)[1:-1]
    tx, ty, tz = targets["x"].values, targets["y"].values, targets["z"].values
    kinds = targets["kind"].values
    vis = np.zeros((n, len(targets)), bool)
    azs = np.arange(0, 360, HORIZON_AZ_STEP)
    horizon = np.zeros((n, len(azs)), "int16")
    hd = np.linspace(60, HORIZON_RANGE, 700)
    ox_all, oy_all, oz_all = pads["pad_x"].values, pads["pad_y"].values, pads["pad_z"].values + EYE_HEIGHT

    def drop(d):
        return d * d * (1 - REFRACTION_K) / (2 * EARTH_R)

    for i in range(n):
        ox, oy, oz = ox_all[i], oy_all[i], oz_all[i]
        dx, dy = tx - ox, ty - oy
        D = np.hypot(dx, dy)
        sx = ox + dx[:, None] * tt[None, :]
        sy = oy + dy[:, None] * tt[None, :]
        d = D[:, None] * tt[None, :]
        h = bilinear(zfill, ds30, sx.ravel(), sy.ravel()).reshape(sx.shape)
        ang = (h - drop(d) - oz) / np.maximum(d, 1)
        # ignore samples within 250 m of the target (its own shoulder) and the first 40 m
        valid = (d > 40) & ((D[:, None] - d) > 250)
        amax = np.where(valid, ang, -np.inf).max(axis=1)
        at = (tz - drop(D) - oz) / D
        vis[i] = at > amax
        # skyline
        a = np.radians(azs)
        hx = ox + np.sin(a)[:, None] * hd[None, :]
        hy = oy + np.cos(a)[:, None] * hd[None, :]
        hh = bilinear(zfill, ds30, hx.ravel(), hy.ravel()).reshape(hx.shape)
        hang = np.degrees(np.arctan((hh - drop(hd)[None, :] - oz) / hd[None, :])).max(axis=1)
        horizon[i] = np.clip(np.round(hang * 10), -900, 900)
        if i % 2000 == 0:
            print(f"  views {i}/{n}", flush=True)
    crest = kinds == "crest"
    foot = kinds == "foothills"
    res = pd.DataFrame(index=pads.index)
    res["view_smokies"] = (vis[:, crest].mean(axis=1) * 100).round(1)
    res["view_foothills"] = (vis[:, foot].mean(axis=1) * 100).round(1)
    dist = np.hypot(tx[None, :] - ox_all[:, None], ty[None, :] - oy_all[:, None]) / 1000
    dist = np.where(vis, dist, np.inf)
    res["view_dist_km"] = np.where(np.isfinite(dist.min(axis=1)), dist.min(axis=1).round(1), np.nan)
    res["view_n_peaks"] = vis.sum(axis=1)
    return res, horizon


def main():
    parcels = gpd.read_parquet(CACHE / "parcels.parquet").to_crs(CRS_M)
    ds, z = load_dem(CACHE / "dem10.tif")
    res = ds.res[0]
    slope, aspect = slope_aspect(z, res)
    shape = z.shape
    labels = features.rasterize(((g, i + 1) for i, g in enumerate(parcels.geometry)), out_shape=shape,
                                transform=ds.transform, fill=0, dtype="int32", all_touched=False)
    # Tiny parcels may not cover any cell centre – fall back to all_touched for those.
    present = np.zeros(len(parcels) + 1, bool)
    present[np.unique(labels)] = True
    missing = [i for i in range(len(parcels)) if not present[i + 1]]
    if missing:
        extra = features.rasterize(((parcels.geometry.iloc[i], i + 1) for i in missing), out_shape=shape,
                                   transform=ds.transform, fill=0, dtype="int32", all_touched=True)
        labels = np.where((labels == 0) & (extra > 0), extra, labels)

    def mask_of(path):
        g = gpd.read_parquet(path).to_crs(CRS_M)
        g = g[g.geometry.notna()]
        return features.rasterize(((geom, 1) for geom in g.geometry), out_shape=shape, transform=ds.transform,
                                  fill=0, dtype="uint8").astype(bool)

    flood = mask_of(CACHE / "flood.parquet")
    wet = mask_of(CACHE / "wetlands.parquet")
    buildable = (slope <= BUILD_SLOPE) & ~flood & ~wet & ~np.isnan(z)

    zfill = np.where(np.isnan(z), np.nanmean(z), z)
    mean500 = ndimage.uniform_filter(zfill, size=int(1000 / res) + 1)
    cell_ac = res * res / 4046.8564

    rows = []
    objs = ndimage.find_objects(labels)
    for i, sl in enumerate(objs):
        rec = {"pid": int(parcels["pid"].iloc[i])}
        if sl is None:
            rows.append(rec)
            continue
        m = labels[sl] == i + 1
        s = slope[sl][m]
        e = z[sl][m]
        n = m.sum()
        b = buildable[sl] & m
        rec.update({
            "slope_mean": float(np.round(s.mean(), 1)),
            "slope_p90": float(np.round(np.percentile(s, 90), 1)),
            "steep_pct": float(np.round((s > STEEP_SLOPE).mean() * 100, 1)),
            "build_pct": float(np.round(b.sum() / n * 100, 1)),
            "build_ac": float(np.round(b.sum() * cell_ac, 2)),
            "flood_pct": float(np.round((flood[sl] & m).sum() / n * 100, 1)),
            "wetland_pct": float(np.round((wet[sl] & m).sum() / n * 100, 1)),
            "relief_ft": float(np.round((np.nanmax(e) - np.nanmin(e)) * 3.2808)),
        })
        lab, nlab = ndimage.label(b)
        if nlab:
            sizes = ndimage.sum(b, lab, index=np.arange(1, nlab + 1))
            big = np.argmax(sizes) + 1
            rec["pad_ac"] = float(np.round(sizes.max() * cell_ac, 2))
            # usable pads: >= 0.15 ac; house site = highest point among them (views, drainage)
            ok = np.isin(lab, np.nonzero(sizes * cell_ac >= 0.15)[0] + 1)
            if not ok.any():
                ok = lab == big
            zz = np.where(ok, z[sl], -np.inf)
            rr, cc = np.unravel_index(np.nanargmax(zz), zz.shape)
            asp = aspect[sl][b]
            sl_b = slope[sl][b]
        else:
            rec["pad_ac"] = 0.0
            ss = np.where(m, slope[sl], np.inf)
            rr, cc = np.unravel_index(np.argmin(ss), ss.shape)
            asp = aspect[sl][m]
            sl_b = slope[sl][m]
        r0, c0 = sl[0].start + rr, sl[1].start + cc
        x, y = rasterio.transform.xy(ds.transform, r0, c0)
        rec["pad_x"], rec["pad_y"] = x, y
        rec["pad_z"] = float(z[r0, c0])
        rec["elev_ft"] = float(np.round(z[r0, c0] * 3.2808))
        rec["pad_slope"] = float(np.round(slope[r0, c0], 1))
        rec["tpi_m"] = float(np.round(z[r0, c0] - mean500[r0, c0], 1))
        # dominant aspect weighted by slope (flat ground has no meaningful aspect)
        w = np.clip(sl_b, 0, 40)
        if w.sum() > 0 and np.mean(sl_b) >= 3:
            a = np.radians(asp)
            mean_a = (np.degrees(np.arctan2((np.sin(a) * w).sum(), (np.cos(a) * w).sum())) + 360) % 360
            rec["aspect_deg"] = float(np.round(mean_a))
            rec["aspect"] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][int(((mean_a + 22.5) % 360) // 45)]
        else:
            rec["aspect_deg"] = None
            rec["aspect"] = "Flat"
        rows.append(rec)
        if i % 2000 == 0:
            print(f"  terrain {i}/{len(objs)}", flush=True)
    t = pd.DataFrame(rows)
    # parcels whose rasterisation failed entirely – use centroid
    miss = t["pad_x"].isna()
    if miss.any():
        cen = parcels.geometry.centroid
        t.loc[miss, "pad_x"] = cen.x[miss.values].values
        t.loc[miss, "pad_y"] = cen.y[miss.values].values
        zz = bilinear(zfill, ds, t.loc[miss, "pad_x"].values, t.loc[miss, "pad_y"].values)
        t.loc[miss, "pad_z"] = zz
        t.loc[miss, "elev_ft"] = np.round(zz * 3.2808)

    ds30, z30 = load_dem(CACHE / "dem30.tif")
    targets = mountain_targets(ds30, z30)
    targets.to_csv(CACHE / "view_targets.csv", index=False)
    v, horizon = views(t, ds30, z30, targets)
    t = pd.concat([t, v], axis=1)
    t.to_parquet(CACHE / "terrain.parquet")
    np.save(CACHE / "horizon.npy", horizon)
    print(t.describe().T[["mean", "50%", "min", "max"]].round(1).to_string())


if __name__ == "__main__":
    main()
