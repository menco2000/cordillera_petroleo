#!/usr/bin/env python3
"""Single source of truth for the Cordillera Petróleo AF model.

Everything else (AF XML generator, simulator, docs page) reads the JSON this
script writes, so the hierarchy, templates and tag names never drift.

    python model/spec.py            -> writes model/model.json

Naming rules
  * Element names are human names ("Garzas-01", "Crude Charge Pump").
  * PI tags are built from asset IDs: CP.<SITE>.<ASSET>.<SUFFIX>  (CP.BAR.P101.FLOW)
  * Hierarchy depth is at most 5: Enterprise > Site > Area > Work Center > Work Unit.
"""
import datetime as dt
import json
import math
import random
from pathlib import Path

SEED = 20261021
MAX_DEPTH = 5
POINT_SOURCE = "L"  # Lab point source
COMPANY = {
    "name": "Cordillera Petróleo S.A.",
    "code": "CP",
    "hq_city": "Bogotá",
    "hq_country": "Colombia",
    "note": "Fictional company for simulation and training purposes.",
}

# Display unit -> AF UOM abbreviation. Only units present in the default AF UOM
# database are mapped; anything else is left without an AF UOM (the unit still
# goes to the PI point engunits and the attribute description).
AF_UOM = {
    "psig": "psi", "psia": "psia", "psi": "psi", "bbl/d": "bbl/d", "bbl": "bbl", "°F": "°F",
    "%": "%", "A": "A", "Hz": "Hz", "rpm": "rpm", "ft": "ft", "in": "in", "m": "m", "km": "km",
    "hp": "hp", "ppm": "ppm", "mmHg": "mmHg", "gpm": "US gal/min", "lbf": "lbf", "°": "°",
    "MMBtu/h": "MM Btu/h",
}

# --------------------------------------------------------------------------
# Attribute helpers
#   static  : configuration item, value stored in AF
#   pi      : PI Point data reference, tag = <Tag Prefix>.<tag>
#             src = "sim"      written by the simulator
#                   "analysis" written by an AF rollup analysis
#                   "ref"      points at a tag owned by another element (no new PI point)
#   formula : AF Formula data reference over sibling attributes
# --------------------------------------------------------------------------

def S(name, type="String", uom=None, enum=None, desc="", children=None, cat="Metadata"):
    return {"name": name, "kind": "static", "type": type, "uom": uom, "enum": enum,
            "desc": desc, "cat": cat, "children": children or []}


def P(name, tag, uom=None, type="Float32", enum=None, desc="", cat="Process", src="sim"):
    return {"name": name, "kind": "pi", "tag": tag, "type": type, "uom": uom, "enum": enum,
            "desc": desc, "cat": cat, "src": src, "children": []}


def F(name, vars, expr, uom=None, desc="", cat="Calculated"):
    """vars: {"A": "Oil Rate", ...}; expr uses the variable letters, e.g. "A+B"."""
    readable = expr
    for k, v in vars.items():
        readable = readable.replace(k, f"‹{v}›")
    return {"name": name, "kind": "formula", "vars": vars, "expr": expr, "readable": readable,
            "type": "Double", "uom": uom, "desc": desc, "cat": cat, "children": []}


def D(name, enum, tag, desc="", src="sim"):
    """Status tag: Int32 PI point read through an AF enumeration set."""
    return P(name, tag, type="Enum", enum=enum, desc=desc, cat="Status", src=src)


# --------------------------------------------------------------------------
# Enumeration sets
# --------------------------------------------------------------------------
ENUMS = {
    "ISA95 Level": ["Enterprise", "Site", "Area", "Work Center", "Work Unit", "Equipment Module"],
    "Area Type": ["Upstream Production", "Crude Receiving", "Processing", "Product Storage", "Utilities"],
    "Lift Method": ["Natural Flow", "ESP", "Rod Pump", "Gas Lift", "PCP"],
    "Well Status": ["Shut-In", "Producing", "Starting Up", "Tripped", "Workover"],
    "Equipment Status": ["Stopped", "Running", "Tripped", "Maintenance"],
    "Unit Status": ["Shutdown", "Startup", "Normal Operation", "Reduced Rate", "Upset"],
    "Product": ["Crude Oil", "Gasoline", "Jet Kerosene", "Diesel", "Fuel Oil"],
    "Sim Scenario": ["Normal", "Natural Decline", "Water Breakthrough", "Gas Interference",
                     "Sand Production", "ESP Pump Wear", "Rod Pump Fluid Pound",
                     "Planned Shut-In", "Power Outage", "Workover",
                     "Heater Fouling", "Vacuum Loss", "Compressor Trip", "Cooling Tower Degraded"],
}

# --------------------------------------------------------------------------
# Element templates. Base templates are listed before the ones deriving from them.
# --------------------------------------------------------------------------
T = []


def template(name, base, isa, desc, attrs, category="Equipment"):
    T.append({"name": name, "base": base, "isa": isa, "desc": desc, "attrs": attrs,
              "category": category})


template("Asset Base", None, None,
         "Root template. Every element inherits identity and the tag prefix used to build PI Point names.", [
             S("Asset ID", desc="Unique asset code. PI tags are built from it."),
             S("Description"),
             S("ISA-95 Level", "Enum", enum="ISA95 Level"),
             S("Tag Prefix", desc="PI tag root, e.g. CP.BAR.W01. Used by every PI Point data reference.",
               cat="Configuration"),
         ], "Base")

template("Enterprise", "Asset Base", "Enterprise", "Company level. Rolls up production and refining from all sites.", [
    S("Company Name"),
    S("Headquarters City"),
    S("Headquarters Country"),
    S("Number of Sites", "Int32"),
    P("Total Oil Production", "QO", "bbl/d", src="analysis", cat="Totals",
      desc="Rollup: sum of Field Oil Rate of all sites"),
    P("Total Refinery Throughput", "THRU", "bbl/d", src="analysis", cat="Totals",
      desc="Rollup: sum of Refinery Throughput of all sites"),
], "Hierarchy")

