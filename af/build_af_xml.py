#!/usr/bin/env python3
"""Generate the PI AF XML import file from model/model.json.

    python af/build_af_xml.py                 -> af/CordilleraPetroleo.xml
    python af/build_af_xml.py --no-analytics  -> af/CordilleraPetroleo_NoAnalytics.xml

The structure follows AF 2.x exports made by PI System Explorer (SchemaVersion 2.0).
Import in PI System Explorer: File > Import from File, into an empty database
named "Cordillera Petroleo" (Allow Create + Allow Update).
"""
import argparse
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "model"))
from spec import chain, all_attrs  # noqa: E402

AF_TYPE = {"String": "String", "Double": "Double", "Int32": "Int32", "DateTime": "DateTime",
           "Float32": "Single", "Enum": "AFEnumerationValue"}
POINT_TYPE = {"Float32": "Float32", "Int32": "Int32", "Enum": "Int32"}
ISA_CATEGORY = "ISA-95 {}"


def sub(parent, tag, text=None, **attrib):
    e = ET.SubElement(parent, tag, attrib)
    if text is not None:
        e.text = str(text)
    return e


class Builder:
    def __init__(self, model, analytics=True):
        self.m = model
        self.analytics = analytics
        self.uom = model["af_uom"]
        self.ps = model["point_source"]
        self.templates = {t["name"]: t for t in model["templates"]}

    # ---- helpers -----------------------------------------------------------
    def af_uom(self, uom):
        return self.uom.get(uom or "", "")

    def describe(self, a):
        d = a.get("desc") or ""
        if a.get("uom") and not self.af_uom(a["uom"]):
            d = (d + " " if d else "") + f"Unit: {a['uom']}."
        return d

    def point_params(self, a):
        p = f";pointtype={POINT_TYPE[a['type']]};pointsource={self.ps};compressing=0"
        if a.get("uom"):
            p += f";engunits={a['uom']}"
        return p

    def template_config(self, a):
        cfg = f"\\\\%Server%\\%@Tag Prefix%.{a['tag']}"
        return cfg if a["src"] == "ref" else cfg + self.point_params(a)

    def element_config(self, node, a):
        cfg = f"\\\\%Server%\\{node['tag_prefix']}.{a['tag']}"
        return cfg if a["src"] == "ref" else cfg + self.point_params(a)

    @staticmethod
    def formula_config(a):
        return ";".join(f"{k}={v}" for k, v in a["vars"].items()) + f";[{a['expr']}]"

    def value(self, parent, a, v):
        t = a["type"]
        if t == "Enum":
            sub(parent, "Value", f"EnumerationSets[{a['enum']}]\\{v}", type="AFEnumerationValue")
        elif t == "DateTime":
            sub(parent, "Value", f"{v}T00:00:00Z", type="DateTime")
        elif t in ("Double", "Float32"):
            sub(parent, "Value", repr(float(v)), type=AF_TYPE[t])
        elif t == "Int32":
            sub(parent, "Value", int(v), type="Int32")
        else:
            sub(parent, "Value", v, type="String")

    def default_value(self, parent, a):
        t = a["type"]
        if t in ("Double", "Float32"):
            sub(parent, "Value", "0", type=AF_TYPE[t])
        elif t == "Int32":
            sub(parent, "Value", "0", type="Int32")
        elif t == "String":
            sub(parent, "Value", "", type="String")

    # ---- library -----------------------------------------------------------
    def attribute_template(self, parent, a):
        x = sub(parent, "AFAttributeTemplate")
        sub(x, "Name", a["name"])
        sub(x, "Description", self.describe(a))
        sub(x, "IsHidden", "false")
        sub(x, "IsManualDataEntry", "false")
        sub(x, "IsConfigurationItem", "true" if a["kind"] == "static" else "false")
        sub(x, "IsExcluded", "false")
        sub(x, "IsIndexed", "false")
        sub(x, "Trait", "")
        sub(x, "DefaultUOM", "" if a["kind"] == "static" and a["children"] else self.af_uom(a.get("uom")))
        sub(x, "Type", AF_TYPE[a["type"]])
        if a["type"] == "Enum":
            sub(x, "TypeQualifier", f"EnumerationSets[{a['enum']}]", type="AFObject")
        else:
            sub(x, "TypeQualifier", "")
        self.default_value(x, a)
        if a["kind"] == "pi":
            sub(x, "DataReference", "PI Point")
            sub(x, "ConfigString", self.template_config(a))
        elif a["kind"] == "formula":
            sub(x, "DataReference", "Formula")
            sub(x, "ConfigString", self.formula_config(a))
        else:
            sub(x, "DataReference", "")
            sub(x, "ConfigString", "")
        sub(x, "AFAttributeCategoryRef", a["cat"])
        for c in a["children"]:
            self.attribute_template(x, c)

    def analysis_template(self, parent, an):
        x = sub(parent, "AFAnalysisTemplate")
        sub(x, "Name", an["name"])
        sub(x, "Description", an["note"] if "note" in an else f"{an['function']} of child elements' {an['input']}")
        sub(x, "OutputTime", "")
        sub(x, "GroupID", "0")
        sub(x, "CaseTemplate", "")
        sub(x, "Target", an["template"])
        sub(x, "CreateEnabled", "true")
        rule = sub(x, "AFAnalysisRule")
        if an["type"] == "Rollup":
            sub(rule, "AFPlugIn", "Rollup")
            sub(rule, "ConfigString", "")
            sub(rule, "VariableMapping",
                f"SearchCriteria||Elements[@Name=*]|Attributes[@Name={an['input']}];"
                f"{an['function']}||{an['output']};[GUID]||[UNSET];")
        else:
            sub(rule, "AFPlugIn", "EventFrame")
            sub(rule, "ConfigString", f"EFTNAME={an['ef_template']};SAVETRIGGERNAME=True")
            sub(rule, "VariableMapping", "")
            pe = sub(rule, "AFAnalysisRule")
            sub(pe, "AFPlugIn", "PerformanceEquation")
            sub(pe, "ConfigString",
                f'@group("Start triggers") @name("{an["trigger_name"]}")\r\n'
                f"StartTrigger1 := {an['start_trigger']};")
            sub(pe, "VariableMapping", "")
        tr = sub(x, "AFTimeRule")
        sub(tr, "AFPlugIn", "Natural")
        sub(tr, "ConfigString", "")

    def notification_template(self, parent, n):
        x = sub(parent, "AFNotificationRuleTemplate")
        sub(x, "Name", n["name"])
        sub(x, "Description", "Sends start/stop of each Extraction Run. Add subscribers after import.")
        sub(x, "CreateEnabled", "true")
        sub(x, "MultiTriggerEventOption", "HighestSeverity")
        sub(x, "ResendInterval", "0")
        sub(x, "NonrepetitionInterval", "0")
        sub(x, "Criteria", n["criteria"])
        sub(x, "Target", n["template"])
        sub(x, "ContentExample", "")

    def element_template(self, parent, t):
        x = sub(parent, "AFElementTemplate")
        sub(x, "Name", t["name"])
        sub(x, "Description", t["desc"])
        sub(x, "BaseTemplate", t["base"] or "")
        sub(x, "Type", "None")
        sub(x, "InstanceType", "Element")
        sub(x, "AllowElementToExtend", "true")
        sub(x, "DefaultAttribute", "")
        sub(x, "NamingPattern", "")
        if t["isa"]:
            sub(x, "AFElementCategoryRef", ISA_CATEGORY.format(t["isa"]))
        for a in t["attrs"]:
            self.attribute_template(x, a)
        if self.analytics:
            for an in self.m["analyses"]:
                if an["template"] == t["name"]:
                    self.analysis_template(x, an)
            if self.m["notification"]["template"] == t["name"]:
                self.notification_template(x, self.m["notification"])

    def event_frame_template(self, parent):
        ef = self.m["event_frame_template"]
        x = sub(parent, "AFElementTemplate")
        sub(x, "Name", ef["name"])
        sub(x, "Description", ef["desc"])
        sub(x, "BaseTemplate", "")
        sub(x, "Type", "None")
        sub(x, "InstanceType", "EventFrame")
        sub(x, "AllowElementToExtend", "false")
        sub(x, "DefaultAttribute", "Total Oil Produced")
        sub(x, "NamingPattern", ef["naming"])
        sub(x, "Severity", "0")
        sub(x, "CanBeAcknowledged", "false")
        for a in ef["attrs"]:
            y = sub(x, "AFAttributeTemplate")
            sub(y, "Name", a["name"])
            sub(y, "Description", f"{a['source']} of the well, {a['method']} over the event frame."
                + ("" if self.af_uom(a["uom"]) or not a["uom"] else f" Unit: {a['uom']}."))
            for tag, val in (("IsHidden", "false"), ("IsManualDataEntry", "false"),
                             ("IsConfigurationItem", "false"), ("IsExcluded", "false"), ("IsIndexed", "false")):
                sub(y, tag, val)
            sub(y, "Trait", "")
            sub(y, "DefaultUOM", self.af_uom(a["uom"]))
            if a.get("enum"):
                sub(y, "Type", "AFEnumerationValue")
                sub(y, "TypeQualifier", f"EnumerationSets[{a['enum']}]", type="AFObject")
            else:
                sub(y, "Type", "Double")
                sub(y, "TypeQualifier", "")
                sub(y, "Value", "0", type="Double")
            sub(y, "DataReference", "PI Point")
            sub(y, "ConfigString", f".\\Elements[.]|{a['source']};TimeRangeMethod={a['method']}")
            sub(y, "AFAttributeCategoryRef", "Totals")

    # ---- elements ----------------------------------------------------------
    def element(self, parent, node, child=False):
        x = sub(parent, "AFElement", **({"ReferenceType": "Parent-Child"} if child else {}))
        sub(x, "Name", node["name"])
        sub(x, "Description", node["desc"])
        sub(x, "Template", node["template"])
        attrs = all_attrs(node["template"])
        vals = node["values"]
        for a in attrs:
            if a["kind"] == "static":
                if a["children"]:
                    kids = [c for c in a["children"] if f"{a['name']}|{c['name']}" in vals]
                    if not kids:
                        continue
                    y = sub(x, "AFAttribute")
                    sub(y, "Name", a["name"])
                    for c in kids:
                        z = sub(y, "AFAttribute")
                        sub(z, "Name", c["name"])
                        self.value(z, c, vals[f"{a['name']}|{c['name']}"])
                elif a["name"] in vals:
                    y = sub(x, "AFAttribute")
                    sub(y, "Name", a["name"])
                    self.value(y, a, vals[a["name"]])
            elif a["kind"] == "pi":
                y = sub(x, "AFAttribute")
                sub(y, "Name", a["name"])
                sub(y, "DataReference", "PI Point")
                sub(y, "ConfigString", self.element_config(node, a))
        for c in node["children"]:
            self.element(x, c, child=True)
        if self.analytics:
            names = chain(node["template"])
            for an in self.m["analyses"]:
                if an["template"] in names:
                    y = sub(x, "AFAnalysis")
                    sub(y, "Name", an["name"])
                    sub(y, "Description", "")
                    sub(y, "Template", an["name"])
                    sub(y, "CaseTemplate", "")
                    sub(y, "OutputTime", "")
                    sub(y, "Status", "Enabled")
                    sub(y, "PublishResults", "false")
                    sub(y, "Priority", "High")
                    sub(y, "MaxQueueSize", "0")
                    sub(y, "GroupID", "0")
                    tgt = sub(y, "Target")
                    sub(tgt, "AFElementRef", node["path"])
            n = self.m["notification"]
            if n["template"] in names:
                y = sub(x, "AFNotificationRule")
                sub(y, "Name", n["name"])
                sub(y, "Description", "")
                sub(y, "Status", "Enabled")
                sub(y, "MultiTriggerEventOption", "HighestSeverity")
                sub(y, "ResendInterval", "0")
                sub(y, "NonrepetitionInterval", "0")
                sub(y, "Criteria", n["criteria"])
                sub(y, "Template", f"ElementTemplates[{n['template']}]\\NotificationRuleTemplates[{n['name']}]")
                sub(y, "ContentExample", "")

    # ---- document ----------------------------------------------------------
    def build(self):
        m = self.m
        af = ET.Element("AF", {
            "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
            "xsi:noNamespaceSchemaLocation": "OSIsoft.AF.xsd",
            "SchemaVersion": "2.0",
            "SoftwareVersion": "2.10.0.0",
            "ExportMode": "NoUniqueID",
            "Database": m["database"],
            "Description": "",
            "ExportedObject": m["database"],
            "ExportedType": "AFDatabase",
            "Identity": "Database",
        })
        db = sub(af, "AFDatabase")
        sub(db, "Name", m["database"])
        sub(db, "Description", f"{m['company']['name']} — ISA-95 model. {m['company']['note']}")

        cats = []
        for t in m["templates"]:
            for a in t["attrs"]:
                for c in [a] + a["children"]:
                    if c["cat"] not in cats:
                        cats.append(c["cat"])
        if "Totals" not in cats:
            cats.append("Totals")
        for c in cats:
            sub(sub(db, "AFAttributeCategory"), "Name", c)
        for lvl in m["enums"]["ISA95 Level"]:
            sub(sub(db, "AFElementCategory"), "Name", ISA_CATEGORY.format(lvl))
        for name, values in m["enums"].items():
            es = sub(db, "AFEnumerationSet")
            sub(es, "Name", name)
            for i, v in enumerate(values):
                ev = sub(es, "AFEnumerationValue")
                sub(ev, "Name", v)
                sub(ev, "Value", i)

        self.event_frame_template(db)
        for t in m["templates"]:
            self.element_template(db, t)
        self.element(db, m["root"])
        return af


