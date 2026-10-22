"""Site model: wells -> gathering -> pipeline -> refinery -> product tanks, plus utilities.

Mass flows are in bbl/d, gas in Mscf/d, steam in lb/h, temperatures in °F.
"""
import math

from .core import DAY, HOUR, OU, Climate, Timeline, clamp, interp, lag, rng_for
from .wells import Well


def flatten(node, out):
    out[node["id"]] = node
    for c in node["children"]:
        flatten(c, out)
    return out


class Tank:
    def __init__(self, node, fill):
        v = node["values"]
        self.prefix = node["tag_prefix"]
        self.cap = v["Nominal Capacity"]
        self.h = v["Max Fill Height"]
        self.inv = self.cap * fill
        self.qin = self.qout = 0.0
        self.temp = None

    @property
    def frac(self):
        return self.inv / self.cap

    def step(self, dt, qin, qout, temp_target):
        qout = min(qout, max(0.0, self.inv) * DAY / dt + qin)
        self.inv = clamp(self.inv + (qin - qout) * dt / DAY, 0.0, self.cap)
        self.qin, self.qout = qin, qout
        self.temp = temp_target if self.temp is None else lag(self.temp, temp_target, dt, 12 * HOUR)


class Site:
    def __init__(self, node, enums, seed, t0):
        self.node = node
        self.code = node["id"]
        self.e = enums
        self.idx = {k: {n: i for i, n in enumerate(v)} for k, v in enums.items()}
        sim = node["sim"]
        self.utc = sim["utc"]
        self.rng = rng = rng_for(seed, self.code)
        self.t0 = t0
        self.climate = Climate(rng, sim["utc"], sim["t_amb"], sim["t_amp"], sim["wb_dep"])
        self.n = flatten(node, {})
        self.p = {k: v["tag_prefix"] for k, v in self.n.items()}
        c = self.code

        wellfield = self.n[f"{c}-WF"]
        self.wells = [Well(w, enums, seed, t0, self.utc) for w in wellfield["children"]]
        self.cap = node["values"]["Refinery Nameplate Capacity"]
        designs = [w.design for w in self.wells]
        apis = [x["values"]["Oil API Gravity"] for x in wellfield["children"]]
        self.api = a = sum(a * d for a, d in zip(apis, designs)) / sum(designs)
        self.y_nap = interp(a, 20, 0.08, 45, 0.30)
        self.y_ker = interp(a, 20, 0.08, 45, 0.16)
        self.y_dsl = interp(a, 20, 0.20, 45, 0.30)
        self.y_res = 1 - self.y_nap - self.y_ker - self.y_dsl

        self.outages = Timeline(rng, t0, [("Power Outage", 35, (1, 4))], first_gap_days=(5, 40))
        self.fouling_tl = Timeline(rng, t0, [("Heater Fouling", 55, (480, 960))], first_gap_days=(3, 30))
        self.vacuum_tl = Timeline(rng, t0, [("Vacuum Loss", 25, (2, 12))], first_gap_days=(2, 25))
        self.ct_tl = Timeline(rng, t0, [("Cooling Tower Degraded", 28, (6, 36))], first_gap_days=(2, 25))
        self.k_tl = Timeline(rng, t0, [("Compressor Trip", 45, (2, 8))], first_gap_days=(5, 45))

        v = lambda i, k: self.n[f"{c}-{i}"]["values"][k]  # noqa: E731
        self.pl_len = v("PL-001", "Length")
        self.p001_rated = v("P-001", "Rated Flow")
        self.p101_rated = v("P-101", "Rated Flow")
        self.h101_duty = v("H-101", "Design Duty")
        self.h201_duty = v("H-201", "Design Duty")
        self.vdu_cap = self.n[f"{c}-VDU200"]["values"]["Design Capacity"]
        self.hdt_cap = self.n[f"{c}-HDT300"]["values"]["Design Capacity"]
        self.k_rated = v("K-301", "Rated Flow")
        self.boiler_rated = v("B-501", "Rated Steam Capacity")
        self.ct_design = v("CT-501", "Design Circulation")
        self.cat_load = t0 - 600 * DAY  # catalyst age at sim start ~ 20 months

        self.tk_a = Tank(self.n[f"{c}-TK-101"], 0.55)
        self.tk_b = Tank(self.n[f"{c}-TK-102"], 0.40)
        self.receiving, self.feeding = self.tk_a, self.tk_b
        self.products = {k: Tank(self.n[f"{c}-{k}"], rng.uniform(0.35, 0.6))
                         for k in ("TK-401", "TK-402", "TK-403", "TK-404")}
        self.dispatching = {k: False for k in self.products}

        self.sep_p_sp = rng.uniform(110, 140)
        self.sep_p = self.sep_p_sp
        self.surge = 150.0
        self.sep = {"o": 0.0, "w": 0.0, "g": 0.0, "t": None}
        self.pl_out = None
        self.field_ema = None
        self.feed = None
        self.draws = None
        self.hdt_feed = 0.0
        self.k_running = True
        self.fouling = 0.0
        self.vib_k = 0.9
        self.n_vac = OU(rng, 0.6, 2 * HOUR)
        self.n_o2 = OU(rng, 0.25, 3 * HOUR)
        self.n_o2b = OU(rng, 0.25, 3 * HOUR)
        self.n_ptop = OU(rng, 0.3, 1 * HOUR)
        self.n_steam = OU(rng, 1.2, 1 * HOUR)
        self.motive_p = 150.0
        self.tsup = None

    # ---------------------------------------------------------------------
    def step(self, t, dt):
        rng, out = self.rng, {}
        g = rng.gauss

        def put(asset, suffix, value):
            out[f"{self.p[f'{self.code}-{asset}']}.{suffix}"] = value

        temp = self.climate.step(t, dt)
        wb = self.climate.wet_bulb
        hour = self.climate.local_hour(t)

        # ---- wells ------------------------------------------------------
        o = self.outages.active(t)
        outage = (o.start, o.end) if o else None
        qo = qw = qg = 0.0
        wht_flow = 0.0
        nprod = 0
        for w in self.wells:
            vals = w.step(t, dt, temp, self.sep_p, outage)
            for k, val in vals.items():
                out[f"{w.prefix}.{k}"] = val
            qo += w.oil
            qw += w.water
            qg += w.gas_rate
            wht_flow += w.wht_now * (w.oil + w.water)
            nprod += w.status == "Producing"
        out[f"{self.p[f'{self.code}-WF']}.NPROD"] = nprod

        # ---- gathering & transfer ---------------------------------------
        liquid = qo + qw
        t_mix = wht_flow / liquid if liquid > 1 else temp
        s = self.sep
        s["o"] = lag(s["o"], qo, dt, 20 * 60)
        s["w"] = lag(s["w"], qw, dt, 20 * 60)
        s["g"] = lag(s["g"], qg, dt, 10 * 60)
        s["t"] = t_mix if s["t"] is None else lag(s["t"], t_mix - 5, dt, HOUR)
        self.sep_p = self.sep_p_sp + g(0, 1.2) + 0.002 * qg
        put("SEP-001", "PRES", self.sep_p)
        put("SEP-001", "TEMP", s["t"] + g(0, 0.4))
        put("SEP-001", "LVL", clamp(50 + 6 * math.sin(t / 1800) + g(0, 1.5), 0, 100))
        put("SEP-001", "ILVL", clamp(30 + g(0, 1.0), 0, 100))
        put("SEP-001", "QO", s["o"] * (1 + g(0, 0.005)))
        put("SEP-001", "QW", s["w"] * (1 + g(0, 0.005)))
        put("SEP-001", "QG", s["g"] * (1 + g(0, 0.01)))

        pump_on = outage is None
        # surge volume (bbl) above 150 is pumped out over ~6 h on top of the separator flow
        q_pump = clamp(s["o"] + (self.surge - 150) * 4, 0, self.p001_rated) if pump_on else 0.0
        self.surge = max(0.0, self.surge + (s["o"] - q_pump) * dt / DAY)
        self.pl_out = q_pump if self.pl_out is None else lag(self.pl_out, q_pump, dt,
                                                              (20 + 2.5 * self.pl_len) * 60)
        p_out = 40 + 0.38 * self.receiving.frac * self.receiving.h + g(0, 0.8)
        dp = 600 * self.pl_len / 30 * (q_pump / self.p001_rated) ** 1.85
        p_in = p_out + dp
        hyd_hp = q_pump * (p_in - self.sep_p) / 58771
        put("P-001", "STATUS", self.idx["Equipment Status"]["Running" if pump_on else "Tripped"])
        put("P-001", "PS", self.sep_p - 6 + g(0, 0.8))
        put("P-001", "PD", p_in if pump_on else p_out)
        put("P-001", "FLOW", q_pump * (1 + g(0, 0.004)))
        put("P-001", "AMPS", (50 + 250 * hyd_hp / (250 * 0.75) + g(0, 1.5)) if pump_on else 0.0)
        put("P-001", "VIB", (2.4 + g(0, 0.12)) if pump_on else 0.1)
        put("P-001", "BRGT", temp + (65 if pump_on else 5) + g(0, 0.5))
        put("PL-001", "PIN", p_in if pump_on else p_out + 5)
        put("PL-001", "POUT", p_out)
        put("PL-001", "QIN", q_pump * (1 + g(0, 0.003)))
        put("PL-001", "QOUT", self.pl_out * (1 - 0.0005) * (1 + g(0, 0.003)))
        put("GT", "STATUS", self.idx["Unit Status"]["Normal Operation" if pump_on else "Shutdown"])
        put("GT", "SCEN", self.idx["Sim Scenario"]["Power Outage" if outage else "Normal"])
        put("GT", "THRU", q_pump)

        # ---- crude tanks & CDU feed --------------------------------------
        if self.field_ema is None:
            self.field_ema = max(qo, 0.3 * self.cap)
            self.feed = clamp(self.field_ema, 0.45 * self.cap, self.cap)
        self.field_ema = lag(self.field_ema, self.pl_out, dt, 3 * DAY)
        inv_frac = (self.tk_a.inv + self.tk_b.inv) / (self.tk_a.cap + self.tk_b.cap)
        feed_sp = clamp(self.field_ema * (1 + 1.5 * (inv_frac - 0.5)), 0.3 * self.cap, self.cap)
        if inv_frac < 0.10:
            feed_sp = min(feed_sp, 0.8 * self.field_ema)
        max_step = 0.05 * self.cap * dt / HOUR
        self.feed = clamp(feed_sp, self.feed - max_step, self.feed + max_step)
        if self.feeding.inv < 0.03 * self.feeding.cap:
            self.feed = 0.0
        if self.feeding.frac < 0.12 or self.receiving.frac > 0.88:
            if self.receiving.frac > self.feeding.frac:
                self.receiving, self.feeding = self.feeding, self.receiving
        self.receiving.step(dt, self.pl_out, 0.0, temp + 8)
        self.feeding.step(dt, 0.0, self.feed, temp + 8)
        feed = self.feeding.qout
        for tk in (self.tk_a, self.tk_b):
            put(tk_id(tk, self), "LVL", tk.frac * tk.h + g(0, 0.01))
            put(tk_id(tk, self), "TEMP", tk.temp + g(0, 0.2))
            put(tk_id(tk, self), "QIN", tk.qin)
            put(tk_id(tk, self), "QOUT", tk.qout)
            put(tk_id(tk, self), "INV", tk.inv)

        # ---- CDU-100 -----------------------------------------------------
        cdu_scen = "Normal"
        fe = self.fouling_tl.active(t)
        if fe:
            self.fouling = fe.progress(t)
            cdu_scen = "Heater Fouling"
        elif self.fouling_tl.just_ended(t, dt):
            self.fouling = 0.0  # decoked
        load = feed / self.cap
        put("P-101", "STATUS", self.idx["Equipment Status"]["Running" if feed > 0 else "Stopped"])
        put("P-101", "PS", 30 + 0.38 * self.feeding.frac * self.feeding.h + g(0, 0.5))
        put("P-101", "PD", (330 + 40 * load + g(0, 1.5)) if feed > 0 else 30.0)
        put("P-101", "FLOW", feed * (1 + g(0, 0.004)))
        put("P-101", "AMPS", (40 + 160 * load + g(0, 1.5)) if feed > 0 else 0.0)
        put("P-101", "VIB", (2.1 + g(0, 0.1)) if feed > 0 else 0.1)
        put("P-101", "BRGT", temp + 60 * min(1, load + 0.2) + g(0, 0.5))

        wash = 0.05 * feed * (1 + g(0, 0.02))
        put("D-101", "TIN", 250 + g(0, 1.0))
        put("D-101", "PRES", 160 + g(0, 1.0))
        put("D-101", "QWW", wash)
        put("D-101", "ILVL", clamp(50 + g(0, 1.5), 0, 100))
        put("D-101", "AMPS", 25 + 10 * load + g(0, 0.6))
        put("D-101", "SALT", max(0.1, 1.2 + abs(g(0, 0.25)) + (3 if rng.random() < 0.002 else 0)))

        cot_sp = 700 - 2 * (self.api - 20)
        h_tin = 470 + g(0, 1.5)
        cot = cot_sp + g(0, 1.5) if feed > 0 else h_tin
        duty = feed / 24 * 300 * 0.68 * (cot - h_tin) / 1e6
        eff = 0.86 - 0.06 * self.fouling
        fuel = duty / eff * 24 / 1.02
        dfrac = duty / max(self.h101_duty, 0.1)
        put("H-101", "TIN", h_tin)
        put("H-101", "COT", cot)
        put("H-101", "QFG", fuel * (1 + g(0, 0.01)))
        put("H-101", "PFG", 25 + 10 * dfrac + g(0, 0.4))
        put("H-101", "O2", 3.0 + self.n_o2.step(dt))
        put("H-101", "TSTK", 380 + 60 * self.fouling + 0.5 * (temp - 80) + g(0, 1.5))
        put("H-101", "TBW", 1350 + 150 * dfrac + 50 * self.fouling + g(0, 3))
        put("H-101", "TMT", 860 + 70 * dfrac + 140 * self.fouling + g(0, 2))

        if self.draws is None:
            self.draws = [feed * y for y in (self.y_nap, self.y_ker, self.y_dsl, self.y_res)]
        targets = (self.y_nap, self.y_ker, self.y_dsl, self.y_res)
        self.draws = [lag(d, feed * y, dt, 15 * 60) for d, y in zip(self.draws, targets)]
        nap, ker, dsl, res = [d * (1 + g(0, 0.008)) for d in self.draws]
        put("C-101", "QF", feed)
        put("C-101", "TTOP", 260 + 120 * (self.y_nap - 0.15) + g(0, 1.0))
        put("C-101", "TBOT", cot - 25 + g(0, 0.8))
        put("C-101", "QREF", 1.2 * nap)
        put("C-101", "LVL", clamp(50 + g(0, 2.5), 0, 100))
        put("C-101", "DP", 3.0 + 1.5 * load ** 2 + g(0, 0.05))
        put("C-101", "PTOP", 12 + self.n_ptop.step(dt))
        put("C-101", "TFZ", cot - 8 + g(0, 0.8))
        put("C-101", "QNAP", nap)
        put("C-101", "QKER", ker)
        put("C-101", "QDSL", dsl)
        put("C-101", "QRES", res)
        put("CDU100", "STATUS", self.idx["Unit Status"][
            "Shutdown" if feed <= 0 else "Normal Operation" if load >= 0.7 else "Reduced Rate"])
        put("CDU100", "SCEN", self.idx["Sim Scenario"][cdu_scen])
        put("CDU100", "THRU", feed)

        # ---- utilities: steam ------------------------------------------
        motive_design = self.cap * 1.0
        steam = 0.35 * self.boiler_rated + motive_design + 0.2 * self.boiler_rated * load
        steam_p = 150 + self.n_steam.step(dt)
        put("B-501", "STATUS", self.idx["Equipment Status"]["Running"])
        put("B-501", "QSTM", steam * (1 + g(0, 0.01)))
        put("B-501", "PSTM", steam_p)
        put("B-501", "TSTM", 420 + g(0, 1.5))
        put("B-501", "LVL", clamp(50 + g(0, 2), 0, 100))
        put("B-501", "QFW", steam * 1.02 * (1 + g(0, 0.01)))
        put("B-501", "QFG", steam * 1000 / 0.82 / 1e6 * 24 / 1.02 * (1 + g(0, 0.01)))
        put("B-501", "O2", 3.2 + self.n_o2b.step(dt))
        put("B-501", "TSTK", 360 + 0.4 * (temp - 80) + g(0, 1.2))
        put("STM", "STATUS", self.idx["Unit Status"]["Normal Operation"])
        put("STM", "SCEN", self.idx["Sim Scenario"]["Normal"])

        # ---- utilities: cooling water -----------------------------------
        ce = self.ct_tl.active(t)
        degraded = ce is not None
        heat = 0.5 + 0.5 * load
        approach = 7 + 3 * heat + (7 if degraded else 0)
        tsup_t = wb + approach
        self.tsup = tsup_t if self.tsup is None else lag(self.tsup, tsup_t, dt, 20 * 60)
        rng_ct = 4 + 12 * heat
        circ = self.ct_design * 0.85 * (1 + g(0, 0.005))
        put("CT-501", "STATUS", self.idx["Equipment Status"]["Tripped" if degraded else "Running"])
        put("CT-501", "TSUP", self.tsup + g(0, 0.2))
        put("CT-501", "TRET", self.tsup + rng_ct + g(0, 0.2))
        put("CT-501", "TWB", wb + g(0, 0.2))
        put("CT-501", "QCW", circ)
        put("CT-501", "QMU", 0.00085 * circ * rng_ct * 1.3 * (1 + g(0, 0.02)))
        put("CT-501", "LVL", clamp(70 + g(0, 1.5), 0, 100))
        put("CW", "STATUS", self.idx["Unit Status"]["Reduced Rate" if degraded else "Normal Operation"])
        put("CW", "SCEN", self.idx["Sim Scenario"]["Cooling Tower Degraded" if degraded else "Normal"])

        # ---- VDU-200 -----------------------------------------------------
        ve = self.vacuum_tl.active(t)
        motive_t = steam_p - 8 - ((25 + 20 * ve.params["u"]) if ve else 0)
        self.motive_p = lag(self.motive_p, motive_t, dt, 30 * 60)
        vfeed = res
        vload = vfeed / self.vdu_cap
        tcwi = self.tsup + 1
        tco = tcwi + 8 + 4 * vload
        psuc = 18 + 0.9 * max(0.0, tco - 85) + 0.55 * max(0.0, 140 - self.motive_p) + 6 * vload \
            + self.n_vac.step(dt)
        ptop = psuc + 3
        put("EJ-201", "PSTM", self.motive_p + g(0, 0.5))
        put("EJ-201", "QSTM", motive_design * (max(self.motive_p, 10) / 142) ** 0.9 * (1 + g(0, 0.01)))
        put("EJ-201", "PSUC", psuc)
        put("EJ-201", "TCWI", tcwi + g(0, 0.2))
        put("EJ-201", "TCO", tco + g(0, 0.3))
        put("EJ-201", "LVL", clamp(50 + g(0, 2), 0, 100))

        h2_tin = cot - 35 + g(0, 1)
        h2_cot = 745 + g(0, 1.5) if vfeed > 0 else h2_tin
        duty2 = vfeed / 24 * 300 * 0.68 * (h2_cot - h2_tin) / 1e6
        dfrac2 = duty2 / max(self.h201_duty, 0.1)
        put("H-201", "TIN", h2_tin)
        put("H-201", "COT", h2_cot)
        put("H-201", "QFG", duty2 / 0.85 * 24 / 1.02 * (1 + g(0, 0.01)))
        put("H-201", "PFG", 22 + 10 * dfrac2 + g(0, 0.4))
        put("H-201", "O2", 3.3 + g(0, 0.15))
        put("H-201", "TSTK", 400 + 0.5 * (temp - 80) + g(0, 1.5))
        put("H-201", "TBW", 1400 + 120 * dfrac2 + g(0, 3))
        put("H-201", "TMT", 900 + 80 * dfrac2 + g(0, 2))

        lift = clamp(0.62 - 0.004 * (ptop - 35), 0.40, 0.70)
        pfz = ptop + 12 + 6 * vload ** 2
        put("C-201", "QF", vfeed)
        put("C-201", "TTOP", 150 + 0.4 * (ptop - 35) + g(0, 0.8))
        put("C-201", "TBOT", h2_cot - 37 + g(0, 0.8))
        put("C-201", "QREF", 0.08 * vfeed * (1 + g(0, 0.01)))
        put("C-201", "LVL", clamp(50 + g(0, 2.5), 0, 100))
        put("C-201", "DP", (pfz - ptop) * 0.0193)
        put("C-201", "PTOP", ptop)
        put("C-201", "PFZ", pfz + g(0, 0.3))
        put("C-201", "TFZ", h2_cot - 12 + g(0, 0.8))
        lvgo, hvgo, vr = 0.25 * lift * vfeed, 0.75 * lift * vfeed, (1 - lift) * vfeed
        put("C-201", "QLVGO", lvgo * (1 + g(0, 0.01)))
        put("C-201", "QHVGO", hvgo * (1 + g(0, 0.01)))
        put("C-201", "QVR", vr * (1 + g(0, 0.01)))
        put("C-201", "QWO", 0.06 * vfeed * (1 + g(0, 0.01)))
        vdu_status = "Shutdown" if vfeed <= 0 else "Upset" if ptop > 70 else \
            "Normal Operation" if vload > 0.5 else "Reduced Rate"
        put("VDU200", "STATUS", self.idx["Unit Status"][vdu_status])
        put("VDU200", "SCEN", self.idx["Sim Scenario"]["Vacuum Loss" if ve else
                                                       "Cooling Tower Degraded" if degraded else "Normal"])
        put("VDU200", "THRU", vfeed)

        # ---- HDT-300 -----------------------------------------------------
        ke = self.k_tl.active(t)
        upcoming = self.k_tl.events[0] if self.k_tl.events else None
        lead = (upcoming.start - t) if upcoming and upcoming.start > t else None
        self.k_running = ke is None
        if lead is not None and lead < 6 * HOUR:
            vib_t = 0.9 + 1.6 * (1 - lead / (6 * HOUR))  # precursor before the trip
        else:
            vib_t = 0.9
        self.vib_k = lag(self.vib_k, vib_t, dt, 20 * 60)
        hdt_target = dsl if self.k_running else 0.0
        self.hdt_feed = lag(self.hdt_feed, hdt_target, dt, 15 * 60)
        hfeed = self.hdt_feed
        hload = hfeed / self.hdt_cap
        weeks = (t - self.cat_load) / (7 * DAY)
        r_tin = 640 + 0.15 * weeks + g(0, 1.0)
        put("R-301", "QF", hfeed)
        put("R-301", "TIN", r_tin)
        put("R-301", "TOUT", r_tin + 25 * hload + g(0, 0.8))
        put("R-301", "PRES", (650 + g(0, 2)) if self.k_running else 450 + g(0, 2))
        put("R-301", "DP", 18 + 0.02 * weeks + 4 * hload ** 2 + g(0, 0.2))
        put("R-301", "QH2", hfeed * 0.3 * (1 + g(0, 0.01)) if self.k_running else 0.0)
        put("R-301", "SULF", max(1.0, 8 + 0.04 * max(0, 660 - r_tin) + g(0, 0.6)) if self.k_running
            else 350 + g(0, 20))
        kflow = self.k_rated * 0.85 * (1 + g(0, 0.01)) if self.k_running else 0.0
        put("K-301", "STATUS", self.idx["Equipment Status"]["Running" if self.k_running else "Tripped"])
        put("K-301", "PS", 595 + g(0, 1.5) if self.k_running else 450)
        put("K-301", "PD", 700 + g(0, 2) if self.k_running else 450)
        put("K-301", "TD", (150 + 0.3 * (temp - 80) + g(0, 0.6)) if self.k_running else temp + 10)
        put("K-301", "FLOW", kflow)
        put("K-301", "SPD", 10500 + g(0, 20) if self.k_running else 0.0)
        put("K-301", "VIB", (self.vib_k + abs(g(0, 0.05))) if self.k_running else 0.05)
        put("K-301", "AMPS", 180 + g(0, 2) if self.k_running else 0.0)
        put("V-301", "PRES", 600 + g(0, 1.5) if self.k_running else 450)
        put("V-301", "TEMP", 120 + 0.3 * (temp - 80) + g(0, 0.4))
        put("V-301", "LVL", clamp(50 + g(0, 2), 0, 100))
        put("V-301", "ILVL", clamp(25 + g(0, 1.5), 0, 100))
        put("V-301", "QO", hfeed * 1.005)
        put("V-301", "QW", hfeed * 0.04 * (1 + g(0, 0.02)))
        put("V-301", "QG", kflow)
        put("HDT300", "STATUS", self.idx["Unit Status"][
            "Upset" if not self.k_running else "Normal Operation" if hload > 0.6 else "Reduced Rate"])
        put("HDT300", "SCEN", self.idx["Sim Scenario"]["Compressor Trip" if ke else "Normal"])
        put("HDT300", "THRU", hfeed)

        # ---- product tanks ----------------------------------------------
        bypass = max(0.0, dsl - hfeed)  # untreated diesel when the HDT is down
        inflow = {"TK-401": nap, "TK-402": ker, "TK-403": hfeed * 1.005 + bypass, "TK-404": lvgo + hvgo + vr}
        daytime = 6 <= hour < 20
        for k, tk in self.products.items():
            if tk.frac > 0.75:
                self.dispatching[k] = True
            elif tk.frac < 0.30:
                self.dispatching[k] = False
            avg = self.cap * {"TK-401": self.y_nap, "TK-402": self.y_ker, "TK-403": self.y_dsl,
                              "TK-404": self.y_res}[k]
            qout = 2.4 * avg if (self.dispatching[k] and daytime) else 0.0
            tk.step(dt, inflow[k], qout, (140 if k == "TK-404" else temp + 4))
            put(k, "LVL", tk.frac * tk.h + g(0, 0.01))
            put(k, "TEMP", tk.temp + g(0, 0.2))
            put(k, "QIN", tk.qin)
            put(k, "QOUT", tk.qout)
            put(k, "INV", tk.inv)
        return out


def tk_id(tank, site):
    return "TK-101" if tank is site.tk_a else "TK-102"