template("Site", "Asset Base", "Site", "Metropolitan operating site: one oil field plus one refinery.", [
    S("Site Code"),
    S("Country"),
    S("State / Province"),
    S("City"),
    S("Time Zone"),
    S("Basin"),
    S("Location", children=[S("Latitude", "Double", "°"), S("Longitude", "Double", "°"),
                            S("Elevation", "Double", "m")], cat="Location"),
    S("Refinery Nameplate Capacity", "Double", "bbl/d"),
    P("Field Oil Rate", "WF.QO", "bbl/d", src="ref", cat="Totals", desc="Same tag as Wellfield|Total Oil Rate"),
    P("Field Water Rate", "WF.QW", "bbl/d", src="ref", cat="Totals", desc="Same tag as Wellfield|Total Water Rate"),
    P("Field Gas Rate", "WF.QG", "Mscf/d", src="ref", cat="Totals", desc="Same tag as Wellfield|Total Gas Rate"),
    P("Refinery Throughput", "CDU100.THRU", "bbl/d", src="ref", cat="Totals",
      desc="Same tag as Atmospheric Distillation Unit|Throughput"),
], "Hierarchy")

template("Area", "Asset Base", "Area", "ISA-95 area inside a site.", [
    S("Area Type", "Enum", enum="Area Type"),
], "Hierarchy")

template("Wellfield", "Asset Base", "Work Center", "ISA-95 work center grouping all producing wells of the site.", [
    S("Field Name"),
    S("Formation"),
    S("Number of Wells", "Int32"),
    P("Total Oil Rate", "QO", "bbl/d", src="analysis", cat="Totals", desc="Rollup: sum of child wells Oil Rate"),
    P("Total Water Rate", "QW", "bbl/d", src="analysis", cat="Totals", desc="Rollup: sum of child wells Water Rate"),
    P("Total Gas Rate", "QG", "Mscf/d", src="analysis", cat="Totals", desc="Rollup: sum of child wells Gas Rate"),
    P("Producing Wells", "NPROD", type="Int32", cat="Totals"),
    F("Field Water Cut", {"A": "Total Oil Rate", "B": "Total Water Rate"}, "B/(A+B+0.001)*100", "%"),
], "Hierarchy")

template("Process Unit", "Asset Base", "Work Center",
         "ISA-95 production unit (ISA-88 process cell) for continuous processing.", [
             S("Design Capacity", "Double", "bbl/d"),
             D("Unit Status", "Unit Status", "STATUS"),
             D("Sim Scenario", "Sim Scenario", "SCEN", "Active simulator scenario for this unit."),
             P("Throughput", "THRU", "bbl/d"),
             F("Utilization", {"A": "Throughput", "B": "Design Capacity"}, "A/(B+0.001)*100", "%"),
         ], "Hierarchy")

template("Utility System", "Asset Base", "Work Center", "ISA-95 work center for steam and cooling water services.", [
    S("Service"),
    D("System Status", "Unit Status", "STATUS"),
    D("Sim Scenario", "Sim Scenario", "SCEN", "Active simulator scenario for this system."),
], "Hierarchy")

template("Storage Zone", "Asset Base", "Work Center", "ISA-95 storage zone (tank farm).", [
    S("Number of Tanks", "Int32"),
    S("Total Capacity", "Double", "bbl"),
    P("Total Inventory", "INV", "bbl", src="analysis", cat="Totals", desc="Rollup: sum of child tanks Inventory"),
    F("Fill Level", {"A": "Total Inventory", "B": "Total Capacity"}, "A/(B+0.001)*100", "%"),
], "Hierarchy")

# ---- Wells ---------------------------------------------------------------
template("Well", "Asset Base", "Work Unit",
         "Producing oil well. Holds the extraction analysis and notification rule; lift-specific templates derive from it.", [
             S("UWI", desc="Unique well identifier"),
             S("Lift Method", "Enum", enum="Lift Method"),
             S("Field Name"),
             S("Formation"),
             S("Municipality"),
             S("Spud Date", "DateTime"),
             S("Completion Date", "DateTime"),
             S("Total Depth", "Double", "ft"),
             S("Perforation Top", "Double", "ft"),
             S("Perforation Bottom", "Double", "ft"),
             S("Location", children=[S("Latitude", "Double", "°"), S("Longitude", "Double", "°"),
                                     S("Ground Elevation", "Double", "m")], cat="Location"),
             S("Static Reservoir Pressure", "Double", "psia", cat="Reservoir"),
             S("Reservoir Temperature", "Double", "°F", cat="Reservoir"),
             S("Oil API Gravity", "Double", "°API", cat="Reservoir"),
             S("Productivity Index", "Double", "bbl/d/psi", cat="Reservoir"),
             S("Design Oil Rate", "Double", "bbl/d", cat="Reservoir"),
             D("Well Status", "Well Status", "STATUS"),
             D("Sim Scenario", "Sim Scenario", "SCEN", "Active simulator scenario. Useful as a label for ML training."),
             P("Tubing Head Pressure", "THP", "psig"),
             P("Casing Head Pressure", "CHP", "psig"),
             P("Flowline Pressure", "FLP", "psig"),
             P("Wellhead Temperature", "WHT", "°F"),
             P("Choke Opening", "CHOKE", "%"),
             P("Bottomhole Pressure", "BHP", "psia", desc="Permanent downhole gauge"),
             P("Bottomhole Temperature", "BHT", "°F"),
             P("Oil Rate", "QO", "bbl/d"),
             P("Water Rate", "QW", "bbl/d"),
             P("Gas Rate", "QG", "Mscf/d", desc="Formation gas, excludes lift gas"),
             P("Oil Volume Today", "DAYOIL", "bbl", desc="Resets at 00:00 site time"),
             P("Cumulative Oil", "CUMOIL", "bbl"),
             F("Liquid Rate", {"A": "Oil Rate", "B": "Water Rate"}, "A+B", "bbl/d"),
             F("Water Cut", {"A": "Oil Rate", "B": "Water Rate"}, "B/(A+B+0.001)*100", "%"),
             F("Gas-Oil Ratio", {"A": "Gas Rate", "B": "Oil Rate"}, "A*1000/(B+0.001)", "scf/bbl"),
             F("Drawdown", {"A": "Static Reservoir Pressure", "B": "Bottomhole Pressure"}, "A-B", "psi"),
         ], "Well")

template("Well - Natural Flow", "Well", "Work Unit", "Flowing well, no artificial lift.", [
    S("Choke Size", "Int32", desc="64ths of an inch", cat="Completion"),
], "Well")