def annotate_paths(node, path=""):
    node["path"] = f"{path}\\{node['name']}" if path else node["name"]
    for c in node["children"]:
        annotate_paths(c, node["path"])


def validate(model, tree):
    """Cross-check references inside the generated document."""
    db = tree.find("AFDatabase")
    templates = {t.findtext("Name") for t in db.findall("AFElementTemplate")}
    enums = {e.findtext("Name"): {v.findtext("Name") for v in e.findall("AFEnumerationValue")}
             for e in db.findall("AFEnumerationSet")}
    acats = {c.findtext("Name") for c in db.findall("AFAttributeCategory")}
    ecats = {c.findtext("Name") for c in db.findall("AFElementCategory")}
    errors = []
    for t in db.findall("AFElementTemplate"):
        base = t.findtext("BaseTemplate")
        if base and base not in templates:
            errors.append(f"template {t.findtext('Name')}: unknown base {base}")
        for c in t.findall("AFElementCategoryRef"):
            if c.text not in ecats:
                errors.append(f"unknown element category {c.text}")
    for c in db.iter("AFAttributeCategoryRef"):
        if c.text not in acats:
            errors.append(f"unknown attribute category {c.text}")
    for q in db.iter("TypeQualifier"):
        if q.text and q.text[len("EnumerationSets["):-1] not in enums:
            errors.append(f"unknown enumeration set {q.text}")
    for v in db.iter("Value"):
        if v.get("type") == "AFEnumerationValue":
            s, val = v.text[len("EnumerationSets["):].split("]\\")
            if val not in enums.get(s, ()):
                errors.append(f"bad enum value {v.text}")
    for e in db.iter("AFElement"):
        if e.findtext("Template") not in templates:
            errors.append(f"element {e.findtext('Name')}: unknown template")
    return errors


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-analytics", action="store_true",
                    help="leave out analyses and notification rules (fallback import)")
    ap.add_argument("-o", "--output")
    args = ap.parse_args()

    model = json.loads((ROOT / "model" / "model.json").read_text(encoding="utf-8"))
    annotate_paths(model["root"])
    tree = Builder(model, analytics=not args.no_analytics).build()
    errors = validate(model, tree)
    if errors:
        print("\n".join(errors))
        sys.exit(1)
    ET.indent(tree, space="  ")
    name = "CordilleraPetroleo_NoAnalytics.xml" if args.no_analytics else "CordilleraPetroleo.xml"
    out = Path(args.output) if args.output else ROOT / "af" / name
    xml = ET.tostring(tree, encoding="unicode", xml_declaration=False)
    out.write_text('<?xml version="1.0" encoding="utf-8"?>\n' + xml + "\n", encoding="utf-8-sig")
    db = tree.find("AFDatabase")
    print(f"{out.relative_to(ROOT)}: {sum(1 for _ in db.iter('AFElement'))} elements, "
          f"{len(db.findall('AFElementTemplate'))} templates, "
          f"{sum(1 for _ in db.iter('AFAnalysis'))} analyses, "
          f"{sum(1 for _ in db.iter('AFNotificationRule'))} notification rules, "
          f"{out.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
