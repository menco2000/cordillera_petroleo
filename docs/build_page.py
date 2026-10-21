#!/usr/bin/env python3
"""Embed model/model.json into the review page -> docs/af-model.html"""
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
model = json.loads((root / "model" / "model.json").read_text(encoding="utf-8"))
data = json.dumps(model, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
html = (root / "docs" / "af-model.template.html").read_text(encoding="utf-8").replace("/*MODEL_JSON*/", data)
(root / "docs" / "af-model.html").write_text(html, encoding="utf-8")
print("docs/af-model.html", len(html), "bytes")