template("Well - ESP", "Well", "Work Unit", "Electric submersible pump.", [
    S("Pump Model", cat="Completion"),
    S("Pump Stages", "Int32", cat="Completion"),
    S("Motor Rating", "Double", "hp", cat="Completion"),
    S("Pump Setting Depth", "Double", "ft", cat="Completion"),
    P("Pump Intake Pressure", "PIP", "psig", cat="Lift"),
    P("Pump Discharge Pressure", "PDP", "psig", cat="Lift"),
    P("Motor Temperature", "MOTT", "°F", cat="Lift"),
    P("Motor Current", "AMPS", "A", cat="Lift"),
    P("VSD Frequency", "FREQ", "Hz", cat="Lift"),
    P("Vibration", "VIB", "g", cat="Lift", desc="Acceleration in g"),
], "Well")

template("Well - Rod Pump", "Well", "Work Unit", "Beam pumping unit with sucker rods.", [
    S("Pumping Unit Size", desc="API designation", cat="Completion"),
    S("Stroke Length", "Double", "in", cat="Completion"),
    S("Plunger Diameter", "Double", "in", cat="Completion"),
    S("Pump Setting Depth", "Double", "ft", cat="Completion"),
    P("Strokes Per Minute", "SPM", "spm", cat="Lift"),
    P("Pump Fillage", "FILL", "%", cat="Lift"),
    P("Peak Polished Rod Load", "PPRL", "lbf", cat="Lift"),
    P("Min Polished Rod Load", "MPRL", "lbf", cat="Lift"),
    P("Motor Current", "AMPS", "A", cat="Lift"),
    P("Runtime Today", "RUNT", "%", cat="Lift"),
], "Well")

template("Well - Gas Lift", "Well", "Work Unit", "Continuous gas lift.", [
    S("Operating Valve Depth", "Double", "ft", cat="Completion"),
    S("Number of Gas Lift Valves", "Int32", cat="Completion"),
    P("Gas Injection Rate", "QGI", "Mscf/d", cat="Lift"),
    P("Gas Injection Pressure", "PGI", "psig", cat="Lift"),
    P("Injection Choke Opening", "GLCHOKE", "%", cat="Lift"),
], "Well")

template("Well - PCP", "Well", "Work Unit", "Progressing cavity pump.", [
    S("Pump Model", cat="Completion"),
    S("Rotor Depth", "Double", "ft", cat="Completion"),
    S("Max Rotor Speed", "Double", "rpm", cat="Completion"),
    P("Rotor Speed", "RPM", "rpm", cat="Lift"),
    P("Drive Torque", "TRQ", "ft·lbf", cat="Lift"),
    P("Motor Current", "AMPS", "A", cat="Lift"),
], "Well")

# ---- Equipment -------------------------------------------------------------
template("Equipment Base", "Asset Base", "Equipment Module", "Common nameplate data for physical equipment.", [
    S("Manufacturer", cat="Nameplate"),
    S("Model", cat="Nameplate"),
    S("Installation Date", "DateTime", cat="Nameplate"),
], "Base")

template("Separator", "Equipment Base", "Work Unit", "Three-phase separator (field gathering and hydrotreater HP separator).", [
    S("Design Pressure", "Double", "psig"),
    P("Pressure", "PRES", "psig"),
    P("Temperature", "TEMP", "°F"),
    P("Liquid Level", "LVL", "%"),
    P("Interface Level", "ILVL", "%"),
    P("Oil Outlet Flow", "QO", "bbl/d"),
    P("Water Outlet Flow", "QW", "bbl/d"),
    P("Gas Outlet Flow", "QG", "Mscf/d"),
])

template("Pump", "Equipment Base", "Equipment Module", "Centrifugal pump.", [
    S("Rated Flow", "Double", "bbl/d"),
    S("Rated Head", "Double", "ft"),
    S("Motor Rating", "Double", "hp"),
    D("Run Status", "Equipment Status", "STATUS"),
    P("Suction Pressure", "PS", "psig"),
    P("Discharge Pressure", "PD", "psig"),
    P("Flow", "FLOW", "bbl/d"),
    P("Motor Current", "AMPS", "A"),
    P("Vibration", "VIB", "mm/s"),
    P("Bearing Temperature", "BRGT", "°F"),
    F("Differential Pressure", {"A": "Discharge Pressure", "B": "Suction Pressure"}, "A-B", "psi"),
])

template("Pipeline", "Equipment Base", "Work Unit", "Crude transfer line from the field to the refinery.", [
    S("Length", "Double", "km"),
    S("Diameter", "Double", "in"),
    S("MAOP", "Double", "psig", desc="Maximum allowable operating pressure"),
    P("Inlet Pressure", "PIN", "psig"),
    P("Outlet Pressure", "POUT", "psig"),
    P("Inlet Flow", "QIN", "bbl/d"),
    P("Outlet Flow", "QOUT", "bbl/d"),
    F("Pressure Drop", {"A": "Inlet Pressure", "B": "Outlet Pressure"}, "A-B", "psi"),
    F("Flow Imbalance", {"A": "Inlet Flow", "B": "Outlet Flow"}, "(A-B)/(A+0.001)*100", "%",
      desc="Leak indicator"),
])

template("Tank", "Equipment Base", "Work Unit", "Atmospheric storage tank.", [
    S("Product", "Enum", enum="Product"),
    S("Nominal Capacity", "Double", "bbl"),
    S("Max Fill Height", "Double", "ft"),
    S("Diameter", "Double", "ft"),
    P("Level", "LVL", "ft"),
    P("Temperature", "TEMP", "°F"),
    P("Inlet Flow", "QIN", "bbl/d"),
    P("Outlet Flow", "QOUT", "bbl/d"),
    P("Inventory", "INV", "bbl"),
    F("Level Percent", {"A": "Level", "B": "Max Fill Height"}, "A/(B+0.001)*100", "%"),
    F("Available Capacity", {"A": "Nominal Capacity", "B": "Inventory"}, "A-B", "bbl"),
])

template("Desalter", "Equipment Base", "Work Unit", "Electrostatic crude desalter.", [
    P("Inlet Temperature", "TIN", "°F"),
    P("Operating Pressure", "PRES", "psig"),
    P("Wash Water Rate", "QWW", "bbl/d"),
    P("Interface Level", "ILVL", "%"),
    P("Grid Current", "AMPS", "A"),
    P("Outlet Salt Content", "SALT", "PTB", desc="Pounds per thousand barrels"),
])

