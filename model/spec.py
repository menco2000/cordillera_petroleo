#!/usr/bin/env python3
"""Single source of truth for the Cordillera Petróleo AF model.

Everything else (AF XML generator, simulator, docs diagram) reads the JSON
this script writes, so the hierarchy, templates and tag names never drift.

    python model/spec.py            -> writes model/model.json
"""
import json
import math
import random
from pathlib import Path

SEED = 20261021
COMPANY = {
    "name": "Cordillera Petróleo S.A.",
    "code": "CP",
    "hq_city": "Bogotá",
    "hq_country": "Colombia",
    "note": "Fictional company for simulation and training purposes.",
}

# --------------------------------------------------------------------------
# Attribute helpers
#   static  : configuration item, value stored in AF
#   pi      : PI Point data reference, tag = <Tag Prefix>.<suffix>
#   formula : AF Formula data reference over sibling attributes
# --------------------------------------------------------------------------

def S(name, type="String", uom=None, enum=None, desc="", children=None, cat="Metadata"):
    return {"name": name, "kind": "static", "type": type, "uom": uom, "enum": enum,
            "desc": desc, "cat": cat, "children": children or []}


def P(name, tag, uom=None, type="Float32", enum=None, desc="", cat="Process"):
    return {"name": name, "kind": "pi", "tag": tag, "type": type, "uom": uom, "enum": enum,
            "desc": desc, "cat": cat}


def F(name, expr, uom=None, desc="", cat="Calculated"):
    return {"name": name, "kind": "formula", "expr": expr, "type": "Double", "uom": uom,
            "desc": desc, "cat": cat}


def D(name, enum, tag, desc=""):
    """Digital PI point backed by an AF enumeration set."""
    return P(name, tag, type="Enum", enum=enum, desc=desc, cat="Status")


# --------------------------------------------------------------------------
# Enumeration sets (also created as PI digital state sets)
# --------------------------------------------------------------------------
ENUMS = {
    "ISA95 Level": ["Enterprise", "Site", "Area", "Work Center", "Work Unit", "Equipment Module"],
    "Area Type": ["Upstream Production", "Crude Receiving", "Processing", "Product Storage", "Utilities"],
    "Lift Method": ["Natural Flow", "ESP", "Rod Pump", "Gas Lift", "PCP"],
    "Well Status": ["Shut-In", "Producing", "Starting Up", "Tripped", "Workover"],
    "Equipment Status": ["Stopped", "Running", "Tripped", "Maintenance"],
    "Unit Status": ["Shutdown", "Startup", "Normal Operation", "Reduced Rate", "Upset"],
    "Product": ["Crude Oil", "Gasoline", "Jet / Kerosene", "Diesel", "Fuel Oil"],
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
             S("Asset ID", desc="Unique asset code"),
             S("Description"),
             S("ISA-95 Level", "Enum", enum="ISA95 Level"),
             S("Tag Prefix", desc="PI tag root, e.g. CP.BAR.W01. Used by every PI Point data reference.", cat="Configuration"),
         ], "Base")

template("Enterprise", "Asset Base", "Enterprise", "Company level.", [
    S("Company Name"),
    S("Headquarters City"),
    S("Headquarters Country"),
    S("Number of Sites", "Int32"),
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
], "Hierarchy")

template("Area", "Asset Base", "Area", "ISA-95 area inside a site.", [
    S("Area Type", "Enum", enum="Area Type"),
], "Hierarchy")

template("Wellfield", "Asset Base", "Work Center", "ISA-95 work center grouping all producing wells of the site.", [
    S("Field Name"),
    S("Formation"),
    S("Number of Wells", "Int32"),
    P("Total Oil Rate", "QO", "bbl/d"),
    P("Total Water Rate", "QW", "bbl/d"),
    P("Total Gas Rate", "QG", "Mscf/d"),
    P("Producing Wells", "NPROD", type="Int32"),
    F("Field Water Cut", "Total Water Rate / (Total Oil Rate + Total Water Rate) × 100", "%"),
], "Hierarchy")

