"""Bundle the dashboard into one self-contained HTML page for sandboxed hosting (claude.ai Artifacts).

Inlines Leaflet's CSS, the app CSS and the four JS modules; data files stay as relative fetches.
Usage: python3 tools/build_artifact.py OUT_DIR
"""
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DASH = ROOT / "dashboard"
LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
LEAFLET_JS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js"
LAYERS_ICON = ("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='26' height='26' viewBox='0 0 26 26'%3E"
               "%3Cg fill='none' stroke='%23555' stroke-width='1.6' stroke-linejoin='round'%3E%3Cpath d='M13 4 3 9l10 5 10-5z'/%3E"
               "%3Cpath d='m3 13 10 5 10-5M3 17l10 5 10-5'/%3E%3C/g%3E%3C/svg%3E")


def main(out):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    cache = ROOT / "pipeline" / "cache" / "leaflet.css"
    if not cache.exists():
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(urllib.request.urlopen(LEAFLET_CSS).read())
    lcss = cache.read_text()
    lcss = re.sub(r"url\(images/layers(-2x)?\.png\)", f'url("{LAYERS_ICON}")', lcss)
    lcss += "\n.leaflet-control-layers-toggle{background-size:26px 26px}\n"
    acss = (DASH / "css" / "app.css").read_text()

    js = []
    for name in ["scoring.js", "presets.js", "maplayer.js", "app.js"]:
        src = (DASH / "js" / name).read_text()
        src = re.sub(r"^import .*? from .*?;\n", "", src, flags=re.M)
        src = re.sub(r"^export (const|function|async function|let|class) ", r"\1 ", src, flags=re.M)
        js.append(f"// ---- {name} ----\n{src}")
    bundle = "\n".join(js).replace("</script", "<\\/script")

    html = (DASH / "index.html").read_text()
    title = re.search(r"<title>.*?</title>", html).group(0)
    body = re.search(r"<body>(.*)</body>", html, re.S).group(1)
    body = re.sub(r'<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>\s*', "", body)
    body = re.sub(r'<script type="module" src="js/app.js"></script>\s*', "", body)
    page = f"""{title}
<meta name="description" content="Retirement build-site finder for Loudon, Blount and north Monroe counties, Tennessee.">
<style>
{lcss}
</style>
<style>
{acss}
</style>
{body.strip()}
<script src="{LEAFLET_JS}"></script>
<script>window.LSTN_OFFLINE = true;</script>
<script type="module">
{bundle}
</script>
"""
    (out / "index.html").write_text(page)
    import base64
    (out / "horizon.b64.txt").write_text(base64.b64encode((DASH / "data" / "horizon.bin").read_bytes()).decode())
    print("wrote", out / "index.html", round(len(page) / 1e3), "KB")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ROOT / "build" / "artifact")