template("Fired Heater", "Equipment Base", "Work Unit", "Process furnace.", [
    S("Design Duty", "Double", "MMBtu/h"),
    S("Max Tube Metal Temperature", "Double", "°F"),
    P("Inlet Temperature", "TIN", "°F"),
    P("Coil Outlet Temperature", "COT", "°F"),
    P("Fuel Gas Flow", "QFG", "Mscf/d"),
    P("Fuel Gas Pressure", "PFG", "psig"),
    P("Excess O2", "O2", "%"),
    P("Stack Temperature", "TSTK", "°F"),
    P("Bridgewall Temperature", "TBW", "°F"),
    P("Tube Metal Temperature", "TMT", "°F", desc="Hottest skin thermocouple"),
    F("Temperature Rise", {"A": "Coil Outlet Temperature", "B": "Inlet Temperature"}, "A-B", "°F"),
])

template("Distillation Column", "Equipment Base", "Work Unit", "Base for fractionation columns.", [
    S("Number of Trays", "Int32"),
    P("Feed Flow", "QF", "bbl/d"),
    P("Top Temperature", "TTOP", "°F"),
    P("Bottom Temperature", "TBOT", "°F"),
    P("Reflux Flow", "QREF", "bbl/d"),
    P("Bottoms Level", "LVL", "%"),
    P("Differential Pressure", "DP", "psi"),
])

template("Atmospheric Column", "Distillation Column", "Work Unit", "Crude atmospheric fractionator.", [
    P("Top Pressure", "PTOP", "psig"),
    P("Flash Zone Temperature", "TFZ", "°F"),
    P("Naphtha Draw", "QNAP", "bbl/d"),
    P("Kerosene Draw", "QKER", "bbl/d"),
    P("Diesel Draw", "QDSL", "bbl/d"),
    P("Atmospheric Residue Flow", "QRES", "bbl/d"),
])

template("Vacuum Column", "Distillation Column", "Work Unit", "Vacuum fractionator fed with atmospheric residue.", [
    P("Top Pressure", "PTOP", "mmHg", desc="Absolute"),
    P("Flash Zone Pressure", "PFZ", "mmHg", desc="Absolute"),
    P("Flash Zone Temperature", "TFZ", "°F"),
    P("LVGO Draw", "QLVGO", "bbl/d"),
    P("HVGO Draw", "QHVGO", "bbl/d"),
    P("Vacuum Residue Flow", "QVR", "bbl/d"),
    P("Wash Oil Flow", "QWO", "bbl/d"),
])

template("Vacuum Ejector System", "Equipment Base", "Equipment Module",
         "Steam ejectors and condensers that hold the vacuum column pressure.", [
             S("Number of Stages", "Int32"),
             P("Motive Steam Pressure", "PSTM", "psig"),
             P("Motive Steam Flow", "QSTM", "lb/h"),
             P("Suction Pressure", "PSUC", "mmHg", desc="Absolute"),
             P("Cooling Water Inlet Temperature", "TCWI", "°F"),
             P("Condenser Outlet Temperature", "TCO", "°F"),
             P("Hotwell Level", "LVL", "%"),
         ])

template("Reactor", "Equipment Base", "Work Unit", "Fixed-bed hydrotreating reactor.", [
    S("Catalyst Load Date", "DateTime"),
    P("Feed Rate", "QF", "bbl/d"),
    P("Inlet Temperature", "TIN", "°F"),
    P("Outlet Temperature", "TOUT", "°F"),
    P("Reactor Pressure", "PRES", "psig"),
    P("Pressure Drop", "DP", "psi"),
    P("Hydrogen Flow", "QH2", "Mscf/d"),
    P("Product Sulfur", "SULF", "ppm"),
    F("Temperature Rise", {"A": "Outlet Temperature", "B": "Inlet Temperature"}, "A-B", "°F"),
])

template("Compressor", "Equipment Base", "Equipment Module", "Centrifugal recycle gas compressor.", [
    S("Rated Flow", "Double", "Mscf/d"),
    D("Run Status", "Equipment Status", "STATUS"),
    P("Suction Pressure", "PS", "psig"),
    P("Discharge Pressure", "PD", "psig"),
    P("Discharge Temperature", "TD", "°F"),
    P("Flow", "FLOW", "Mscf/d"),
    P("Speed", "SPD", "rpm"),
    P("Vibration", "VIB", "mil"),
    P("Motor Current", "AMPS", "A"),
    F("Compression Ratio", {"A": "Discharge Pressure", "B": "Suction Pressure"}, "(A+14.7)/(B+14.7)", None),
])

template("Boiler", "Equipment Base", "Work Unit", "Steam boiler.", [
    S("Rated Steam Capacity", "Double", "lb/h"),
    D("Run Status", "Equipment Status", "STATUS"),
    P("Steam Flow", "QSTM", "lb/h"),
    P("Steam Pressure", "PSTM", "psig"),
    P("Steam Temperature", "TSTM", "°F"),
    P("Drum Level", "LVL", "%"),
    P("Feedwater Flow", "QFW", "lb/h"),
    P("Fuel Gas Flow", "QFG", "Mscf/d"),
    P("Excess O2", "O2", "%"),
    P("Stack Temperature", "TSTK", "°F"),
])

template("Cooling Tower", "Equipment Base", "Work Unit", "Induced-draft cooling tower.", [
    S("Design Circulation", "Double", "gpm"),
    D("Fan Status", "Equipment Status", "STATUS"),
    P("Supply Temperature", "TSUP", "°F"),
    P("Return Temperature", "TRET", "°F"),
    P("Wet Bulb Temperature", "TWB", "°F"),
    P("Circulation Flow", "QCW", "gpm"),
    P("Makeup Water Flow", "QMU", "gpm"),
    P("Basin Level", "LVL", "%"),
    F("Range", {"A": "Return Temperature", "B": "Supply Temperature"}, "A-B", "°F"),
    F("Approach", {"A": "Supply Temperature", "B": "Wet Bulb Temperature"}, "A-B", "°F"),
])

TEMPLATES = {t["name"]: t for t in T}


def chain(name):
    out = []
    while name:
        out.insert(0, name)
        name = TEMPLATES[name]["base"]
    return out


def all_attrs(name):
    attrs = []
    for t in chain(name):
        attrs.extend(TEMPLATES[t]["attrs"])
    return attrs


