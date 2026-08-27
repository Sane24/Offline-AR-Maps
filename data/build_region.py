#!/usr/bin/env python3
"""
Build an offline region pack for the AR trail navigator.

Fetches OpenStreetMap trails/POIs (Overpass API) and elevation (AWS terrarium
tiles, Mapzen open data), then emits a self-contained region directory:

  web/public/data/regions/<id>/
    manifest.json        region metadata + file inventory (byte sizes)
    trails.geojson       trail/road network (topology-safe simplification)
    pois.geojson         named landmarks (peaks, springs, parking, ...)
    contours.geojson     elevation contours (marching squares on the DEM)
    hillshade.png        semi-transparent hillshade overlay for the 2D map
    terrain.bin          region DEM, int16 meters, row-major, north-up
    terrain_<route>.bin  high-res DEM corridor per route (for the AR ground)
    routes/<route>.json  stitched route: coords+ele, cumdist, waypoints, stats

Also refreshes web/public/data/catalog.json (the region catalog used by the
in-app download manager).

Data attribution: (c) OpenStreetMap contributors (ODbL); elevation from
Mapzen/Amazon terrain tiles (public domain sources incl. SRTM, NED, GMTED).
"""

import io
import json
import math
import struct
import sys
import time
import urllib.parse
from pathlib import Path

import numpy as np
import requests
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT_BASE = ROOT / "web" / "public" / "data"

OVERPASS = "https://overpass-api.de/api/interpreter"
TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
UA = {"User-Agent": "offline-ar-maps-demo/0.1 (region pack builder; educational demo)"}

REGION = {
    "id": "joshua-tree",
    "name": "Joshua Tree - Ryan Mountain & Boy Scout",
    "blurb": "Rocky high desert in Joshua Tree National Park. Sparse signage, no cell coverage on most trails.",
    # south, west, north, east
    "bbox": (33.955, -116.305, 34.125, -116.055),
    "routes": [
        {
            "id": "ryan-mountain",
            "osm_name": "Ryan Mountain Trail",
            "name": "Ryan Mountain Summit",
            "blurb": "Steep granite staircase to a 360 degree summit view.",
            "loop": False,
            "start_near": (-116.1359, 34.0026),  # Park Blvd trailhead parking
        },
        {
            "id": "boy-scout",
            "osm_name": "Boy Scout Trail",
            "name": "Boy Scout Trail",
            "blurb": "Notoriously easy to lose where it crosses rocky washes.",
            "loop": False,
            "start_near": (-116.1857, 34.0412),  # southern trailhead on Park Blvd
        },
    ],
}

# ---------------------------------------------------------------- geo helpers

R_EARTH = 6371000.0


