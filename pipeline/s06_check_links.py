"""Confirm every listing URL still opens (HTTP 200) so each for-sale entry links to a live listing.

Writes cache/listing_links.json: {listing_id: http_status}. Polite: ~1 request/second.
"""
import json
import time

from config import CACHE
from util import SESSION


def main():
    rows = json.loads((CACHE / "listings.json").read_text())["listings"]
    out_p = CACHE / "listing_links.json"
    done = json.loads(out_p.read_text()) if out_p.exists() else {}
    for k, r in enumerate(rows):
        key = str(r["id"])
        if done.get(key) == 200 or r["has_home"]:
            continue
        try:
            resp = SESSION.get(r["url"], timeout=60, allow_redirects=True)
            done[key] = resp.status_code if r["url"].split("/")[-1] in resp.url else 301
        except Exception:  # noqa: BLE001
            done[key] = 0
        if k % 50 == 0:
            out_p.write_text(json.dumps(done))
            print(f"  checked {k}/{len(rows)}", flush=True)
        time.sleep(1.0)
    out_p.write_text(json.dumps(done))
    bad = {k: v for k, v in done.items() if v != 200}
    print(f"checked {len(done)} listing links; not OK: {len(bad)} {list(bad.items())[:10]}")


if __name__ == "__main__":
    main()