# --------------------------------------------------------------------------
# Sites. Climate values drive the simulator (°F); utc is the fixed offset (no DST).
# --------------------------------------------------------------------------
SITES = [
    dict(code="BAR", city="Barrancabermeja", state="Santander", country="Colombia", lat=7.0653, lon=-73.8547,
         elev=75, tz="SA Pacific Standard Time", utc=-5, basin="Middle Magdalena Valley", field="Campo Las Garzas",
         short="Garzas", formation="Mugrosa / Colorado", lift=["Rod Pump"] * 4 + ["ESP"] * 2 + ["PCP"] * 2,
         api=(19, 25), depth=(5500, 9000), bearings=None, t_amb=84, t_amp=9, wb_dep=7),
    dict(code="MCB", city="Maracaibo", state="Zulia", country="Venezuela", lat=10.6545, lon=-71.6406,
         elev=6, tz="Venezuela Standard Time", utc=-4, basin="Maracaibo Basin", field="Campo Lago Azul",
         short="Azul", formation="Lagunillas / Misoa", lift=["Gas Lift"] * 6 + ["Rod Pump"] * 3 + ["ESP"],
         api=(17, 32), depth=(4000, 12000), bearings=None, t_amb=85, t_amp=8, wb_dep=8),
    dict(code="NQN", city="Neuquén", state="Neuquén", country="Argentina", lat=-38.9516, lon=-68.0591,
         elev=270, tz="Argentina Standard Time", utc=-3, basin="Neuquén Basin", field="Bloque Cerro Viento",
         short="Viento", formation="Vaca Muerta",
         lift=["Natural Flow"] * 3 + ["Gas Lift"] * 2 + ["ESP"] * 2 + ["Rod Pump"] * 2,
         api=(38, 46), depth=(9000, 13500), bearings=None, t_amb=62, t_amp=14, wb_dep=15),
    dict(code="CRD", city="Comodoro Rivadavia", state="Chubut", country="Argentina", lat=-45.8641, lon=-67.4966,
         elev=60, tz="Argentina Standard Time", utc=-3, basin="Golfo San Jorge Basin", field="Yacimiento Pampa Fría",
         short="Pampa", formation="Comodoro Rivadavia / Mina del Carmen", lift=["Rod Pump"] * 4 + ["PCP"] * 2,
         api=(20, 27), depth=(3500, 8000), bearings=(200, 340), t_amb=55, t_amp=10, wb_dep=11),
    dict(code="MOS", city="Mossoró", state="Rio Grande do Norte", country="Brazil", lat=-5.1878, lon=-37.3441,
         elev=18, tz="SA Eastern Standard Time", utc=-3, basin="Potiguar Basin", field="Campo Serra Dourada",
         short="Dourada", formation="Açu", lift=["Rod Pump"] * 3 + ["PCP"] * 2,
         api=(24, 34), depth=(2000, 4500), bearings=(120, 250), t_amb=84, t_amp=10, wb_dep=11),
    dict(code="TAL", city="Talara", state="Piura", country="Peru", lat=-4.5772, lon=-81.2719,
         elev=10, tz="SA Pacific Standard Time", utc=-5, basin="Talara Basin", field="Lote Cabo Seco",
         short="Cabo", formation="Mogollón / Pariñas", lift=["Rod Pump"] * 3 + ["Gas Lift"] * 3 + ["Natural Flow"],
         api=(32, 38), depth=(3000, 8000), bearings=(20, 160), t_amb=76, t_amp=7, wb_dep=8),
    dict(code="LAG", city="Nueva Loja", state="Sucumbíos", country="Ecuador", lat=0.0847, lon=-76.8828,
         elev=300, tz="SA Pacific Standard Time", utc=-5, basin="Oriente Basin", field="Bloque Río Verde",
         short="Verde", formation="Napo U / Hollín", lift=["ESP"] * 5 + ["Natural Flow"],
         api=(24, 30), depth=(8500, 10500), bearings=None, t_amb=79, t_amp=8, wb_dep=5),
    dict(code="SCZ", city="Santa Cruz de la Sierra", state="Santa Cruz", country="Bolivia", lat=-17.7833,
         lon=-63.1821, elev=416, tz="SA Western Standard Time", utc=-4, basin="Subandean Basin",
         field="Campo Monte Chaco", short="Chaco", formation="Petaca / Yecua",
         lift=["Natural Flow"] * 2 + ["Gas Lift"] * 2,
         api=(42, 55), depth=(7000, 11000), bearings=None, t_amb=78, t_amp=11, wb_dep=9),
]

LIFT_TEMPLATE = {"Natural Flow": "Well - Natural Flow", "ESP": "Well - ESP", "Rod Pump": "Well - Rod Pump",
                 "Gas Lift": "Well - Gas Lift", "PCP": "Well - PCP"}
DESIGN_RATE = {"Natural Flow": (800, 2500), "ESP": (700, 2200), "Gas Lift": (300, 1200),
               "Rod Pump": (60, 450), "PCP": (150, 700)}


def offset(lat, lon, km, bearing_deg):
    b = math.radians(bearing_deg)
    dlat = km * math.cos(b) / 111.32
    dlon = km * math.sin(b) / (111.32 * math.cos(math.radians(lat)))
    return round(lat + dlat, 5), round(lon + dlon, 5)


def date(rng, y0, y1):
    return f"{rng.randint(y0, y1)}-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}"


def add_days(d, n):
    return (dt.date.fromisoformat(d) + dt.timedelta(days=n)).isoformat()


def el(name, template, desc, asset_id, tag, values=None, children=None, isa=None, sim=None):
    v = {"Asset ID": asset_id, "Description": desc, "Tag Prefix": tag}
    if isa:
        v["ISA-95 Level"] = isa
    v.update(values or {})
    return {"name": name, "id": asset_id, "template": template, "desc": desc, "tag_prefix": tag,
            "values": v, "children": children or [], "isa": isa, "sim": sim or {}}


