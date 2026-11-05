#!/usr/bin/env python3
"""Build the embedded data files used by earth/index.html.

Downloads three npm packages (texture images and star catalogues), processes
them and writes two JavaScript files that carry everything as data: URIs, so
the page also works when opened straight from disk (file://), where WebGL
refuses to read images loaded from other files.

    python3 earth/tools/build_assets.py [--cache DIR]

Outputs
    earth/assets/earth-textures.js   window.EARTH_TEXTURES = {...}
    earth/assets/sky-data.js         window.SKY_DATA = {...}

Requires Pillow, numpy and opencc-python-reimplemented (traditional ->
simplified Chinese for constellation names).

Sources
    three-globe 2.45.6 (MIT)   example/img/earth-blue-marble.jpg, earth-night.jpg,
                               earth-topology.png, earth-water.png,
                               example/clouds/clouds.png
                               (derived from NASA Visible Earth Blue Marble /
                               Black Marble imagery, public domain)
    globe.gl 2.46.2 (MIT)      example/moon-landing-sites/lunar_surface.jpg
                               (NASA / LRO imagery, public domain)
    d3-celestial 0.7.35 (BSD)  data/stars.8.json (Hipparcos, to V = 8),
                               starnames.json, constellations.json,
                               constellations.lines.json, mw.json (Milky Way)
"""
import argparse
import base64
import io
import json
import math
import os
import struct
import sys
import tarfile
import urllib.request

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "assets")

PACKAGES = {
    "three-globe": "2.45.6",
    "globe.gl": "2.46.2",
    "d3-celestial": "0.7.35",
}

Image.MAX_IMAGE_PIXELS = None


def fetch(cache, name, version):
    """Download and unpack an npm tarball into cache/name, return its root."""
    root = os.path.join(cache, name)
    pkg = os.path.join(root, "package")
    if os.path.isdir(pkg):
        return pkg
    os.makedirs(root, exist_ok=True)
    url = f"https://registry.npmjs.org/{name}/-/{name.split('/')[-1]}-{version}.tgz"
    print("download", url)
    with urllib.request.urlopen(url) as r:
        data = r.read()
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as t:
        for m in t.getmembers():
            if not m.isfile():
                continue
            target = os.path.normpath(os.path.join(root, m.name))
            if not target.startswith(root + os.sep):  # refuse path traversal
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with t.extractfile(m) as src, open(target, "wb") as dst:
                dst.write(src.read())
    return pkg


def to_data_uri(img, fmt="JPEG", **kw):
    buf = io.BytesIO()
    img.save(buf, fmt, **kw)
    mime = "image/jpeg" if fmt == "JPEG" else "image/png"
    raw = buf.getvalue()
    print(f"  {img.size[0]}x{img.size[1]} {img.mode} {fmt}: {len(raw) / 1024:.0f} KB")
    return f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")


def build_textures(globe, globegl):
    img = os.path.join(globe, "example", "img")
    tex = {}

    print("day (Blue Marble)")
    day = Image.open(os.path.join(img, "earth-blue-marble.jpg")).convert("RGB")
    tex["day"] = to_data_uri(day, quality=80, optimize=True, progressive=True)

    print("city lights (Black Marble, warm channel only)")
    night = np.asarray(Image.open(os.path.join(img, "earth-night.jpg")).convert("RGB")).astype(np.float32)
    r, g, b = night[..., 0], night[..., 1], night[..., 2]
    # The source image paints the unlit ground in dark blue; city light is
    # sodium/LED orange-white, so keep only light that is warmer than blue.
    lights = np.clip(r - 0.55 * g - 0.15 * b, 0, None)
    lights = lights / np.percentile(lights[lights > 0], 99.7)
    lights = np.clip(lights, 0, 1) ** 0.8
    tex["lights"] = to_data_uri(Image.fromarray((lights * 255).astype(np.uint8), "L"),
                                quality=82, optimize=True)

    print("clouds")
    clouds = Image.open(os.path.join(globe, "example", "clouds", "clouds.png")).convert("RGBA")
    tex["clouds"] = to_data_uri(clouds.getchannel("A"), quality=70, optimize=True)

    print("relief (topology)")
    topo = Image.open(os.path.join(img, "earth-topology.png")).convert("L")
    tex["relief"] = to_data_uri(topo, quality=92, optimize=True)

    print("water mask")
    water = Image.open(os.path.join(img, "earth-water.png")).convert("L").resize((2048, 1024), Image.LANCZOS)
    # A 1-bit mask is enough: bilinear filtering on the GPU softens the coast.
    water = water.point(lambda v: 255 if v > 127 else 0).convert("1")
    tex["water"] = to_data_uri(water, "PNG", optimize=True)

    print("moon")
    moon = Image.open(os.path.join(globegl, "example", "moon-landing-sites", "lunar_surface.jpg"))
    moon = moon.convert("L").resize((2048, 1024), Image.LANCZOS)
    tex["moon"] = to_data_uri(moon, quality=82, optimize=True)
    return tex


def unwrap(ring):
    """Make a ring of [lon, lat] continuous in longitude (no ±360 jumps)."""
    out = [list(ring[0])]
    for lon, lat in ring[1:]:
        prev = out[-1][0]
        while lon - prev > 180:
            lon -= 360
        while lon - prev < -180:
            lon += 360
        out.append([lon, lat])
    return out