template("Process Unit", "Asset Base", "Work Center", "ISA-95 production unit (ISA-88 process cell) for continuous processing.", [
    S("Design Capacity", "Double", "bbl/d"),
    D("Unit Status", "Unit Status", "STATUS"),
    P("Throughput", "THRU", "bbl/d"),
    F("Utilization", "Throughput / Design Capacity × 100", "%"),
], "Hierarchy")

template("Utility System", "Asset Base", "Work Center", "ISA-95 work center for steam and cooling water services.", [
    S("Service"),
    D("System Status", "Unit Status", "STATUS"),
], "Hierarchy")

template("Storage Zone", "Asset Base", "Work Center", "ISA-95 storage zone (tank farm).", [
    S("Number of Tanks", "Int32"),
    S("Total Capacity", "Double", "bbl"),
    P("Total Inventory", "INV", "bbl"),
    F("Fill Level", "Total Inventory / Total Capacity × 100", "%"),
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
             S("Reservoir", children=[S("Static Reservoir Pressure", "Double", "psia"),
                                      S("Reservoir Temperature", "Double", "°F"),
                                      S("Oil API Gravity", "Double", "°API"),
                                      S("Productivity Index", "Double", "bbl/d/psi")], cat="Reservoir"),
             S("Design Oil Rate", "Double", "bbl/d"),
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
             P("Gas Rate", "QG", "Mscf/d"),
             P("Oil Volume Today", "DAYOIL", "bbl", desc="Resets at 00:00 site time"),
             P("Cumulative Oil", "CUMOIL", "bbl"),
             F("Liquid Rate", "Oil Rate + Water Rate", "bbl/d"),
             F("Water Cut", "Water Rate / (Oil Rate + Water Rate) × 100", "%"),
             F("Gas-Oil Ratio", "Gas Rate × 1000 / Oil Rate", "scf/bbl"),
             F("Drawdown", "Static Reservoir Pressure − Bottomhole Pressure", "psi"),
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
    P("Vibration", "VIB", "g", cat="Lift"),
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
    F("Differential Pressure", "Discharge Pressure − Suction Pressure", "psi"),
])