def make_well(rng, site, i, lift):
    wid = f"W{i:02d}"
    lo, hi = site["bearings"] or (0, 360)
    lat, lon = offset(site["lat"], site["lon"], rng.uniform(6, 30), rng.uniform(lo, hi))
    td = round(rng.uniform(*site["depth"]), -1)
    perf_top = round(td - rng.uniform(250, 900), -1)
    perf_bot = round(min(perf_top + rng.uniform(40, 250), td - 30), -1)
    pr = round(0.433 * perf_top * rng.uniform(0.55, 0.95), -1)
    rate = round(rng.uniform(*DESIGN_RATE[lift]), -1)
    pi_index = round(rate / (pr * rng.uniform(0.3, 0.6)), 2)
    api = round(rng.uniform(*site["api"]), 1)
    spud = date(rng, 2008, 2023)
    desc = f"{lift} producer, {site['field']}"
    v = {
        "UWI": f"{site['country'][:2].upper()}-{site['code']}-{spud[:4]}-{i:03d}",
        "Lift Method": lift, "Field Name": site["field"], "Formation": site["formation"],
        "Municipality": site["city"], "Spud Date": spud, "Completion Date": add_days(spud, rng.randint(35, 95)),
        "Total Depth": td, "Perforation Top": perf_top, "Perforation Bottom": perf_bot,
        "Location|Latitude": lat, "Location|Longitude": lon,
        "Location|Ground Elevation": round(site["elev"] + rng.uniform(-15, 60)),
        "Static Reservoir Pressure": pr,
        "Reservoir Temperature": round(80 + 0.0155 * perf_top),
        "Oil API Gravity": api,
        "Productivity Index": pi_index,
        "Design Oil Rate": rate,
    }
    pump_depth = round(perf_top - rng.uniform(150, 400), -1)
    if lift == "Natural Flow":
        v["Choke Size"] = rng.choice([24, 28, 32, 40, 48])
    elif lift == "ESP":
        v.update({"Pump Model": "ESP 538-series (generic)", "Pump Stages": rng.randint(120, 320),
                  "Motor Rating": rng.choice([150, 200, 250, 300, 400]), "Pump Setting Depth": pump_depth})
    elif lift == "Rod Pump":
        v.update({"Pumping Unit Size": rng.choice(["C-228D-213-86", "C-320D-256-120", "C-456D-305-144",
                                                   "C-640D-365-168"]),
                  "Stroke Length": rng.choice([86, 120, 144, 168]),
                  "Plunger Diameter": rng.choice([1.5, 1.75, 2.0, 2.25]), "Pump Setting Depth": pump_depth})
    elif lift == "Gas Lift":
        v.update({"Operating Valve Depth": pump_depth, "Number of Gas Lift Valves": rng.randint(4, 8)})
    elif lift == "PCP":
        v.update({"Pump Model": "PCP 40-1200 (generic)", "Rotor Depth": pump_depth,
                  "Max Rotor Speed": rng.choice([300, 350, 400, 450])})
    shale = site["code"] == "NQN"
    sim = {  # parameters only the simulator uses
        "decline_per_year": round(rng.uniform(0.6, 0.9) if shale else rng.uniform(0.08, 0.3), 3),
        "b_factor": round(rng.uniform(0.8, 1.2) if shale else rng.uniform(0.3, 0.7), 2),
        "age_days": (dt.date(2026, 7, 1) - dt.date.fromisoformat(v["Completion Date"])).days,
        "water_cut": round(rng.uniform(0.05, 0.25) if shale else rng.uniform(0.2, 0.75), 3),
        "gor": round(rng.uniform(800, 2500) if api > 38 else rng.uniform(150, 700)),
        "choke": round(rng.uniform(55, 85), 1),
        "pump_depth": pump_depth,
    }
    return el(f"{site['short']}-{i:02d}", LIFT_TEMPLATE[lift], desc, f"{site['code']}-{wid}",
              f"CP.{site['code']}.{wid}", v, isa="Work Unit", sim=sim)


def eq(site, name, eq_id, template, desc, values=None):
    v = {"Manufacturer": "Generic", "Model": "—"}
    v.update(values or {})
    return el(name, template, desc, f"{site['code']}-{eq_id}", f"CP.{site['code']}.{eq_id.replace('-', '')}",
              v, isa=TEMPLATES[template]["isa"])


def wc(site, name, code, template, desc, values=None, children=None):
    return el(name, template, desc, f"{site['code']}-{code}", f"CP.{site['code']}.{code}", values, children,
              isa="Work Center")


def area(site, name, atype, code, children):
    return el(name, "Area", name, f"{site['code']}-{code}", f"CP.{site['code']}.{code}", {"Area Type": atype},
              children, isa="Area")


def current_factor(sim):
    """Arps decline factor at the simulation start (same formula the simulator uses)."""
    return (1 + sim["b_factor"] * sim["decline_per_year"] * sim["age_days"] / 365.0) ** (-1.0 / sim["b_factor"])


def round_up(x, step):
    return int(math.ceil(x / step) * step)


