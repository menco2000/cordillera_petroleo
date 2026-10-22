"""Cordillera Petróleo process simulator.

    python -m sim tags     [--csv tags.csv]           list every PI point the model uses
    python -m sim preview  [--days 7] [--site BAR]    simulate offline to CSV (no PI needed)
    python -m sim check                               test PI Web API and report missing points
    python -m sim backfill [--from ISO] [--to ISO]    write history (default: config start -> now)
    python -m sim run                                 keep writing in real time

All commands that talk to PI read sim/config.toml (copy config.example.toml).
"""
import argparse
import csv
import datetime as dt
import sys
import time
import tomllib
from collections import defaultdict
from pathlib import Path

from .engine import Engine, expected_points, load_model

HERE = Path(__file__).resolve().parent


def parse_ts(s):
    if s in (None, "", "now"):
        return time.time()
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def iso(t):
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_config(path):
    p = Path(path)
    if not p.exists():
        sys.exit(f"Config not found: {p}. Copy sim/config.example.toml to sim/config.toml and edit it.")
    return tomllib.loads(p.read_text(encoding="utf-8"))


def sim_settings(cfg):
    s = cfg.get("simulation", {})
    return (parse_ts(s.get("start", "2026-07-23T00:00:00Z")), s.get("seed", 20261021),
            s.get("backfill_step_seconds", 300), s.get("realtime_step_seconds", 60),
            s.get("update_option", "Replace"))


def connect(cfg, model):
    from .piwebapi import PIWebAPI
    api = PIWebAPI(cfg["piwebapi"])
    found = api.find_points("CP.*")
    expected = expected_points(model)
    missing = sorted(set(expected) - set(found))
    return api, found, expected, missing


def cmd_tags(args, model):
    pts = expected_points(model)
    rows = [(t, p["type"], p["uom"], p["src"], p["desc"]) for t, p in sorted(pts.items())]
    if args.csv:
        with open(args.csv, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["tag", "pointtype", "engunits", "written_by", "descriptor"])
            w.writerows(rows)
        print(f"{len(rows)} points -> {args.csv}")
    else:
        for r in rows:
            print("\t".join(r))
        by = defaultdict(int)
        for r in rows:
            by[r[3]] += 1
        print(f"\n{len(rows)} points: " + ", ".join(f"{v} written by {k}" for k, v in by.items()))


def cmd_preview(args, model):
    t0 = parse_ts(args.start)
    eng = Engine(model, args.seed, t0)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    prefix = f"CP.{args.site}." if args.site else "CP."
    steps = int(args.days * 86400 / args.step)
    rows, cols = [], None
    for i in range(steps):
        t = t0 + i * args.step
        v = eng.step(t, args.step)
        if cols is None:
            cols = sorted(k for k in v if k.startswith(prefix))
        rows.append([iso(t)] + [v[c] for c in cols])
    f = out / f"preview_{args.site or 'ALL'}.csv"
    with open(f, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["timestamp"] + cols)
        w.writerows(rows)
    print(f"{len(rows)} rows x {len(cols)} tags -> {f}")


def cmd_check(args, model, cfg):
    api, found, expected, missing = connect(cfg, model)
    print(f"Connected to {api.base}, data server {api.server}.")
    print(f"{len(expected)} points in the model, {len(expected) - len(missing)} found, {len(missing)} missing.")
    for t in missing[:30]:
        print("  missing:", t)
    if missing:
        print("Create them from AF (PI System Explorer > Create or Update Data Reference), then run check again.")
        sys.exit(2)


def writable(found, expected):
    return {t: found[t] for t, p in expected.items() if p["src"] == "sim" and t in found}


def cmd_backfill(args, model, cfg):
    t0, seed, step, _, upd = sim_settings(cfg)
    step = args.step or step
    t_from = parse_ts(args.from_) if args.from_ else t0
    t_to = parse_ts(args.to)
    api, found, expected, missing = connect(cfg, model)
    if missing:
        print(f"Warning: {len(missing)} points missing, their values are skipped (run 'check').")
    ids = writable(found, expected)
    eng = Engine(model, seed, t0)
    buf = defaultdict(list)
    t, n_days, n_vals = t0, 0, 0
    started = time.time()
    while t <= t_to:
        vals = eng.step(t, step)
        if t >= t_from:
            ts = iso(t)
            for tag, wid in ids.items():
                buf[wid].append((ts, vals[tag]))
        t += step
        if buf and (len(next(iter(buf.values()))) * step >= 86400 or t > t_to):
            api.write(buf, upd)
            n_vals += sum(len(x) for x in buf.values())
            n_days += 1
            print(f"  wrote up to {iso(t - step)}  ({n_vals:,} values, {time.time() - started:.0f} s)", flush=True)
            buf = defaultdict(list)
    print("Backfill done. Now backfill the AF analyses for the same period (see README).")


def cmd_run(args, model, cfg):
    t0, seed, bstep, rstep, upd = sim_settings(cfg)
    api, found, expected, missing = connect(cfg, model)
    ids = writable(found, expected)
    eng = Engine(model, seed, t0)
    now = time.time()
    print(f"Warming up from {iso(t0)} to now (no writes)...", flush=True)
    t = t0
    while t + bstep <= now:
        eng.step(t, bstep)
        t += bstep
    t = (time.time() // rstep) * rstep
    print(f"Real time: writing {len(ids)} points every {rstep} s. Ctrl+C to stop.", flush=True)
    while True:
        wait = t + rstep - time.time()
        if wait > 0:
            time.sleep(wait)
        t += rstep
        vals = eng.step(t, rstep)
        ts = iso(t)
        try:
            api.write({wid: [(ts, vals[tag])] for tag, wid in ids.items()}, upd)
        except Exception as e:  # keep running through short outages
            print(f"{ts} write failed: {e}", flush=True)


def main():
    ap = argparse.ArgumentParser(prog="python -m sim", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=str(HERE / "config.toml"))
    ap.add_argument("--model", default=None, help="path to model.json")
    sp = ap.add_subparsers(dest="cmd", required=True)
    p = sp.add_parser("tags")
    p.add_argument("--csv")
    p = sp.add_parser("preview")
    p.add_argument("--days", type=float, default=7)
    p.add_argument("--step", type=int, default=300)
    p.add_argument("--site", help="site code, e.g. BAR")
    p.add_argument("--start", default="2026-07-23T00:00:00Z")
    p.add_argument("--seed", type=int, default=20261021)
    p.add_argument("--out", default="out")
    sp.add_parser("check")
    p = sp.add_parser("backfill")
    p.add_argument("--from", dest="from_")
    p.add_argument("--to", default="now")
    p.add_argument("--step", type=int)
    sp.add_parser("run")
    args = ap.parse_args()

    model = load_model(args.model) if args.model else load_model()
    if args.cmd == "tags":
        return cmd_tags(args, model)
    if args.cmd == "preview":
        return cmd_preview(args, model)
    cfg = load_config(args.config)
    {"check": cmd_check, "backfill": cmd_backfill, "run": cmd_run}[args.cmd](args, model, cfg)


if __name__ == "__main__":
    main()
