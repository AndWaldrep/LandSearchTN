"""Active land-for-sale listings from LandSearch.com (robots.txt allows crawling).

Reads the county result pages (50 listings per page), keeps the listing id, URL, asking price,
acreage, map point, status and listing date. Run politely: one request every ~2 s, cached per page.
Listings are re-fetched on every run unless --cached is given, because they change daily.
"""
import html
import json
import re
import sys
import time
from datetime import date

from config import CACHE
from util import SESSION

COUNTIES = ["blount-county-tn", "loudon-county-tn", "monroe-county-tn"]
BASE = "https://www.landsearch.com/properties/{slug}{page}"


def fetch(slug, page, use_cache):
    p = CACHE / "listings" / f"{slug}_{page}.html"
    p.parent.mkdir(parents=True, exist_ok=True)
    if use_cache and p.exists():
        return p.read_text()
    url = BASE.format(slug=slug, page="" if page == 1 else f"/p{page}")
    for attempt in range(4):
        r = SESSION.get(url, timeout=60)
        if r.status_code == 200:
            break
        time.sleep(5 * (attempt + 1))
    r.raise_for_status()
    p.write_text(r.text)
    time.sleep(2)
    return r.text


def parse(h):
    m = re.search(r'data-id="properties" data-value="([^"]+)"', h)
    return json.loads(html.unescape(m.group(1))) if m else {"results": [], "total_pages": 0}


def main(use_cache=False):
    out = {}
    for slug in COUNTIES:
        first = parse(fetch(slug, 1, use_cache))
        pages = first.get("total_pages", 1)
        res = list(first["results"])
        for pg in range(2, pages + 1):
            res += parse(fetch(slug, pg, use_cache))["results"]
        print(f"{slug}: {len(res)} listings over {pages} pages (site total {first.get('total')})", flush=True)
        for r in res:
            ctx = r.get("context") or {}
            c = ctx.get("center") or [None, None]
            out[r["id"]] = {
                "id": r["id"],
                "url": "https://www.landsearch.com" + r["path"],
                "title": r.get("title", ""),
                "price": r.get("price"),
                "acres": r.get("size"),
                "lon": c[0], "lat": c[1],
                "precision": ctx.get("precision", ""),
                "status": r.get("status", ""),
                "listed_at": (r.get("listed_at") or "")[:10],
                "has_home": bool(r.get("structure")),
                "county": ((r.get("location") or {}).get("subterritory") or {}).get("name", ""),
                "locality": ((r.get("location") or {}).get("locality") or {}).get("name", ""),
            }
    rows = [v for v in out.values() if v["lat"] is not None]
    (CACHE / "listings.json").write_text(json.dumps({"fetched": date.today().isoformat(), "listings": rows}))
    print("unique listings with coordinates:", len(rows),
          "| with home:", sum(r["has_home"] for r in rows),
          "| status:", {s: sum(r["status"] == s for r in rows) for s in {r["status"] for r in rows}})


if __name__ == "__main__":
    main(use_cache="--cached" in sys.argv)