def make_site(rng, s):
    wells = [make_well(rng, s, i + 1, lift) for i, lift in enumerate(s["lift"])]
    # size the refinery on today's (declined) production, not on the original design rates
    field_rate = sum(w["values"]["Design Oil Rate"] * current_factor(w["sim"]) for w in wells)
    cap = round_up(field_rate * 1.2, 250)
    crude_tank = round_up(cap * 2.5, 5000)  # ~2.5 days each
    split = {"Gasoline": 0.25, "Jet Kerosene": 0.15, "Diesel": 0.35, "Fuel Oil": 0.25}

    def tank(name, tid, product, capacity, desc):
        h = 48.0
        dia = round(math.sqrt(capacity * 5.615 / (math.pi / 4 * h)), 1)
        return eq(s, name, tid, "Tank", desc, {"Product": product, "Nominal Capacity": capacity,
                                               "Max Fill Height": h, "Diameter": dia})

    upstream = area(s, "Upstream Production", "Upstream Production", "UPS", [
        wc(s, "Wellfield", "WF", "Wellfield", f"{s['field']} producing wells",
           {"Field Name": s["field"], "Formation": s["formation"], "Number of Wells": len(wells)}, wells),
        wc(s, "Gathering and Transfer", "GT", "Process Unit", "Field gathering, separation and crude export",
           {"Design Capacity": round_up(field_rate * 1.3, 500)}, [
               eq(s, "Production Separator", "SEP-001", "Separator", "Three-phase production separator",
                  {"Design Pressure": 285}),
               eq(s, "Crude Transfer Pump", "P-001", "Pump", "Crude transfer pump",
                  {"Rated Flow": round_up(field_rate * 1.4, 500), "Rated Head": 1200, "Motor Rating": 250}),
               eq(s, "Crude Pipeline", "PL-001", "Pipeline", "Crude pipeline to refinery",
                  {"Length": round(rng.uniform(8, 35), 1), "Diameter": 8 if cap < 10000 else 12, "MAOP": 1440}),
           ]),
    ])
    receiving = area(s, "Crude Receiving and Storage", "Crude Receiving", "CRS", [
        wc(s, "Crude Tank Farm", "CTF", "Storage Zone", "Crude oil tankage",
           {"Number of Tanks": 2, "Total Capacity": crude_tank * 2}, [
               tank("Crude Tank A", "TK-101", "Crude Oil", crude_tank, "Crude storage tank A"),
               tank("Crude Tank B", "TK-102", "Crude Oil", crude_tank, "Crude storage tank B"),
           ]),
    ])
    distill = area(s, "Crude Distillation", "Processing", "CD", [
        wc(s, "Atmospheric Distillation Unit", "CDU100", "Process Unit", "CDU-100 atmospheric crude distillation",
           {"Design Capacity": cap}, [
               eq(s, "Crude Charge Pump", "P-101", "Pump", "Crude charge pump",
                  {"Rated Flow": round_up(cap * 1.15, 500), "Rated Head": 900, "Motor Rating": 200}),
               eq(s, "Desalter", "D-101", "Desalter", "Electrostatic desalter"),
               eq(s, "Atmospheric Heater", "H-101", "Fired Heater", "Atmospheric heater",
                  {"Design Duty": round(cap * 0.002, 1), "Max Tube Metal Temperature": 1100}),
               eq(s, "Atmospheric Column", "C-101", "Atmospheric Column", "Atmospheric fractionator",
                  {"Number of Trays": 40}),
           ]),
        wc(s, "Vacuum Distillation Unit", "VDU200", "Process Unit", "VDU-200 vacuum distillation",
           {"Design Capacity": round_up(cap * 0.65, 500)}, [
               eq(s, "Vacuum Heater", "H-201", "Fired Heater", "Vacuum heater",
                  {"Design Duty": round(cap * 0.0011, 1), "Max Tube Metal Temperature": 1150}),
               eq(s, "Vacuum Column", "C-201", "Vacuum Column", "Vacuum fractionator", {"Number of Trays": 12}),
               eq(s, "Vacuum Ejector System", "EJ-201", "Vacuum Ejector System", "Two-stage steam ejector package",
                  {"Number of Stages": 2}),
           ]),
    ])
    treating = area(s, "Hydrotreating", "Processing", "HT", [
        wc(s, "Diesel Hydrotreater", "HDT300", "Process Unit", "HDT-300 diesel hydrotreater",
           {"Design Capacity": round_up(cap * 0.38, 500)}, [
               eq(s, "Hydrotreating Reactor", "R-301", "Reactor", "Hydrotreating reactor",
                  {"Catalyst Load Date": "2024-03-15"}),
               eq(s, "Recycle Gas Compressor", "K-301", "Compressor", "Recycle gas compressor",
                  {"Rated Flow": round(cap * 0.38 * 1.6)}),
               eq(s, "HP Separator", "V-301", "Separator", "High-pressure separator", {"Design Pressure": 900}),
           ]),
    ])
    product_tanks = [
        tank("Gasoline Tank", "TK-401", "Gasoline", round_up(cap * split["Gasoline"] * 5, 1000), "Gasoline tank"),
        tank("Jet Kerosene Tank", "TK-402", "Jet Kerosene", round_up(cap * split["Jet Kerosene"] * 5, 1000),
             "Jet / kerosene tank"),
        tank("Diesel Tank", "TK-403", "Diesel", round_up(cap * split["Diesel"] * 5, 1000), "Diesel tank"),
        tank("Fuel Oil Tank", "TK-404", "Fuel Oil", round_up(cap * split["Fuel Oil"] * 5, 1000), "Fuel oil tank"),
    ]
    storage = area(s, "Product Storage and Dispatch", "Product Storage", "PSD", [
        wc(s, "Product Tank Farm", "PTF", "Storage Zone", "Finished product tankage",
           {"Number of Tanks": 4, "Total Capacity": sum(t["values"]["Nominal Capacity"] for t in product_tanks)},
           product_tanks),
    ])
    utilities = area(s, "Utilities", "Utilities", "UTL", [
        wc(s, "Steam System", "STM", "Utility System", "Steam generation and distribution", {"Service": "Steam"}, [
            eq(s, "Boiler", "B-501", "Boiler", "Package boiler", {"Rated Steam Capacity": round_up(cap * 6, 5000)}),
        ]),
        wc(s, "Cooling Water System", "CW", "Utility System", "Cooling water circuit", {"Service": "Cooling water"}, [
            eq(s, "Cooling Tower", "CT-501", "Cooling Tower", "Cooling tower",
               {"Design Circulation": round_up(cap * 0.9, 500)}),
        ]),
    ])
    v = {"Site Code": s["code"], "Country": s["country"], "State / Province": s["state"], "City": s["city"],
         "Time Zone": s["tz"], "Basin": s["basin"], "Location|Latitude": s["lat"], "Location|Longitude": s["lon"],
         "Location|Elevation": s["elev"], "Refinery Nameplate Capacity": cap}
    sim = {k: s[k] for k in ("utc", "t_amb", "t_amp", "wb_dep")}
    return el(s["city"], "Site", f"{s['city']} production and refining site", s["code"], f"CP.{s['code']}", v,
              [upstream, receiving, distill, treating, storage, utilities], isa="Site", sim=sim)


# --------------------------------------------------------------------------
# Analyses, event frame template, notification rule
# --------------------------------------------------------------------------
EVENT_FRAME_TEMPLATE = {
    "name": "Extraction Run",
    "desc": "One event frame per continuous production period of a well. Primary element = the well.",
    "naming": "%ELEMENT% Extraction %STARTTIME:yyyy-MM-dd HH:mm%",
    "attrs": [
        {"name": "Total Oil Produced", "uom": "bbl", "source": "Oil Rate", "method": "Total"},
        {"name": "Total Water Produced", "uom": "bbl", "source": "Water Rate", "method": "Total"},
        {"name": "Total Gas Produced", "uom": "Mscf", "source": "Gas Rate", "method": "Total"},
        {"name": "Average Oil Rate", "uom": "bbl/d", "source": "Oil Rate", "method": "Average"},
        {"name": "Average Tubing Head Pressure", "uom": "psig", "source": "Tubing Head Pressure", "method": "Average"},
        {"name": "Minimum Bottomhole Pressure", "uom": "psia", "source": "Bottomhole Pressure", "method": "Minimum"},
        {"name": "Stop Reason", "uom": None, "source": "Sim Scenario", "method": "EndTime", "enum": "Sim Scenario"},
    ],
}