def build_milky_way(cel):
    """Rasterise d3-celestial's Milky Way isophotes into an RA/Dec map."""
    print("milky way")
    W, H = 2048, 1024
    mw = json.load(open(os.path.join(cel, "data", "mw.json")))
    acc = np.zeros((H, W), np.float32)
    weights = {"ol1": 0.16, "ol2": 0.18, "ol3": 0.2, "ol4": 0.22, "ol5": 0.24}
    for f in mw["features"]:
        # Each isophote level is a set of rings; combining them with the
        # even-odd rule gives the patches with their holes. A ring that goes
        # once around the sky (the outer band of the Milky Way) is closed
        # through the north celestial pole, so two such rings XOR to a band.
        mask = np.zeros((H, W), bool)
        for poly in f["geometry"]["coordinates"]:
            for ring in poly:
                ring = unwrap(ring)
                if abs(ring[-1][0] - ring[0][0]) > 180:
                    ring = ring + [[ring[-1][0], 90], [ring[0][0], 90]]
                layer = Image.new("1", (W, H), 0)
                d = ImageDraw.Draw(layer)
                # lon is RA in [-180, 180); x = RA / 360 * W. Copies shifted
                # by -360/0/+360 cover both sides of the RA = 0h seam.
                for off in (-360, 0, 360):
                    d.polygon([((lon + off) / 360 * W, (90 - lat) / 180 * H) for lon, lat in ring], fill=1)
                mask ^= np.asarray(layer, bool)
        acc += mask * weights[f["id"]]
    img = Image.fromarray(np.clip(acc * 255, 0, 255).astype(np.uint8), "L")
    img = img.filter(ImageFilter.GaussianBlur(3.0))
    return to_data_uri(img, quality=85, optimize=True)


def build_sky(cel):
    import opencc
    t2s = opencc.OpenCC("t2s")
    data = os.path.join(cel, "data")

    print("stars")
    stars = json.load(open(os.path.join(data, "stars.8.json")))["features"]
    stars.sort(key=lambda f: f["properties"]["mag"])
    packed = bytearray()
    for f in stars:
        ra, dec = f["geometry"]["coordinates"]
        ra %= 360
        mag = float(f["properties"]["mag"])
        try:
            bv = float(f["properties"]["bv"])
        except (TypeError, ValueError):
            bv = 0.6
        packed += struct.pack(
            "<HhBB",
            int(round(ra / 360 * 65535)) & 0xFFFF,
            int(round(dec / 90 * 32767)),
            max(0, min(255, int(round((mag + 2) * 20)))),
            max(0, min(255, int(round((bv + 0.5) * 100)))),
        )
    print(f"  {len(stars)} stars, {len(packed) / 1024:.0f} KB")

    # Proper names for the brightest stars. Traditional Chinese asterism names
    # from the catalogue, with the everyday names for a few famous stars.
    names = json.load(open(os.path.join(data, "starnames.json")))
    popular = {
        32349: "天狼星", 91262: "织女星", 97649: "牛郎星", 11767: "北极星",
        30438: "老人星", 69673: "大角星", 71683: "南门二",
    }
    labels = []
    for f in stars:
        hip = f["id"]
        mag = f["properties"]["mag"]
        if mag >= 1.6 and hip != 11767:
            continue
        n = names.get(str(hip), {})
        zh = popular.get(hip) or (t2s.convert(n["zh"]) if n.get("zh") else None)
        if not zh or hip == 71681:  # Toliman sits on top of Rigil Kentaurus
            continue
        ra, dec = f["geometry"]["coordinates"]
        labels.append([zh, n.get("name", ""), round(ra % 360, 3), round(dec, 3), mag])

    print("constellations")
    cons = json.load(open(os.path.join(data, "constellations.json")))["features"]
    cnames = []
    for f in cons:
        p = f["properties"]
        ra, dec = p["display"][0] % 360, p["display"][1]
        cnames.append([t2s.convert(p["zh"]), p["name"], round(ra, 2), round(dec, 2), int(p["rank"])])
    lines = []
    for f in json.load(open(os.path.join(data, "constellations.lines.json")))["features"]:
        for line in f["geometry"]["coordinates"]:
            lines.append([v for lon, lat in line for v in (round(lon % 360, 3), round(lat, 3))])

    return {
        "stars": base64.b64encode(bytes(packed)).decode("ascii"),
        "starCount": len(stars),
        "starNames": labels,
        "constellations": cnames,
        "constellationLines": lines,
        "milkyWay": build_milky_way(cel),
    }


def write_js(path, var, obj, header):
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(f"/* {header}\n   Generated by earth/tools/build_assets.py - do not edit by hand. */\n")
        fh.write(f"window.{var} = ")
        json.dump(obj, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write(";\n")
    print(f"wrote {path} ({os.path.getsize(path) / 1024 / 1024:.2f} MB)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cache", default=os.path.join(HERE, ".cache"), help="where npm tarballs are unpacked")
    args = ap.parse_args()
    globe = fetch(args.cache, "three-globe", PACKAGES["three-globe"])
    globegl = fetch(args.cache, "globe.gl", PACKAGES["globe.gl"])
    cel = fetch(args.cache, "d3-celestial", PACKAGES["d3-celestial"])
    os.makedirs(OUT, exist_ok=True)
    write_js(os.path.join(OUT, "earth-textures.js"), "EARTH_TEXTURES", build_textures(globe, globegl),
             "Earth and Moon textures (NASA Blue Marble / Black Marble / LRO, via three-globe and globe.gl)")
    write_js(os.path.join(OUT, "sky-data.js"), "SKY_DATA", build_sky(cel),
             "Star catalogue to V=8 (Hipparcos), constellations and Milky Way (via d3-celestial)")


if __name__ == "__main__":
    sys.exit(main())
