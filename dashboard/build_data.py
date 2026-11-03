#!/usr/bin/env python3
"""Build the dashboard's static data files.

    python dashboard/build_data.py

Writes
  dashboard/data/model.js  sites, wells and AF element paths from model/model.json
  dashboard/data/plant.js  each site's AF element tree with its PI attributes, for the plant view
  dashboard/data/demo.js   ~90 days of simulator output, used when PI Web API is not reachable
"""
import argparse
import datetime as dt
import json
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dashboard" / "data"
sys.path.insert(0, str(ROOT))

from sim.core import DAY  # noqa: E402
from sim.engine import Engine, load_model  # noqa: E402

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


# ---------------------------------------------------------------- plant.js
# static attributes the plant view uses for sizing and labels
PLANT_PROPS = ("Product", "Nominal Capacity", "Max Fill Height", "Diameter", "Design Capacity", "Lift Method",
               "Number of Trays", "Length", "Location|Latitude", "Location|Longitude", "Service")


def template_attrs(model):
    """template name -> PI Point attributes, inherited ones first: [name, tag suffix, uom, enum set]"""
    tt = {t["name"]: t for t in model["templates"]}
    out = {}
    for name in tt:
        chain, t = [], tt[name]
        while t:
            chain.insert(0, t)
            t = tt.get(t["base"])
        seen, attrs = set(), []
        for t in chain:
            for a in t["attrs"]:
                if a["kind"] == "pi" and a["name"] not in seen:
                    seen.add(a["name"])
                    attrs.append([a["name"], a["tag"], a["uom"], a["enum"]])
        out[name] = attrs
    return out


def plant_node(n, attrs):
    return {"id": n["id"], "name": n["name"], "template": n["template"], "isa": n["isa"], "path": n["path"],
            "tag": n["tag_prefix"], "desc": n["desc"],
            "props": {k: n["values"][k] for k in PLANT_PROPS if k in n["values"]},
            "children": [plant_node(c, attrs) for c in n["children"]]}


def build_plant(model):
    attrs = template_attrs(model)
    used = set()

    def collect(n):
        used.add(n["template"])
        for c in n["children"]:
            collect(c)
    sites = {}
    for s in model["root"]["children"]:
        collect(s)
        sites[s["id"]] = plant_node(s, attrs)
    return {"templates": {k: v for k, v in attrs.items() if k in used}, "sites": sites}


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
    tpl_attrs = template_attrs(model)

    def tag_values(node, out):
        for name, suffix, uom, enum in tpl_attrs[node["template"]]:
            x = v.get(f"{node['tag_prefix']}.{suffix}")
            if x is None:
                continue
            out[f"{node['tag_prefix']}.{suffix}"] = enums[enum][int(x)] if enum else round(x, 2)
        for c in node["children"]:
            tag_values(c, out)
        return out
    # rollup outputs are written by AF analyses, not by the simulator: sum the children like AF does
    rollups = [r for r in model["analyses"] if r["type"] == "Rollup" and r["template"] != "Enterprise"]

    def add_rollups(node, out):
        for c in node["children"]:
            add_rollups(c, out)
        attr_tag = {name: f"{node['tag_prefix']}.{suffix}" for name, suffix, _, _ in tpl_attrs[node["template"]]}
        for r in rollups:
            if r["template"] == node["template"] and r["output"] in attr_tag:
                parts = [out.get(f"{c['tag_prefix']}.{suf}") for c in node["children"]
                         for name, suf, _, _ in tpl_attrs[c["template"]] if name == r["input"]]
                out[attr_tag[r["output"]]] = round(sum(x for x in parts if isinstance(x, (int, float))), 2)
        return out

    def site_tags(node):
        return add_rollups(node, tag_values(node, {}))
    site_nodes = {n["id"]: n for n in model["root"]["children"]}
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
            "wells": wells, "units": units, "events": events[:12], "tags": site_tags(site_nodes[c]),
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
    ap.add_argument("--no-demo", action="store_true")
    args = ap.parse_args()
    model = load_model()
    write_js("model.js", "CP_MODEL", build_model(model))
    write_js("plant.js", "CP_PLANT", build_plant(model))
    if not args.no_demo:
        write_js("demo.js", "CP_DEMO", build_demo(model))


if __name__ == "__main__":
    main()