ANALYSES = [
    {"name": "Extraction Run Detection", "type": "Event Frame Generation", "template": "Well",
     "ef_template": "Extraction Run", "trigger_name": "Producing",
     "start_trigger": "'Well Status' = \"Producing\" And 'Oil Rate' > 5",
     "end": "When the start trigger becomes false", "scheduling": "Event-triggered",
     "note": "Defined once on the Well base template, so every lift-type template and all 55 wells get it."},
    {"name": "Rollup Total Oil Rate", "type": "Rollup", "template": "Wellfield", "input": "Oil Rate",
     "function": "Sum", "output": "Total Oil Rate"},
    {"name": "Rollup Total Water Rate", "type": "Rollup", "template": "Wellfield", "input": "Water Rate",
     "function": "Sum", "output": "Total Water Rate"},
    {"name": "Rollup Total Gas Rate", "type": "Rollup", "template": "Wellfield", "input": "Gas Rate",
     "function": "Sum", "output": "Total Gas Rate"},
    {"name": "Rollup Total Inventory", "type": "Rollup", "template": "Storage Zone", "input": "Inventory",
     "function": "Sum", "output": "Total Inventory"},
    {"name": "Rollup Total Oil Production", "type": "Rollup", "template": "Enterprise", "input": "Field Oil Rate",
     "function": "Sum", "output": "Total Oil Production"},
    {"name": "Rollup Total Refinery Throughput", "type": "Rollup", "template": "Enterprise",
     "input": "Refinery Throughput", "function": "Sum", "output": "Total Refinery Throughput"},
]

NOTIFICATION = {
    "name": "Extraction Run Notification",
    "template": "Well",
    "criteria": 'AnalysisName:"Extraction Run Detection"',
    "triggers": ["Start", "End"],
    "content": ["Well", "Site", "Lift Method", "Start / end time", "Duration", "Total Oil Produced", "Stop Reason"],
    "subscribers": "Added after import. 'Notify on' start/end is chosen per subscriber.",
}

SCENARIOS = {
    "wells": [
        ("Normal", "Steady production with Arps decline, small sensor noise, daily temperature cycle."),
        ("Water Breakthrough", "Water cut ramps up over 2–4 weeks; oil rate falls, BHP rises."),
        ("Gas Interference", "ESP/rod pump: erratic motor current, fillage drops, can end in a trip."),
        ("Sand Production", "Vibration and torque spikes, noisy flowline pressure; PCP can trip on high torque."),
        ("ESP Pump Wear", "Slow loss of head: intake pressure rises, current and motor temperature climb, rate falls."),
        ("Rod Pump Fluid Pound", "Pump-off: fillage < 65%, peak load swings, runtime drops."),
        ("Planned Shut-In", "Operator closes the well; status Shut-In. Ends the Extraction Run event frame."),
        ("Power Outage", "Site-wide: all artificially lifted wells trip together, restart staggered."),
        ("Workover", "Well offline 2–6 days, then returns with restored rate."),
    ],
    "refinery": [
        ("Normal", "Feed follows crude tank inventory; products split by column draws; full mass balance."),
        ("Heater Fouling", "Tube metal temperature and fuel gas creep up over weeks for the same outlet temperature."),
        ("Vacuum Loss", "Motive steam pressure drops: VDU top pressure rises, HVGO yield falls."),
        ("Cooling Tower Degraded", "Fan trip on a hot day: CW supply up, condenser outlet up, vacuum pressure up."),
        ("Compressor Trip", "K-301 trips: H2 flow lost, HDT goes to Upset, feed is cut."),
    ],
    "coupling": [
        "Wells → Wellfield totals → Production Separator → Crude Transfer Pump → Crude Pipeline → crude tanks",
        "Crude tank inventory → CDU feed rate → column draws → product tank levels",
        "Ambient wet bulb → Cooling Tower supply → ejector condenser outlet → Vacuum Column top pressure",
        "Boiler steam pressure → ejector motive steam → Vacuum Column top pressure",
    ],
}


def walk(node, path, depth, out):
    p = f"{path}\\{node['name']}" if path else node["name"]
    node["path"] = p
    node["depth"] = depth
    out.append(node)
    for c in node["children"]:
        walk(c, p, depth + 1, out)


def points_for(node):
    """PI points owned by an element: [(tag, attr)]"""
    out = []
    for a in all_attrs(node["template"]):
        if a["kind"] == "pi" and a["src"] != "ref":
            out.append((f"{node['tag_prefix']}.{a['tag']}", a))
    return out


def build():
    rng = random.Random(SEED)
    sites = [make_site(rng, s) for s in SITES]
    root = el("Cordillera Petróleo", "Enterprise", COMPANY["note"], "CP", "CP.CORP",
              {"Company Name": COMPANY["name"], "Headquarters City": COMPANY["hq_city"],
               "Headquarters Country": COMPANY["hq_country"], "Number of Sites": len(sites)},
              sites, isa="Enterprise")

    flat = []
    walk(root, "", 1, flat)
    depth = max(n["depth"] for n in flat)
    assert depth <= MAX_DEPTH, f"hierarchy is {depth} levels deep"
    tags = [t for n in flat for t, _ in points_for(n)]
    assert len(tags) == len(set(tags)), "duplicate PI tag names"
    for n in flat:  # sibling names must be unique in AF
        names = [c["name"] for c in n["children"]]
        assert len(names) == len(set(names)), f"duplicate child names under {n['path']}"

    stats = {
        "sites": len(sites),
        "wells": sum(len(s["lift"]) for s in SITES),
        "elements": len(flat),
        "depth": depth,
        "element_templates": len(T),
        "pi_points": len(tags),
        "analysis_templates": len(ANALYSES),
        "analyses": sum(1 for n in flat for a in ANALYSES if a["template"] in chain(n["template"])),
        "notification_rules": 1,
        "event_frame_templates": 1,
        "enumeration_sets": len(ENUMS),
    }
    return {
        "database": "Cordillera Petroleo",
        "company": COMPANY,
        "point_source": POINT_SOURCE,
        "stats": stats,
        "af_uom": AF_UOM,
        "enums": ENUMS,
        "templates": T,
        "root": root,
        "event_frame_template": EVENT_FRAME_TEMPLATE,
        "analyses": ANALYSES,
        "notification": NOTIFICATION,
        "scenarios": SCENARIOS,
    }


if __name__ == "__main__":
    model = build()
    out = Path(__file__).with_name("model.json")
    out.write_text(json.dumps(model, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(model["stats"], indent=1))
