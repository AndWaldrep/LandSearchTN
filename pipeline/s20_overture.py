"""Download Overture Maps layers (OSM-derived roads/POIs/land use + ML building footprints)."""
import os
import subprocess

from config import CONTEXT_BBOX, RAW, STUDY_BBOX

os.environ.setdefault("AWS_CA_BUNDLE", os.environ.get("SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt"))

JOBS = {
    "segment": CONTEXT_BBOX,
    "place": CONTEXT_BBOX,
    "infrastructure": CONTEXT_BBOX,
    "land_use": CONTEXT_BBOX,
    "water": CONTEXT_BBOX,
    "building": (STUDY_BBOX[0] - 0.01, STUDY_BBOX[1] - 0.01, STUDY_BBOX[2] + 0.01, STUDY_BBOX[3] + 0.01),
}


def main(types=None):
    for t, bb in JOBS.items():
        if types and t not in types:
            continue
        out = RAW / f"overture_{t}.parquet"
        if out.exists():
            continue
        tmp = out.with_suffix(".tmp.parquet")
        print("downloading", t, flush=True)
        subprocess.run(["overturemaps", "download", f"--bbox={','.join(map(str, bb))}", "-f", "geoparquet",
                        f"--type={t}", "-o", str(tmp)], check=True)
        tmp.rename(out)


if __name__ == "__main__":
    import sys
    main(sys.argv[1:] or None)
