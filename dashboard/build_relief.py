"""Render the topographic base maps for topo.html.

Paper-style contour maps (no data on them): one of South America and one around each site.
The heat bands are drawn live in the browser on top of these, from current PI values.

Elevation comes from the AWS Terrain Tiles open dataset (Terrarium encoding, built from SRTM,
GMTED, ETOPO1 and other public sources), downloaded once into a cache folder.

    python dashboard/build_relief.py                  # all images
    python dashboard/build_relief.py --only NQN BAR   # just these sites

Writes dashboard/img/topo/*.jpg and dashboard/data/relief.js. Needs numpy and Pillow.
"""
import argparse, json, math, os, urllib.request
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.join(HERE, "img", "topo")
TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"

CONTINENT = dict(z=5, box=(-82.5, 13.5, -33.5, -56.5), exag=10, step=500, smooth=1.5)
SITE = dict(z=11, side=1800, exag=3.0, step=60, smooth=2.5)

# Signal design system: land is surface-muted (shaded by the hillshade), water is the surface,
# contours in ink-subtle, the coast in the axis grey
PAPER_DARK, PAPER_LIGHT, SEA = (222, 225, 230), (246, 247, 249), (255, 255, 255)
INK, COAST = (99, 107, 120), (137, 146, 158)


def load_js(path):
    s = open(path, encoding="utf-8").read()
    return json.loads(s[s.index("=") + 1:].strip().rstrip(";"))


# ------------------------------------------------------------------ Web Mercator pixels
def gx(lon, z): return (lon + 180) / 360 * 2 ** z * 256
def gy(lat, z):
    r = math.radians(lat)
    return (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** z * 256
def lat_of(py, z):
    return math.degrees(math.atan(math.sinh(math.pi - 2 * math.pi * py / (2 ** z * 256))))


def tile(cache, z, x, y):
    f = os.path.join(cache, f"{z}_{x}_{y}.png")
    if not os.path.exists(f):
        data = urllib.request.urlopen(TILE_URL.format(z=z, x=x, y=y), timeout=60).read()
        open(f, "wb").write(data)
    a = np.asarray(Image.open(f).convert("RGB"), dtype=np.float64)
    return a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768


def mosaic(cache, z, px0, py0, w, h):
    """Elevation (m) for the pixel window starting at global pixel (px0, py0)."""
    tx0, ty0, tx1, ty1 = int(px0 // 256), int(py0 // 256), int((px0 + w) // 256), int((py0 + h) // 256)
    big = np.vstack([np.hstack([tile(cache, z, x, y) for x in range(tx0, tx1 + 1)]) for y in range(ty0, ty1 + 1)])
    ox, oy = int(px0) - tx0 * 256, int(py0) - ty0 * 256
    return big[oy:oy + h, ox:ox + w]


# ------------------------------------------------------------------ rendering
def blur(a, r):
    k = np.arange(-int(3 * r) - 1, int(3 * r) + 2)
    g = np.exp(-k ** 2 / (2 * r * r)); g /= g.sum()
    conv = lambda v: np.convolve(np.pad(v, len(k) // 2, mode="edge"), g, "valid")
    return np.apply_along_axis(conv, 0, np.apply_along_axis(conv, 1, a))


def hillshade(e, z, py0, exag):
    lats = np.array([lat_of(py0 + i, z) for i in range(e.shape[0])])
    cell = 156543.03392 / 2 ** z * np.cos(np.radians(lats))[:, None]
    dzdy, dzdx = np.gradient(e * exag)
    dzdx, dzdy = dzdx / cell, dzdy / cell
    slope, aspect = np.arctan(np.hypot(dzdx, dzdy)), np.arctan2(-dzdx, dzdy)
    out = np.zeros_like(e)
    for az, wgt in ((315, .5), (270, .25), (360, .25)):     # multi-directional: soft and readable
        a, zen = math.radians(az), math.radians(45)
        out += wgt * (np.cos(zen) * np.cos(slope) + np.sin(zen) * np.sin(slope) * np.cos(a - aspect))
    return np.clip(out, 0, 1)


def edges(levels):
    m = np.zeros(levels.shape, bool)
    m[:, 1:] |= levels[:, 1:] != levels[:, :-1]
    m[1:, :] |= levels[1:, :] != levels[:-1, :]
    return m


def topo(e, hs, step, smooth):
    # smoothed land mask: raw elevation around 0 m (lakes, tidal flats) is noisy and gives a jagged coast
    land = blur(e, max(1.0, smooth)) > 0
    paper = np.empty(e.shape + (3,))
    for c in range(3):
        paper[..., c] = np.where(land, PAPER_DARK[c] + (PAPER_LIGHT[c] - PAPER_DARK[c]) * hs, SEA[c])
    es = np.sqrt(np.maximum(blur(np.maximum(e, 0), smooth), 0) / step)
    # levels get closer together low down, so plains and foothills show structure too
    minor, major = edges(np.floor(es * 6)) & land, edges(np.floor(es * 1.5)) & land
    ink = np.array(INK, float)
    paper[minor] = paper[minor] * 0.72 + ink * 0.28
    paper[major] = paper[major] * 0.4 + ink * 0.6
    paper[edges(land)] = COAST
    return paper


def render(cache, z, px0, py0, w, h, exag, step, smooth, name):
    e = mosaic(cache, z, px0, py0, w, h)
    img = topo(e, hillshade(e, z, py0, exag), step, smooth)
    Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(os.path.join(IMG, name), quality=84, optimize=True, progressive=True)
    print(f"  {name}: {w}x{h} px at zoom {z}")
    return {"img": f"img/topo/{name}", "z": z, "x0": px0, "y0": py0, "w": w, "h": h}


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--only", nargs="*", help="site codes to render (default: continent and all sites)")
    ap.add_argument("--cache", default=os.path.join(HERE, "..", "out", "terrain-tiles"), help="tile cache folder")
    a = ap.parse_args()
    os.makedirs(IMG, exist_ok=True); os.makedirs(a.cache, exist_ok=True)
    model = load_js(os.path.join(HERE, "data", "model.js"))
    out_js = os.path.join(HERE, "data", "relief.js")
    relief = load_js(out_js) if os.path.exists(out_js) else {"sites": {}}

    if not a.only:
        c = CONTINENT; lon0, lat0, lon1, lat1 = c["box"]; z = c["z"]
        px0, py0 = int(gx(lon0, z)), int(gy(lat0, z))
        relief["continent"] = render(a.cache, z, px0, py0, int(gx(lon1, z)) - px0, int(gy(lat1, z)) - py0,
                                     c["exag"], c["step"], c["smooth"], "continent.jpg")
    for s in model["sites"]:
        if a.only and s["code"] not in a.only:
            continue
        z, side = SITE["z"], SITE["side"]
        xs = [gx(p["lon"], z) for p in [s] + s["wells"]]; ys = [gy(p["lat"], z) for p in [s] + s["wells"]]
        cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
        relief["sites"][s["code"]] = render(a.cache, z, int(cx - side / 2), int(cy - side / 2), side, side,
                                            SITE["exag"], SITE["step"], SITE["smooth"], f"site_{s['code']}.jpg")

    with open(out_js, "w", encoding="utf-8") as f:
        f.write("// generated by dashboard/build_relief.py (elevation: AWS Terrain Tiles open data)\n")
        f.write("window.CP_RELIEF = " + json.dumps(relief, indent=1) + ";\n")
    print(f"wrote {os.path.relpath(out_js)}")


if __name__ == "__main__":
    main()
