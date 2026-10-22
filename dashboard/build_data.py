#!/usr/bin/env python3
"""Build the dashboard's static data files.

    python dashboard/build_data.py --geojson ne_50m_admin_0_countries.geojson
    python dashboard/build_data.py            (keeps the existing map.js)

Writes
  dashboard/data/model.js  sites, wells and AF element paths from model/model.json
  dashboard/data/map.js    South America country outlines (Natural Earth 1:50m, public domain)
  dashboard/data/demo.js   ~90 days of simulator output, used when PI Web API is not reachable
"""
import argparse
import datetime as dt
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dashboard" / "data"
sys.path.insert(0, str(ROOT))

from sim.core import DAY  # noqa: E402
from sim.engine import Engine, load_model  # noqa: E402

BBOX = (-93.0, -57.0, -32.0, 14.5)  # lon_min, lat_min, lon_max, lat_max
UNITS = [  # (key, element id suffix, status attribute, label)
    ("GT", "GT", "Unit Status", "Gathering & Transfer"),
    ("CDU", "CDU100", "Unit Status", "Atmospheric Distillation"),
    ("VDU", "VDU200", "Unit Status", "Vacuum Distillation"),
    ("HDT", "HDT300", "Unit Status", "Diesel Hydrotreater"),
    ("STM", "STM", "System Status", "Steam System"),
    ("CW", "CW", "System Status", "Cooling Water"),
]
# one headline metric per unit: (element id suffix, attribute, tag suffix, unit)
UNIT_METRIC = {
    "GT": ("PL-001", "Outlet Flow", "QOUT", "bbl/d"),
    "CDU": ("CDU100", "Throughput", "THRU", "bbl/d"),
    "VDU": ("C-201", "Top Pressure", "PTOP", "mmHg"),
    "HDT": ("R-301", "Product Sulfur", "SULF", "ppm"),
    "STM": ("B-501", "Steam Pressure", "PSTM", "psig"),
    "CW": ("CT-501", "Supply Temperature", "TSUP", "°F"),
}


def index(node, out):
    out[node["id"]] = node
    for c in node["children"]:
        index(c, out)
    return out


def merc(lat):
    lat = max(-85.0, min(85.0, lat))
    return math.degrees(math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)))


def proj(lon, lat):
    """Shared with app.js: x = lon, y = -mercator(lat), in degrees."""
    return lon, -merc(lat)


# ---------------------------------------------------------------- model.js
def build_model(model):
    sites = []
    for s in model["root"]["children"]:
        n = index(s, {})
        c = s["id"]
        v = s["values"]
        wf = n[f"{c}-WF"]
        wells = []
        for w in wf["children"]:
            wv = w["values"]
            wells.append({"id": w["id"], "name": w["name"], "path": w["path"], "tag": w["tag_prefix"],
                          "lift": wv["Lift Method"], "lat": wv["Location|Latitude"], "lon": wv["Location|Longitude"],
                          "design": wv["Design Oil Rate"]})
        units = []
        for key, eid, status_attr, label in UNITS:
            u = n[f"{c}-{eid}"]
            m_eid, m_attr, m_tag, m_uom = UNIT_METRIC[key]
            m = n[f"{c}-{m_eid}"]
            units.append({"key": key, "label": label, "path": u["path"], "tag": u["tag_prefix"],
                          "statusAttr": status_attr, "metricPath": m["path"], "metricAttr": m_attr,
                          "metricTag": f"{m['tag_prefix']}.{m_tag}", "metricUom": m_uom})
        sites.append({
            "code": c, "name": s["name"], "path": s["path"], "country": v["Country"], "state": v["State / Province"],
            "basin": v["Basin"], "field": wf["values"]["Field Name"], "lat": v["Location|Latitude"],
            "lon": v["Location|Longitude"], "capacity": v["Refinery Nameplate Capacity"],
            "wellfieldPath": wf["path"], "crudeFarmPath": n[f"{c}-CTF"]["path"],
            "short": wells[0]["name"].split("-")[0], "wells": wells, "units": units,
        })
    return {"company": model["company"]["name"], "rootPath": model["root"]["path"],
            "database": model["database"], "enums": model["enums"], "sites": sites}


# ---------------------------------------------------------------- map.js
def build_map(geojson_path):
    d = json.loads(Path(geojson_path).read_text(encoding="utf-8"))
    lo0, la0, lo1, la1 = BBOX
    shapes = []
    for f in d["features"]:
        g = f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        parts = []
        for poly in polys:
            ring = poly[0]
            lons = [p[0] for p in ring]
            lats = [p[1] for p in ring]
            if max(lons) < lo0 or min(lons) > lo1 or max(lats) < la0 or min(lats) > la1:
                continue
            pts, last = [], None
            for lon, lat in ring:
                x, y = proj(lon, lat)
                p = (round(x, 3), round(y, 3))
                if p != last:
                    pts.append(p)
                    last = p
            if len(pts) >= 4:
                parts.append("M" + "L".join(f"{x},{y}" for x, y in pts) + "Z")
        if parts:
            shapes.append({"name": f["properties"]["NAME"], "sa": f["properties"].get("CONTINENT") == "South America",
                           "d": "".join(parts)})
    return {"bbox": BBOX, "shapes": shapes, "source": "Natural Earth 1:50m admin-0 countries (public domain)"}