template("Pipeline", "Equipment Base", "Work Unit", "Crude transfer line from the field to the refinery.", [
    S("Length", "Double", "km"),
    S("Diameter", "Double", "in"),
    S("MAOP", "Double", "psig", desc="Maximum allowable operating pressure"),
    P("Inlet Pressure", "PIN", "psig"),
    P("Outlet Pressure", "POUT", "psig"),
    P("Inlet Flow", "QIN", "bbl/d"),
    P("Outlet Flow", "QOUT", "bbl/d"),
    F("Pressure Drop", "Inlet Pressure − Outlet Pressure", "psi"),
    F("Flow Imbalance", "(Inlet Flow − Outlet Flow) / Inlet Flow × 100", "%", desc="Leak indicator"),
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
    F("Level Percent", "Level / Max Fill Height × 100", "%"),
    F("Available Capacity", "Nominal Capacity − Inventory", "bbl"),
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
    F("Temperature Rise", "Coil Outlet Temperature − Inlet Temperature", "°F"),
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
    F("Temperature Rise", "Outlet Temperature − Inlet Temperature", "°F"),
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
    F("Compression Ratio", "(Discharge Pressure + 14.7) / (Suction Pressure + 14.7)", ""),
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
    F("Range", "Return Temperature − Supply Temperature", "°F"),
    F("Approach", "Supply Temperature − Wet Bulb Temperature", "°F"),
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
# Sites
# --------------------------------------------------------------------------
SITES = [
    dict(code="BAR", city="Barrancabermeja", state="Santander", country="Colombia", lat=7.0653, lon=-73.8547,
         elev=75, tz="SA Pacific Standard Time", basin="Middle Magdalena Valley", field="Campo Las Garzas",
         formation="Mugrosa / Colorado", lift=["Rod Pump"] * 4 + ["ESP"] * 2 + ["PCP"] * 2,
         api=(19, 25), depth=(5500, 9000), bearings=None),
    dict(code="MCB", city="Maracaibo", state="Zulia", country="Venezuela", lat=10.6545, lon=-71.6406,
         elev=6, tz="Venezuela Standard Time", basin="Maracaibo Basin", field="Campo Lago Azul",
         formation="Lagunillas / Misoa", lift=["Gas Lift"] * 6 + ["Rod Pump"] * 3 + ["ESP"],
         api=(17, 32), depth=(4000, 12000), bearings=None),
    dict(code="NQN", city="Neuquén", state="Neuquén", country="Argentina", lat=-38.9516, lon=-68.0591,
         elev=270, tz="Argentina Standard Time", basin="Neuquén Basin", field="Bloque Cerro Viento",
         formation="Vaca Muerta", lift=["Natural Flow"] * 3 + ["Gas Lift"] * 2 + ["ESP"] * 2 + ["Rod Pump"] * 2,
         api=(38, 46), depth=(9000, 13500), bearings=None),
    dict(code="CRD", city="Comodoro Rivadavia", state="Chubut", country="Argentina", lat=-45.8641, lon=-67.4966,
         elev=60, tz="Argentina Standard Time", basin="Golfo San Jorge Basin", field="Yacimiento Pampa Fría",
         formation="Comodoro Rivadavia / Mina del Carmen", lift=["Rod Pump"] * 4 + ["PCP"] * 2,
         api=(20, 27), depth=(3500, 8000), bearings=(200, 340)),
    dict(code="MOS", city="Mossoró", state="Rio Grande do Norte", country="Brazil", lat=-5.1878, lon=-37.3441,
         elev=18, tz="SA Eastern Standard Time", basin="Potiguar Basin", field="Campo Serra Dourada",
         formation="Açu", lift=["Rod Pump"] * 3 + ["PCP"] * 2,
         api=(24, 34), depth=(2000, 4500), bearings=(120, 250)),
    dict(code="TAL", city="Talara", state="Piura", country="Peru", lat=-4.5772, lon=-81.2719,
         elev=10, tz="SA Pacific Standard Time", basin="Talara Basin", field="Lote Cabo Seco",
         formation="Mogollón / Pariñas", lift=["Rod Pump"] * 3 + ["Gas Lift"] * 3 + ["Natural Flow"],
         api=(32, 38), depth=(3000, 8000), bearings=(20, 160)),
    dict(code="LAG", city="Nueva Loja", state="Sucumbíos", country="Ecuador", lat=0.0847, lon=-76.8828,
         elev=300, tz="SA Pacific Standard Time", basin="Oriente Basin", field="Bloque Río Verde",
         formation="Napo U / Hollín", lift=["ESP"] * 5 + ["Natural Flow"],
         api=(24, 30), depth=(8500, 10500), bearings=None),
    dict(code="SCZ", city="Santa Cruz de la Sierra", state="Santa Cruz", country="Bolivia", lat=-17.7833,
         lon=-63.1821, elev=416, tz="SA Western Standard Time", basin="Subandean Basin",
         field="Campo Monte Chaco", formation="Petaca / Yecua", lift=["Natural Flow"] * 2 + ["Gas Lift"] * 2,
         api=(42, 55), depth=(7000, 11000), bearings=None),
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
    import datetime as dt
    return (dt.date.fromisoformat(d) + dt.timedelta(days=n)).isoformat()


def el(name, template, desc, tag, values=None, children=None, isa=None):
    return {"name": name, "template": template, "desc": desc, "tag_prefix": tag,
            "values": values or {}, "children": children or [], "isa": isa}


def make_well(rng, site, i, lift):
    name = f"{site['code']}-W{i:02d}"
    lo, hi = site["bearings"] or (0, 360)
    lat, lon = offset(site["lat"], site["lon"], rng.uniform(6, 30), rng.uniform(lo, hi))
    td = round(rng.uniform(*site["depth"]), -1)
    perf_top = round(td - rng.uniform(250, 900), -1)
    perf_bot = round(min(perf_top + rng.uniform(40, 250), td - 30), -1)
    pr = round(0.433 * perf_top * rng.uniform(0.55, 0.95), -1)
    rate = round(rng.uniform(*DESIGN_RATE[lift]), -1)
    spud = date(rng, 2008, 2023)
    v = {
        "Asset ID": name, "Description": f"{lift} producer, {site['field']}", "ISA-95 Level": "Work Unit",
        "UWI": f"{site['country'][:2].upper()}-{site['code']}-{spud[:4]}-{i:03d}",
        "Lift Method": lift, "Field Name": site["field"], "Formation": site["formation"],
        "Municipality": site["city"], "Spud Date": spud, "Completion Date": add_days(spud, rng.randint(35, 95)),
        "Total Depth": td, "Perforation Top": perf_top, "Perforation Bottom": perf_bot,
        "Location|Latitude": lat, "Location|Longitude": lon,
        "Location|Ground Elevation": round(site["elev"] + rng.uniform(-15, 60)),
        "Reservoir|Static Reservoir Pressure": pr,
        "Reservoir|Reservoir Temperature": round(80 + 0.0155 * perf_top),
        "Reservoir|Oil API Gravity": round(rng.uniform(*site["api"]), 1),
        "Reservoir|Productivity Index": round(rate / (pr * rng.uniform(0.3, 0.6)), 2),
        "Design Oil Rate": rate,
    }
    pump_depth = round(perf_top - rng.uniform(150, 400), -1)
    if lift == "Natural Flow":
        v["Choke Size"] = rng.choice([24, 28, 32, 40, 48])
    elif lift == "ESP":
        v.update({"Pump Model": "ESP 538-series (generic)", "Pump Stages": rng.randint(120, 320),
                  "Motor Rating": rng.choice([150, 200, 250, 300, 400]), "Pump Setting Depth": pump_depth})
    elif lift == "Rod Pump":
        v.update({"Pumping Unit Size": rng.choice(["C-228D-213-86", "C-320D-256-120", "C-456D-305-144", "C-640D-365-168"]),
                  "Stroke Length": rng.choice([86, 120, 144, 168]),
                  "Plunger Diameter": rng.choice([1.5, 1.75, 2.0, 2.25]), "Pump Setting Depth": pump_depth})
    elif lift == "Gas Lift":
        v.update({"Operating Valve Depth": pump_depth, "Number of Gas Lift Valves": rng.randint(4, 8)})
    elif lift == "PCP":
        v.update({"Pump Model": "PCP 40-1200 (generic)", "Rotor Depth": pump_depth,
                  "Max Rotor Speed": rng.choice([300, 350, 400, 450])})
    return el(name, LIFT_TEMPLATE[lift], v["Description"], f"CP.{site['code']}.W{i:02d}", v, isa="Work Unit")


def eq(site, name, template, desc, values=None):
    v = {"Asset ID": f"{site['code']}-{name}", "Description": desc,
         "ISA-95 Level": TEMPLATES[template]["isa"], "Manufacturer": "Generic", "Model": "—"}
    v.update(values or {})
    return el(name, template, desc, f"CP.{site['code']}.{name.replace('-', '')}", v, isa=TEMPLATES[template]["isa"])


def wc(site, name, template, desc, code, values=None, children=None):
    v = {"Asset ID": f"{site['code']}-{code}", "Description": desc, "ISA-95 Level": "Work Center"}
    v.update(values or {})
    return el(name, template, desc, f"CP.{site['code']}.{code}", v, children, isa="Work Center")


def area(site, name, atype, code, children):
    v = {"Asset ID": f"{site['code']}-{code}", "Description": name, "ISA-95 Level": "Area", "Area Type": atype}
    return el(name, "Area", name, f"CP.{site['code']}.{code}", v, children, isa="Area")


def round_up(x, step):
    return int(math.ceil(x / step) * step)


def make_site(rng, s):
    wells = [make_well(rng, s, i + 1, lift) for i, lift in enumerate(s["lift"])]
    field_rate = sum(w["values"]["Design Oil Rate"] for w in wells)
    cap = round_up(field_rate * 1.25, 500)
    crude_tank = round_up(cap * 2.5, 5000)    # ~2.5 days each
    prod = {"Gasoline": 0.25, "Jet / Kerosene": 0.15, "Diesel": 0.35, "Fuel Oil": 0.25}

    def tank(name, product, capacity, desc):
        h = 48.0
        dia = round(math.sqrt(capacity * 5.615 / (math.pi / 4 * h)), 1)
        return eq(s, name, "Tank", desc, {"Product": product, "Nominal Capacity": capacity,
                                          "Max Fill Height": h, "Diameter": dia})

    upstream = area(s, "Upstream Production", "Upstream Production", "UPS", [
        wc(s, "Wellfield", "Wellfield", f"{s['field']} producing wells", "WF",
           {"Field Name": s["field"], "Formation": s["formation"], "Number of Wells": len(wells)}, wells),
        wc(s, "Gathering & Transfer", "Process Unit", "Field gathering, separation and crude export", "GT",
           {"Design Capacity": round_up(field_rate * 1.3, 500)}, [
               eq(s, "SEP-001", "Separator", "Three-phase production separator", {"Design Pressure": 285}),
               eq(s, "P-001", "Pump", "Crude transfer pump", {"Rated Flow": round_up(field_rate * 1.4, 500),
                                                              "Rated Head": 1200, "Motor Rating": 250}),
               eq(s, "PL-001", "Pipeline", "Crude pipeline to refinery",
                  {"Length": round(rng.uniform(8, 35), 1), "Diameter": 8 if cap < 10000 else 12, "MAOP": 1440}),
           ]),
    ])
    receiving = area(s, "Crude Receiving & Storage", "Crude Receiving", "CRS", [
        wc(s, "Crude Tank Farm", "Storage Zone", "Crude oil tankage", "CTF",
           {"Number of Tanks": 2, "Total Capacity": crude_tank * 2}, [
               tank("TK-101", "Crude Oil", crude_tank, "Crude storage tank A"),
               tank("TK-102", "Crude Oil", crude_tank, "Crude storage tank B"),
           ]),
    ])
    distill = area(s, "Crude Distillation", "Processing", "CD", [
        wc(s, "CDU-100", "Process Unit", "Atmospheric crude distillation unit", "CDU100", {"Design Capacity": cap}, [
            eq(s, "P-101", "Pump", "Crude charge pump", {"Rated Flow": round_up(cap * 1.15, 500), "Rated Head": 900,
                                                          "Motor Rating": 200}),
            eq(s, "D-101", "Desalter", "Electrostatic desalter"),
            eq(s, "H-101", "Fired Heater", "Atmospheric heater",
               {"Design Duty": round(cap * 0.0065, 1), "Max Tube Metal Temperature": 1100}),
            eq(s, "C-101", "Atmospheric Column", "Atmospheric fractionator", {"Number of Trays": 40}),
        ]),
        wc(s, "VDU-200", "Process Unit", "Vacuum distillation unit", "VDU200", {"Design Capacity": round_up(cap * 0.4, 500)}, [
            eq(s, "H-201", "Fired Heater", "Vacuum heater",
               {"Design Duty": round(cap * 0.0035, 1), "Max Tube Metal Temperature": 1150}),
            eq(s, "C-201", "Vacuum Column", "Vacuum fractionator", {"Number of Trays": 12}),
            eq(s, "EJ-201", "Vacuum Ejector System", "Two-stage steam ejector package", {"Number of Stages": 2}),
        ]),
    ])
    treating = area(s, "Hydrotreating", "Processing", "HT", [
        wc(s, "HDT-300", "Process Unit", "Diesel hydrotreater", "HDT300", {"Design Capacity": round_up(cap * 0.38, 500)}, [
            eq(s, "R-301", "Reactor", "Hydrotreating reactor", {"Catalyst Load Date": "2024-03-15"}),
            eq(s, "K-301", "Compressor", "Recycle gas compressor", {"Rated Flow": round(cap * 0.38 * 1.2)}),
            eq(s, "V-301", "Separator", "High-pressure separator", {"Design Pressure": 900}),
        ]),
    ])
    product_tanks = [
        tank("TK-401", "Gasoline", round_up(cap * prod["Gasoline"] * 5, 1000), "Gasoline tank"),
        tank("TK-402", "Jet / Kerosene", round_up(cap * prod["Jet / Kerosene"] * 5, 1000), "Jet / kerosene tank"),
        tank("TK-403", "Diesel", round_up(cap * prod["Diesel"] * 5, 1000), "Diesel tank"),
        tank("TK-404", "Fuel Oil", round_up(cap * prod["Fuel Oil"] * 5, 1000), "Fuel oil tank"),
    ]
    storage = area(s, "Product Storage & Dispatch", "Product Storage", "PSD", [
        wc(s, "Product Tank Farm", "Storage Zone", "Finished product tankage", "PTF",
           {"Number of Tanks": 4, "Total Capacity": sum(t["values"]["Nominal Capacity"] for t in product_tanks)},
           product_tanks),
    ])
    utilities = area(s, "Utilities", "Utilities", "UTL", [
        wc(s, "Steam System", "Utility System", "Steam generation and distribution", "STM", {"Service": "Steam"}, [
            eq(s, "B-501", "Boiler", "Package boiler", {"Rated Steam Capacity": round_up(cap * 6, 5000)}),
        ]),
        wc(s, "Cooling Water System", "Utility System", "Cooling water circuit", "CW", {"Service": "Cooling water"}, [
            eq(s, "CT-501", "Cooling Tower", "Cooling tower", {"Design Circulation": round_up(cap * 0.9, 500)}),
        ]),
    ])
    v = {"Asset ID": s["code"], "Description": f"{s['city']} production & refining site", "ISA-95 Level": "Site",
         "Site Code": s["code"], "Country": s["country"], "State / Province": s["state"], "City": s["city"],
         "Time Zone": s["tz"], "Basin": s["basin"], "Location|Latitude": s["lat"], "Location|Longitude": s["lon"],
         "Location|Elevation": s["elev"], "Refinery Nameplate Capacity": cap}
    return el(f"{s['code']} - {s['city']}", "Site", v["Description"], f"CP.{s['code']}", v,
              [upstream, receiving, distill, treating, storage, utilities], isa="Site")


# --------------------------------------------------------------------------
# Analysis, event frame template, notification rule
# --------------------------------------------------------------------------
EVENT_FRAME_TEMPLATE = {
    "name": "Extraction Run",
    "desc": "One event frame per continuous production period of a well. Primary element = the well.",
    "naming": "%ELEMENT% Extraction %STARTTIME:yyyy-MM-dd HH:mm%",
    "attrs": [
        {"name": "Total Oil Produced", "uom": "bbl", "source": "Oil Rate", "method": "Total (time-weighted)"},
        {"name": "Total Water Produced", "uom": "bbl", "source": "Water Rate", "method": "Total (time-weighted)"},
        {"name": "Total Gas Produced", "uom": "Mscf", "source": "Gas Rate", "method": "Total (time-weighted)"},
        {"name": "Average Oil Rate", "uom": "bbl/d", "source": "Oil Rate", "method": "Average"},
        {"name": "Average Tubing Head Pressure", "uom": "psig", "source": "Tubing Head Pressure", "method": "Average"},
        {"name": "Minimum Bottomhole Pressure", "uom": "psia", "source": "Bottomhole Pressure", "method": "Minimum"},
        {"name": "Stop Reason", "uom": None, "source": "Sim Scenario", "method": "Value at end time"},
    ],
}

ANALYSIS = {
    "name": "Extraction Run Detection",
    "type": "Event Frame Generation",
    "template": "Well",
    "ef_template": "Extraction Run",
    "start_trigger": "'Well Status' = \"Producing\" AND 'Oil Rate' > 5",
    "true_for": "60 s",
    "end": "When the start trigger becomes false",
    "scheduling": "Event-triggered on Well Status and Oil Rate",
    "note": "Defined once on the Well base template, so every derived well template and all 55 wells get it.",
}

NOTIFICATION = {
    "name": "Extraction Run Started / Stopped",
    "template": "Well",
    "criteria": "Event frames from template 'Extraction Run' on this well",
    "triggers": ["Start", "End"],
    "content": ["Well", "Site", "Lift Method", "Start / end time", "Duration", "Total Oil Produced", "Stop Reason"],
    "subscribers": "Configured after import (needs a delivery endpoint on your Notifications Service)",
}

SCENARIOS = {
    "wells": [
        ("Normal", "Steady production with Arps hyperbolic decline, small sensor noise, daily temperature cycle."),
        ("Water Breakthrough", "Water cut ramps from ~10% to 60–80% over days; oil rate falls, BHP rises."),
        ("Gas Interference", "ESP/rod pump: erratic motor current, fillage drops, can end in a trip."),
        ("Sand Production", "Vibration and choke erosion, rising flowline pressure noise."),
        ("ESP Pump Wear", "Slow loss of head: intake pressure rises, current and motor temperature climb, rate falls."),
        ("Rod Pump Fluid Pound", "Pump-off: fillage < 60%, peak load swings, runtime controller cycles the well."),
        ("Planned Shut-In", "Operator closes the well; status Shut-In. Ends the Extraction Run event frame."),
        ("Power Outage", "Site-wide event: all lifted wells trip at the same time, restart staggered."),
        ("Workover", "Well offline 2–6 days, then returns with restored rate."),
    ],
    "refinery": [
        ("Normal", "Feed follows crude tank inventory; products split by column draws; full mass balance."),
        ("Heater Fouling", "Tube metal temperature and fuel gas creep up over weeks for the same outlet temperature."),
        ("Vacuum Loss", "Motive steam pressure drops or ejector fouls: VDU top pressure rises, HVGO yield falls."),
        ("Cooling Tower Degraded", "Hot, humid afternoon: wet bulb up, CW supply up, condenser outlet up, vacuum pressure up."),
        ("Compressor Trip", "K-301 trips: H2 flow lost, HDT goes to Upset, feed is cut."),
    ],
    "coupling": [
        "Wells → Wellfield totals → SEP-001 → P-001 → PL-001 → TK-101/102 inventory",
        "Crude tank level → CDU-100 feed rate → column draws → product tank levels",
        "Wet bulb → CT-501 supply temperature → EJ-201 condenser outlet → C-201 top pressure",
        "B-501 steam pressure → EJ-201 motive steam → C-201 top pressure",
    ],
}


def walk(node, path, out):
    p = f"{path}\\{node['name']}"
    out.append((p, node))
    for c in node["children"]:
        walk(c, p, out)


def build():
    rng = random.Random(SEED)
    sites = [make_site(rng, s) for s in SITES]
    root = el("Cordillera Petróleo", "Enterprise", COMPANY["note"], "CP",
              {"Asset ID": "CP", "Description": COMPANY["note"], "ISA-95 Level": "Enterprise",
               "Company Name": COMPANY["name"], "Headquarters City": COMPANY["hq_city"],
               "Headquarters Country": COMPANY["hq_country"], "Number of Sites": len(sites)},
              sites, isa="Enterprise")

    flat = []
    walk(root, "", flat)
    pi_points = 0
    for _, node in flat:
        pi_points += sum(1 for a in all_attrs(node["template"]) if a["kind"] == "pi")
    stats = {
        "sites": len(sites),
        "wells": sum(len(s["lift"]) for s in SITES),
        "elements": len(flat),
        "element_templates": len(T),
        "pi_points": pi_points,
        "analyses": 1,
        "notification_rules": 1,
        "event_frame_templates": 1,
        "enumeration_sets": len(ENUMS),
    }
    return {
        "database": "Cordillera Petroleo",
        "company": COMPANY,
        "stats": stats,
        "enums": ENUMS,
        "templates": T,
        "root": root,
        "event_frame_template": EVENT_FRAME_TEMPLATE,
        "analysis": ANALYSIS,
        "notification": NOTIFICATION,
        "scenarios": SCENARIOS,
    }


if __name__ == "__main__":
    model = build()
    out = Path(__file__).with_name("model.json")
    out.write_text(json.dumps(model, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(model["stats"], indent=1))
