"""Runs all sites together and exposes the expected tag list."""
import json
from pathlib import Path

from .site import Site

ROOT = Path(__file__).resolve().parent.parent
MODEL = ROOT / "model" / "model.json"


def load_model(path=MODEL):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _attrs(model, template):
    t = {x["name"]: x for x in model["templates"]}
    names = []
    while template:
        names.insert(0, template)
        template = t[template]["base"]
    return [a for n in names for a in t[n]["attrs"]]


def expected_points(model):
    """All PI points of the model: {tag: {type, uom, src, desc}}."""
    out = {}

    def walk(node):
        for a in _attrs(model, node["template"]):
            if a["kind"] == "pi" and a["src"] != "ref":
                out[f"{node['tag_prefix']}.{a['tag']}"] = {
                    "type": "Int32" if a["type"] in ("Enum", "Int32") else "Float32",
                    "uom": a.get("uom") or "", "src": a["src"],
                    "desc": f"{node['name']} {a['name']}"[:80], "path": node.get("path", "")}
        for c in node["children"]:
            walk(c)

    walk(model["root"])
    return out


class Engine:
    def __init__(self, model, seed, t0):
        self.model = model
        self.sites = [Site(s, model["enums"], seed, t0) for s in model["root"]["children"]]
        self.int_tags = {t for t, p in expected_points(model).items() if p["type"] == "Int32"}

    def step(self, t, dt):
        values = {}
        for s in self.sites:
            values.update(s.step(t, dt))
        for k, v in values.items():
            values[k] = int(v) if k in self.int_tags else round(float(v), 4)
        return values