# ---------------------------------------------------------------- demo.js
def build_demo(model, days=91, step=300):
    start = dt.datetime(2026, 7, 23, tzinfo=dt.timezone.utc).timestamp()
    end = start + days * DAY
    eng = Engine(model, 20261021, start)
    enums = model["enums"]
    ws, us, ss = enums["Well Status"], enums["Unit Status"], enums["Sim Scenario"]
    dm = build_model(model)

    trend_from = end - 30 * DAY
    spark_from = end - 7 * DAY
    daily = defaultdict(lambda: defaultdict(lambda: [0.0, 0]))   # (site, metric) -> day -> [sum, n]
    wdaily = defaultdict(lambda: defaultdict(lambda: [0.0, 0]))  # well -> day -> [sum, n]
    up = defaultdict(lambda: [0, 0])
    runs = defaultdict(list)
    open_run = {}
    last = None
    t = start
    while t <= end:
        v = eng.step(t, step)
        day = int((t - trend_from) // DAY)
        for s in dm["sites"]:
            oil = sum(v[f"{w['tag']}.QO"] for w in s["wells"])
            thru = v[f"CP.{s['code']}.CDU100.THRU"]
            if t >= trend_from:
                for k, x in (("oil", oil), ("thru", thru)):
                    a = daily[(s["code"], k)][day]
                    a[0] += x
                    a[1] += 1
            for w in s["wells"]:
                st = v[f"{w['tag']}.STATUS"]
                if t >= spark_from:
                    a = wdaily[w["id"]][int((t - spark_from) // DAY)]
                    a[0] += v[f"{w['tag']}.QO"]
                    a[1] += 1
                    up[w["id"]][0] += st == 1
                    up[w["id"]][1] += 1
                r = open_run.get(w["id"])
                if st == 1 and r is None:
                    open_run[w["id"]] = {"start": t, "oil": 0.0}
                elif st == 1:
                    r["oil"] += v[f"{w['tag']}.QO"] * step / DAY
                elif r is not None:
                    r.update(end=t, reason=ss[v[f"{w['tag']}.SCEN"]])
                    runs[w["id"]].append(r)
                    del open_run[w["id"]]
        last = v
        t += step

    def iso(x):
        return dt.datetime.fromtimestamp(x, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    v = last
    out_sites = {}
    for s in dm["sites"]:
        c = s["code"]
        wells = {}
        for w in s["wells"]:
            p = w["tag"]
            qo, qw = v[f"{p}.QO"], v[f"{p}.QW"]
            wells[w["id"]] = {
                "status": ws[v[f"{p}.STATUS"]], "scenario": ss[v[f"{p}.SCEN"]],
                "oil": round(qo, 1), "water": round(qw, 1), "gas": round(v[f"{p}.QG"], 1),
                "wc": round(100 * qw / (qo + qw), 1) if qo + qw > 1 else None,
                "dayOil": round(v[f"{p}.DAYOIL"], 1),
                "uptime7d": round(100 * up[w["id"]][0] / max(1, up[w["id"]][1]), 1),
                "spark": [round(a[0] / a[1], 1) for _, a in sorted(wdaily[w["id"]].items())][:7],
            }
        units = {}
        for u in s["units"]:
            sym = "STATUS"
            units[u["key"]] = {"status": us[v[f"{u['tag']}.{sym}"]], "scenario": ss[v[f"{u['tag']}.SCEN"]],
                               "metric": round(v[u["metricTag"]], 1)}
        events = []
        for w in s["wells"]:
            for r in runs[w["id"]]:
                if r["end"] >= end - 7 * DAY:
                    events.append({"well": w["name"], "start": iso(r["start"]), "end": iso(r["end"]),
                                   "oil": round(r["oil"]), "reason": r["reason"]})
        events.sort(key=lambda e: e["end"], reverse=True)
        oil = sum(x["oil"] for x in wells.values())
        water = sum(x["water"] for x in wells.values())
        gas = sum(x["gas"] for x in wells.values())
        days_ = sorted(daily[(c, "oil")])
        out_sites[c] = {
            "oil": round(oil, 1), "water": round(water, 1), "gas": round(gas, 1),
            "thru": round(v[f"CP.{c}.CDU100.THRU"], 1),
            "producing": sum(1 for x in wells.values() if x["status"] == "Producing"),
            "crudeInv": round(v[f"CP.{c}.TK101.INV"] + v[f"CP.{c}.TK102.INV"]),
            "wells": wells, "units": units, "events": events[:12],
            "trend": {"days": [iso(trend_from + d * DAY)[:10] for d in days_],
                      "oil": [round(daily[(c, "oil")][d][0] / daily[(c, "oil")][d][1]) for d in days_],
                      "thru": [round(daily[(c, "thru")][d][0] / daily[(c, "thru")][d][1]) for d in days_]},
        }
    return {"asOf": iso(end), "sites": out_sites}


def write_js(name, var, data):
    OUT.mkdir(parents=True, exist_ok=True)
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    (OUT / name).write_text(f"// generated by dashboard/build_data.py\nwindow.{var} = {body};\n", encoding="utf-8")
    print(f"dashboard/data/{name}: {len(body) / 1024:.0f} KB")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--geojson", help="Natural Earth ne_50m_admin_0_countries.geojson")
    ap.add_argument("--no-demo", action="store_true")
    args = ap.parse_args()
    model = load_model()
    write_js("model.js", "CP_MODEL", build_model(model))
    if args.geojson:
        write_js("map.js", "CP_MAP", build_map(args.geojson))
    if not args.no_demo:
        write_js("demo.js", "CP_DEMO", build_demo(model))


if __name__ == "__main__":
    main()