def haversine_m(lon1, lat1, lon2, lat2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_EARTH * math.asin(math.sqrt(a))


def bearing_deg(lon1, lat1, lon2, lat2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def ang_diff(a, b):
    """Signed smallest angle from a to b, in (-180, 180]."""
    d = (b - a + 180.0) % 360.0 - 180.0
    return d if d != -180.0 else 180.0


# ------------------------------------------------------------------- Overpass


CACHE = Path(__file__).resolve().parent / "cache"


def overpass(query):
    import hashlib

    CACHE.mkdir(exist_ok=True)
    key = CACHE / f"overpass_{hashlib.md5(query.encode()).hexdigest()[:16]}.json"
    if key.exists():
        print(f"  (cached {key.name})")
        return json.loads(key.read_text())
    for attempt in range(3):
        r = requests.post(OVERPASS, data={"data": query}, headers=UA, timeout=180)
        if r.status_code == 200:
            key.write_text(r.text)
            return r.json()
        print(f"  overpass status {r.status_code}, retrying in {15 * (attempt + 1)}s")
        time.sleep(15 * (attempt + 1))
    raise RuntimeError("Overpass failed after retries")


def fetch_osm(bbox):
    s, w, n, e = bbox
    bb = f"({s},{w},{n},{e})"
    q_ways = f"""
[out:json][timeout:120];
(
  way["highway"~"^(path|footway|steps|track|bridleway|cycleway|unclassified|residential|service|tertiary|secondary|primary)$"]{bb};
);
out geom;
"""
    q_pois = f"""
[out:json][timeout:120];
(
  node["natural"~"^(peak|saddle|spring|rock|stone|arch|cave_entrance|tree)$"]{bb};
  node["tourism"~"^(viewpoint|attraction|camp_site|picnic_site|information|artwork)$"]{bb};
  node["amenity"~"^(parking|toilets|drinking_water|shelter|ranger_station)$"]{bb};
  node["information"~"^(guidepost|board|map)$"]{bb};
);
out tags qt;
out skel qt;
"""
    print("Fetching OSM ways (trails/roads)...")
    ways = overpass(q_ways)
    time.sleep(2)
    print("Fetching OSM POIs...")
    pois = overpass(q_pois)
    return ways, pois


# ------------------------------------------------------------------ elevation

TILE = 256


def lonlat_to_tile(lon, lat, z):
    n = 2**z
    x = (lon + 180.0) / 360.0 * n
    lat_r = math.radians(lat)
    y = (1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n
    return x, y


def tile_to_lonlat(x, y, z):
    n = 2**z
    lon = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon, lat


_session = requests.Session()


def fetch_dem(bbox, z):
    """Stitch terrarium tiles covering bbox at zoom z. Returns (grid, mercator meta).

    Grid is float32 meters, row 0 = north. We keep it in Web Mercator pixel
    space and record the geographic bbox of the cropped grid.
    """
    s, w, n, e = bbox
    x0f, y0f = lonlat_to_tile(w, n, z)  # top-left
    x1f, y1f = lonlat_to_tile(e, s, z)  # bottom-right
    tx0, ty0 = int(math.floor(x0f)), int(math.floor(y0f))
    tx1, ty1 = int(math.floor(x1f)), int(math.floor(y1f))
    cols, rows = tx1 - tx0 + 1, ty1 - ty0 + 1
    print(f"  terrarium z{z}: {cols}x{rows} tiles")
    grid = np.zeros((rows * TILE, cols * TILE), dtype=np.float32)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            tile_cache = CACHE / "terrarium" / str(z) / str(tx) / f"{ty}.png"
            if tile_cache.exists():
                content = tile_cache.read_bytes()
            else:
                url = TERRARIUM.format(z=z, x=tx, y=ty)
                for attempt in range(3):
                    r = _session.get(url, headers=UA, timeout=30)
                    if r.status_code == 200:
                        break
                    time.sleep(2)
                r.raise_for_status()
                content = r.content
                tile_cache.parent.mkdir(parents=True, exist_ok=True)
                tile_cache.write_bytes(content)
            img = np.asarray(Image.open(io.BytesIO(content)).convert("RGB"), dtype=np.float32)
            ele = img[:, :, 0] * 256.0 + img[:, :, 1] + img[:, :, 2] / 256.0 - 32768.0
            ry, rx = (ty - ty0) * TILE, (tx - tx0) * TILE
            grid[ry : ry + TILE, rx : rx + TILE] = ele
        time.sleep(0.15)
    # crop to bbox in pixel space
    px0 = int((x0f - tx0) * TILE)
    py0 = int((y0f - ty0) * TILE)
    px1 = int(math.ceil((x1f - tx0) * TILE))
    py1 = int(math.ceil((y1f - ty0) * TILE))
    crop = grid[py0:py1, px0:px1]
    # actual geographic bbox of the crop (mercator-aligned)
    lon_w, lat_n = tile_to_lonlat(tx0 + px0 / TILE, ty0 + py0 / TILE, z)
    lon_e, lat_s = tile_to_lonlat(tx0 + px1 / TILE, ty0 + py1 / TILE, z)
    meta = {"west": lon_w, "south": lat_s, "east": lon_e, "north": lat_n}
    return crop, meta


def downsample(grid, max_w):
    h, w = grid.shape
    if w <= max_w:
        return grid
    f = int(math.ceil(w / max_w))
    h2, w2 = h - h % f, w - w % f
    g = grid[:h2, :w2].reshape(h2 // f, f, w2 // f, f).mean(axis=(1, 3))
    return g


def write_terrain_bin(path, grid, meta):
    """int16 LE grid with a small JSON-free header: magic, w, h, bbox as float64."""
    h, w = grid.shape
    hdr = struct.pack(
        "<4sII4d", b"TER1", w, h, meta["west"], meta["south"], meta["east"], meta["north"]
    )
    body = np.clip(np.round(grid), -32000, 32000).astype("<i2").tobytes()
    path.write_bytes(hdr + body)
    return {"w": w, "h": h, **{k: round(v, 7) for k, v in meta.items()}, "bytes": len(hdr + body)}


def grid_sampler(grid, meta):
    """Bilinear elevation sampler in geographic coords (mercator-y aware)."""
    h, w = grid.shape
    lat_n, lat_s = meta["north"], meta["south"]
    lon_w, lon_e = meta["west"], meta["east"]

    def merc_y(lat):
        lr = math.radians(lat)
        return math.log(math.tan(lr) + 1 / math.cos(lr))

    y_n, y_s = merc_y(lat_n), merc_y(lat_s)

    def sample(lon, lat):
        fx = (lon - lon_w) / (lon_e - lon_w) * (w - 1)
        fy = (y_n - merc_y(lat)) / (y_n - y_s) * (h - 1)
        fx = min(max(fx, 0), w - 1.001)
        fy = min(max(fy, 0), h - 1.001)
        x0, y0 = int(fx), int(fy)
        dx, dy = fx - x0, fy - y0
        v = (
            grid[y0, x0] * (1 - dx) * (1 - dy)
            + grid[y0, x0 + 1] * dx * (1 - dy)
            + grid[y0 + 1, x0] * (1 - dx) * dy
            + grid[y0 + 1, x0 + 1] * dx * dy
        )
        return float(v)

    return sample


def make_hillshade(grid, meta, out_path, max_w=1200):
    g = downsample(grid, max_w)
    h, w = g.shape
    lat_mid = (meta["north"] + meta["south"]) / 2
    px_m_x = haversine_m(meta["west"], lat_mid, meta["east"], lat_mid) / w
    px_m_y = haversine_m(0, meta["south"], 0, meta["north"]) / h
    gy, gx = np.gradient(g, px_m_y, px_m_x)
    # light from az 315, alt 45
    az, alt = math.radians(315), math.radians(45)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    shade = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - np.pi / 2 - aspect)
    shade = np.clip(shade, 0, 1)
    # dark multiply layer: alpha where shadowed
    alpha = np.clip((0.72 - shade) * 1.5, 0, 0.62) * 255
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[:, :, 0:3] = 12
    rgba[:, :, 3] = alpha.astype(np.uint8)
    img = Image.fromarray(rgba, "RGBA").filter(ImageFilter.GaussianBlur(0.6))
    img.save(out_path, optimize=True)
    return out_path.stat().st_size


# ------------------------------------------------------- contours (marching sq)


def marching_squares(grid, meta, level):
    """Extract iso-lines at `level` from the DEM. Returns list of [[lon,lat],...]."""
    h, w = grid.shape
    lon_w, lon_e = meta["west"], meta["east"]

    def merc_y(lat):
        lr = math.radians(lat)
        return math.log(math.tan(lr) + 1 / math.cos(lr))

    y_n, y_s = merc_y(meta["north"]), merc_y(meta["south"])

    def to_lonlat(fx, fy):
        lon = lon_w + fx / (w - 1) * (lon_e - lon_w)
        y = y_n + fy / (h - 1) * (y_s - y_n)
        lat = math.degrees(math.atan(math.sinh(y)))
        return (round(lon, 6), round(lat, 6))

    segs = []
    b = grid >= level
    for j in range(h - 1):
        row0, row1 = grid[j], grid[j + 1]
        b0, b1 = b[j], b[j + 1]
        for i in range(w - 1):
            tl, tr, bl, br = b0[i], b0[i + 1], b1[i], b1[i + 1]
            idx = tl * 8 + tr * 4 + br * 2 + bl * 1
            if idx == 0 or idx == 15:
                continue
            v_tl, v_tr, v_bl, v_br = row0[i], row0[i + 1], row1[i], row1[i + 1]

            def interp(va, vb):
                d = vb - va
                return 0.5 if abs(d) < 1e-9 else (level - va) / d

            top = (i + interp(v_tl, v_tr), j)
            bot = (i + interp(v_bl, v_br), j + 1)
            left = (i, j + interp(v_tl, v_bl))
            right = (i + 1, j + interp(v_tr, v_br))
            table = {
                1: [(left, bot)], 2: [(bot, right)], 3: [(left, right)],
                4: [(top, right)], 5: [(top, left), (bot, right)], 6: [(top, bot)],
                7: [(top, left)], 8: [(top, left)], 9: [(top, bot)],
                10: [(top, right), (left, bot)], 11: [(top, right)],
                12: [(left, right)], 13: [(bot, right)], 14: [(left, bot)],
            }
            for a, c in table[idx]:
                segs.append((a, c))
    # join segments into polylines
    def key(p):
        return (round(p[0], 3), round(p[1], 3))

    start_map = {}
    for si, (a, c) in enumerate(segs):
        start_map.setdefault(key(a), []).append(si)
    used = [False] * len(segs)
    lines = []
    for si in range(len(segs)):
        if used[si]:
            continue
        used[si] = True
        a, c = segs[si]
        line = [a, c]
        # extend forward
        while True:
            nxt = None
            for sj in start_map.get(key(line[-1]), []):
                if not used[sj]:
                    nxt = sj
                    break
            if nxt is None:
                break
            used[nxt] = True
            line.append(segs[nxt][1])
        if len(line) >= 5:
            lines.append([to_lonlat(px, py) for px, py in line])
    return lines


def simplify_dp(coords, tol):
    """Douglas-Peucker in the coordinate units given."""
    if len(coords) < 3:
        return coords
    keep = [False] * len(coords)
    keep[0] = keep[-1] = True
    stack = [(0, len(coords) - 1)]
    while stack:
        i0, i1 = stack.pop()
        ax, ay = coords[i0][0], coords[i0][1]
        bx, by = coords[i1][0], coords[i1][1]
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        dmax, imax = -1.0, -1
        for i in range(i0 + 1, i1):
            px, py = coords[i][0], coords[i][1]
            if seg2 == 0:
                d2 = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
                d2 = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2
            if d2 > dmax:
                dmax, imax = d2, i
        if dmax > tol * tol and imax > 0:
            keep[imax] = True
            stack.append((i0, imax))
            stack.append((imax, i1))
    return [c for c, k in zip(coords, keep) if k]


def build_contours(grid, meta, out_path, minor=20, major=100):
    g = downsample(grid, 700)
    lo = math.floor(float(g.min()) / minor) * minor + minor
    hi = math.ceil(float(g.max()) / minor) * minor
    feats = []
    lvl = lo
    while lvl <= hi:
        for line in marching_squares(g, meta, lvl):
            line = simplify_dp(line, 0.00008)
            if len(line) < 4:
                continue
            feats.append(
                {
                    "type": "Feature",
                    "properties": {"ele": int(lvl), "major": 1 if lvl % major == 0 else 0},
                    "geometry": {"type": "LineString", "coordinates": [[c[0], c[1]] for c in line]},
                }
            )
        lvl += minor
    fc = {"type": "FeatureCollection", "features": feats}
    out_path.write_text(json.dumps(fc, separators=(",", ":")))
    print(f"  contours: {len(feats)} lines, {out_path.stat().st_size//1024} KB")
    return out_path.stat().st_size


# ------------------------------------------------------------------ OSM layers

TRAIL_KINDS = {"path": "trail", "footway": "trail", "steps": "steps", "track": "track", "bridleway": "trail"}


def build_trails(ways_json, out_path):
    """Trails/roads geojson with topology-protected simplification.

    Junction nodes (shared between ways) and way endpoints are always kept so
    the in-app trail graph stays routable.
    """
    els = [e for e in ways_json["elements"] if e["type"] == "way" and "geometry" in e]
    node_count = {}
    for e in els:
        for nid in e.get("nodes", []):
            node_count[nid] = node_count.get(nid, 0) + 1
    feats = []
    for e in els:
        tags = e.get("tags", {})
        hw = tags.get("highway", "")
        kind = TRAIL_KINDS.get(hw, "road")
        coords = [(round(g["lon"], 6), round(g["lat"], 6)) for g in e["geometry"]]
        nids = e.get("nodes", [])
        required = {0, len(coords) - 1}
        for i, nid in enumerate(nids):
            if i == 0 or i == len(nids) - 1 or node_count.get(nid, 0) > 1:
                required.add(i)
        # simplify each stretch between required vertices
        req = sorted(required)
        out = []
        for a, b in zip(req, req[1:]):
            piece = simplify_dp(coords[a : b + 1], 0.00003)
            out.extend(piece[:-1])
        out.append(coords[req[-1]])
        if len(out) < 2:
            continue
        props = {"kind": kind}
        if tags.get("name"):
            props["name"] = tags["name"]
        if tags.get("sac_scale"):
            props["sac"] = tags["sac_scale"]
        if tags.get("surface"):
            props["surface"] = tags["surface"]
        feats.append(
            {
                "type": "Feature",
                "properties": props,
                "geometry": {"type": "LineString", "coordinates": [[c[0], c[1]] for c in out]},
            }
        )
    fc = {"type": "FeatureCollection", "features": feats}
    out_path.write_text(json.dumps(fc, separators=(",", ":")))
    print(f"  trails: {len(feats)} ways, {out_path.stat().st_size//1024} KB")
    return els, out_path.stat().st_size


POI_KIND = [
    ("natural", "peak", "peak"), ("natural", "saddle", "saddle"), ("natural", "spring", "water"),
    ("natural", "rock", "rock"), ("natural", "stone", "rock"), ("natural", "arch", "rock"),
    ("natural", "cave_entrance", "cave"), ("natural", "tree", "tree"),
    ("tourism", "viewpoint", "viewpoint"), ("tourism", "attraction", "landmark"),
    ("tourism", "camp_site", "camp"), ("tourism", "picnic_site", "picnic"),
    ("tourism", "information", "info"), ("tourism", "artwork", "landmark"),
    ("amenity", "parking", "parking"), ("amenity", "toilets", "toilets"),
    ("amenity", "drinking_water", "water"), ("amenity", "shelter", "shelter"),
    ("amenity", "ranger_station", "info"),
]


def build_pois(pois_json, sampler, out_path):
    # overpass returned tags pass + skel pass; merge by id
    tagged = {}
    coords = {}
    for e in pois_json["elements"]:
        if e["type"] != "node":
            continue
        if "tags" in e:
            tagged[e["id"]] = e["tags"]
        if "lat" in e:
            coords[e["id"]] = (e["lon"], e["lat"])
    feats = []
    for nid, tags in tagged.items():
        if nid not in coords:
            continue
        lon, lat = coords[nid]
        kind = None
        for k, v, out_kind in POI_KIND:
            if tags.get(k) == v:
                kind = out_kind
                break
        if tags.get("information") in ("guidepost", "board", "map"):
            kind = "guidepost"
        if kind is None:
            continue
        name = tags.get("name", "")
        # unnamed generic points add noise; keep unnamed only for guideposts/water/peaks
        if not name and kind not in ("guidepost", "water", "peak", "saddle", "parking", "toilets"):
            continue
        try:
            ele = float(tags.get("ele", "nan"))
        except ValueError:
            ele = float("nan")
        if math.isnan(ele):
            ele = sampler(lon, lat)
        props = {"kind": kind, "ele": round(ele)}
        if name:
            props["name"] = name
        feats.append(
            {
                "type": "Feature",
                "properties": props,
                "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
            }
        )
    feats.sort(key=lambda f: (0 if f["properties"].get("name") else 1, f["properties"]["kind"]))
    feats = feats[:500]
    fc = {"type": "FeatureCollection", "features": feats}
    out_path.write_text(json.dumps(fc, separators=(",", ":")))
    print(f"  pois: {len(feats)} points, {out_path.stat().st_size//1024} KB")
    return fc, out_path.stat().st_size


# --------------------------------------------------------------------- routes


def stitch_route(ways, osm_name):
    """Stitch all ways with a given name into one polyline (longest chain)."""
    segs = []
    for e in ways:
        if e.get("tags", {}).get("name") == osm_name:
            segs.append([(g["lon"], g["lat"]) for g in e["geometry"]])
    if not segs:
        raise RuntimeError(f"no ways named {osm_name}")

    def k(p):
        return (round(p[0], 6), round(p[1], 6))

    # build adjacency between segment endpoints
    changed = True
    chains = [list(s) for s in segs]
    while changed and len(chains) > 1:
        changed = False
        for i in range(len(chains)):
            if changed:
                break
            for j in range(len(chains)):
                if i == j:
                    continue
                a, b = chains[i], chains[j]
                if k(a[-1]) == k(b[0]):
                    chains[i] = a + b[1:]
                elif k(a[-1]) == k(b[-1]):
                    chains[i] = a + list(reversed(b))[1:]
                elif k(a[0]) == k(b[-1]):
                    chains[i] = b + a[1:]
                elif k(a[0]) == k(b[0]):
                    chains[i] = list(reversed(b)) + a[1:]
                else:
                    continue
                chains.pop(j)
                changed = True
                break

    def length(c):
        return sum(haversine_m(*c[i], *c[i + 1]) for i in range(len(c) - 1))

    chains.sort(key=length, reverse=True)
    if len(chains) > 1:
        print(f"  note: {osm_name} left {len(chains)} chains, keeping longest")
    return chains[0]


def resample(coords, step=12.0):
    out = [coords[0]]
    acc = 0.0
    for i in range(len(coords) - 1):
        a, b = coords[i], coords[i + 1]
        d = haversine_m(*a, *b)
        if d < 1e-6:
            continue
        while acc + step <= d:
            acc += step
            t = acc / d
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
        acc -= d
        if acc < 0:
            acc = 0.0
    if out[-1] != coords[-1]:
        out.append(coords[-1])
    return out


def synth_waypoints(coords, cum, pois_fc, sampler):
    """Turn maneuvers from geometry + checkpoints from nearby named POIs."""
    # simplified index list for turn detection
    pts = [(c[0], c[1]) for c in coords]
    simp = simplify_dp(pts, 0.00006)  # ~6 m
    simp_idx = []
    si = 0
    for p in simp:
        while si < len(pts) and (abs(pts[si][0] - p[0]) > 1e-9 or abs(pts[si][1] - p[1]) > 1e-9):
            si += 1
        if si < len(pts):
            simp_idx.append(si)
    wps = []
    for a, b, c in zip(simp_idx, simp_idx[1:], simp_idx[2:]):
        brg_in = bearing_deg(*pts[a], *pts[b])
        brg_out = bearing_deg(*pts[b], *pts[c])
        d = ang_diff(brg_in, brg_out)
        mag = abs(d)
        if mag < 40:
            continue
        side = "right" if d > 0 else "left"
        if mag >= 120:
            kind, verb = "switchback", f"Switchback {side}"
        elif mag >= 75:
            kind, verb = "turn", f"Turn {side}"
        else:
            kind, verb = "bear", f"Bear {side}"
        wps.append({"i": b, "kind": kind, "dir": side, "instruction": verb})
    # merge maneuvers closer than 25 m (keep the sharper one)
    merged = []
    for w in wps:
        if merged and cum[w["i"]] - cum[merged[-1]["i"]] < 25:
            continue
        merged.append(w)
    # checkpoint POIs within 45 m of the route
    for f in pois_fc["features"]:
        name = f["properties"].get("name")
        kind = f["properties"]["kind"]
        if not name or kind not in ("peak", "saddle", "viewpoint", "water", "landmark", "guidepost"):
            continue
        lon, lat = f["geometry"]["coordinates"]
        best_d, best_i = 1e9, -1
        for i in range(0, len(pts), 2):
            d = haversine_m(lon, lat, pts[i][0], pts[i][1])
            if d < best_d:
                best_d, best_i = d, i
        if best_d <= 45:
            merged.append(
                {"i": best_i, "kind": kind, "name": name, "instruction": name}
            )
    merged.sort(key=lambda w: w["i"])
    # dedupe same index
    out = []
    for w in merged:
        if out and w["i"] == out[-1]["i"]:
            if "name" in w:
                out[-1] = w
            continue
        out.append(w)
    return out


def build_route(spec, ways, pois_fc, region_dir, region_id):
    print(f"Route: {spec['osm_name']}")
    line = stitch_route(ways, spec["osm_name"])
    start_near = spec.get("start_near")
    if start_near and haversine_m(*line[-1], *start_near) < haversine_m(*line[0], *start_near):
        line.reverse()
    line = resample(line, 12.0)
    # corridor DEM at z14 for AR-quality ground
    lons = [p[0] for p in line]
    lats = [p[1] for p in line]
    m_lon = 900 / (haversine_m(min(lons), (min(lats) + max(lats)) / 2, max(lons), (min(lats) + max(lats)) / 2) / max(1e-9, (max(lons) - min(lons))))
    m_lat = 900 / 111320.0
    cbox = (min(lats) - m_lat, min(lons) - m_lon, max(lats) + m_lat, max(lons) + m_lon)
    grid, meta = fetch_dem(cbox, 14)
    grid = downsample(grid, 1100)
    sampler = grid_sampler(grid, meta)
    patch_name = f"terrain_{spec['id']}.bin"
    patch_meta = write_terrain_bin(region_dir / patch_name, grid, meta)

    coords = []
    for lon, lat in line:
        coords.append([round(lon, 6), round(lat, 6), round(sampler(lon, lat), 1)])
    cum = [0.0]
    for i in range(len(coords) - 1):
        cum.append(cum[-1] + haversine_m(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]))
    cum = [round(c, 1) for c in cum]

    gain = loss = 0.0
    # smooth elevation for stats (window 5)
    eles = [c[2] for c in coords]
    sm = [float(np.mean(eles[max(0, i - 2) : i + 3])) for i in range(len(eles))]
    for a, b in zip(sm, sm[1:]):
        d = b - a
        if d > 0:
            gain += d
        else:
            loss -= d

    wps = synth_waypoints(coords, cum, pois_fc, sampler)
    total = cum[-1]
    wps.insert(0, {"i": 0, "kind": "start", "name": "Trailhead", "instruction": "Head out from the trailhead"})
    wps.append({"i": len(coords) - 1, "kind": "arrive", "name": spec["name"], "instruction": "You have arrived"})

    est_min = total / 1000 * 12 + gain / 100 * 10  # Naismith-ish
    route = {
        "id": spec["id"],
        "region": region_id,
        "name": spec["name"],
        "blurb": spec["blurb"],
        "loop": spec["loop"],
        "coords": coords,
        "cum": cum,
        "waypoints": wps,
        "stats": {
            "lengthM": round(total),
            "gainM": round(gain),
            "lossM": round(loss),
            "minEle": round(min(eles)),
            "maxEle": round(max(eles)),
            "estMin": round(est_min),
        },
        "arPatch": patch_name,
    }
    (region_dir / "routes").mkdir(exist_ok=True)
    rp = region_dir / "routes" / f"{spec['id']}.json"
    rp.write_text(json.dumps(route, separators=(",", ":")))
    print(f"  {total/1000:.1f} km, +{gain:.0f} m, {len(wps)} waypoints, {rp.stat().st_size//1024} KB")
    return {
        "id": spec["id"],
        "name": spec["name"],
        "blurb": spec["blurb"],
        "file": f"routes/{spec['id']}.json",
        "arPatch": patch_name,
        "patchMeta": patch_meta,
        "stats": route["stats"],
        "start": coords[0][:2],
        "bytes": rp.stat().st_size,
    }


# ----------------------------------------------------------------------- main


def main():
    region = REGION
    rid = region["id"]
    region_dir = OUT_BASE / "regions" / rid
    region_dir.mkdir(parents=True, exist_ok=True)

    ways_json, pois_json = fetch_osm(region["bbox"])

    print("Fetching region DEM (z12)...")
    s, w, n, e = region["bbox"]
    grid, meta = fetch_dem((s, w, n, e), 12)
    sampler = grid_sampler(grid, meta)

    print("Writing terrain.bin ...")
    small = downsample(grid, 560)
    terr_meta = write_terrain_bin(region_dir / "terrain.bin", small, meta)

    print("Hillshade ...")
    hs_bytes = make_hillshade(grid, meta, region_dir / "hillshade.png")

    print("Contours ...")
    ct_bytes = build_contours(grid, meta, region_dir / "contours.geojson")

    print("Trails ...")
    way_els, tr_bytes = build_trails(ways_json, region_dir / "trails.geojson")

    print("POIs ...")
    pois_fc, poi_bytes = build_pois(pois_json, sampler, region_dir / "pois.geojson")

    routes_meta = [build_route(rs, way_els, pois_fc, region_dir, rid) for rs in region["routes"]]

    files = {
        "trails": {"path": "trails.geojson", "bytes": tr_bytes},
        "pois": {"path": "pois.geojson", "bytes": poi_bytes},
        "contours": {"path": "contours.geojson", "bytes": ct_bytes},
        "hillshade": {"path": "hillshade.png", "bytes": hs_bytes, **{k: round(v, 7) for k, v in meta.items()}},
        "terrain": {"path": "terrain.bin", **terr_meta},
    }
    total_bytes = sum(f["bytes"] for f in files.values()) + sum(r["bytes"] + r["patchMeta"]["bytes"] for r in routes_meta)
    manifest = {
        "id": rid,
        "name": region["name"],
        "blurb": region["blurb"],
        "version": 1,
        "bbox": {"south": s, "west": w, "north": n, "east": e},
        "center": [round((w + e) / 2, 5), round((s + n) / 2, 5)],
        "attribution": "Map data (c) OpenStreetMap contributors (ODbL). Elevation: Mapzen/AWS Terrain Tiles.",
        "files": files,
        "routes": routes_meta,
        "bytes": total_bytes,
    }
    (region_dir / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")))

    catalog_path = OUT_BASE / "catalog.json"
    catalog = {"regions": []}
    if catalog_path.exists():
        catalog = json.loads(catalog_path.read_text())
    catalog["regions"] = [r for r in catalog["regions"] if r["id"] != rid]
    catalog["regions"].append(
        {
            "id": rid,
            "name": region["name"],
            "blurb": region["blurb"],
            "center": manifest["center"],
            "bbox": manifest["bbox"],
            "bytes": total_bytes,
            "routes": [{"id": r["id"], "name": r["name"], "km": round(r["stats"]["lengthM"] / 1000, 1)} for r in routes_meta],
        }
    )
    catalog_path.write_text(json.dumps(catalog, indent=1))
    print(f"\nRegion pack complete: {total_bytes/1e6:.1f} MB total -> {region_dir}")


if __name__ == "__main__":
    sys.exit(main())
