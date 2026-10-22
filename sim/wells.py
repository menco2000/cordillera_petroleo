"""Producing well model: decline, scenarios, status machine and lift-specific signals."""
import math

from .core import DAY, HOUR, OU, Timeline, clamp, lag, rng_for

# Scenario mix per lift method: (name, mean gap in days, (min, max) duration in hours)
COMMON = [("Planned Shut-In", 28, (6, 48)), ("Workover", 150, (48, 144))]
KINDS = {
    "ESP": COMMON + [("Gas Interference", 30, (4, 24)), ("ESP Pump Wear", 70, (240, 600)),
                     ("Sand Production", 60, (6, 48))],
    "Rod Pump": COMMON + [("Rod Pump Fluid Pound", 20, (24, 120)), ("Gas Interference", 45, (4, 24)),
                          ("Sand Production", 70, (6, 48))],
    "PCP": COMMON + [("Sand Production", 25, (6, 48)), ("Gas Interference", 50, (4, 24))],
    "Gas Lift": COMMON + [("Sand Production", 60, (6, 48))],
    "Natural Flow": COMMON + [("Sand Production", 60, (6, 48))],
}
LIFTED = {"ESP", "Rod Pump", "PCP", "Gas Lift"}


class Well:
    def __init__(self, node, enums, seed, t0, utc):
        v, s = node["values"], node["sim"]
        self.prefix = node["tag_prefix"]
        self.name = node["name"]
        self.lift = v["Lift Method"]
        self.utc = utc
        self.t0 = t0
        self.rng = rng = rng_for(seed, self.prefix)
        self.status_idx = {n: i for i, n in enumerate(enums["Well Status"])}
        self.scen_idx = {n: i for i, n in enumerate(enums["Sim Scenario"])}

        self.design = v["Design Oil Rate"]
        self.pr = v["Static Reservoir Pressure"]
        self.perf = v["Perforation Top"]
        self.res_t = v["Reservoir Temperature"]
        self.pi = v["Productivity Index"]
        self.pump_depth = s["pump_depth"]
        self.di, self.b, self.age = s["decline_per_year"], s["b_factor"], s["age_days"]
        self.wc0, self.gor = s["water_cut"], s["gor"]
        self.l_design = self.design / (1 - self.wc0)
        self.dd_design = self.design / self.pi

        self.timeline = Timeline(rng, t0, KINDS[self.lift])
        self.breakthrough = None
        if rng.random() < 0.35:
            start = t0 + rng.uniform(10, 80) * DAY
            self.breakthrough = (start, start + rng.uniform(14, 28) * DAY, rng.uniform(0.15, 0.35))
        self.wc_shift = 0.0

        self.status = "Producing"
        self.scenario = "Normal"
        self.trip_until = -1.0
        self.trip_reason = None
        self.startup = None
        self.forced_workover = None
        self.wear = 0.0
        self.outage_stagger = None

        self.choke_sp = s["choke"] if self.lift in ("Natural Flow", "Gas Lift") else 100.0
        self.next_choke_move = t0 + rng.uniform(2, 10) * DAY
        self.freq_sp = rng.uniform(52, 60)
        self.hp = v.get("Motor Rating", 200)
        self.spm_sp = rng.uniform(4.5, 8.5)
        self.plunger = v.get("Plunger Diameter", 1.75)
        self.qgi_nom = clamp(0.5 * self.l_design, 250, 900)
        self.pgi_sp = rng.uniform(950, 1300)
        self.glchoke_sp = rng.uniform(40, 70)
        self.rpm_sp = 0.7 * v.get("Max Rotor Speed", 350)

        self.n_rate = OU(rng, 0.025, 3 * HOUR)
        self.n_gas = OU(rng, 0.04, 6 * HOUR)
        self.n_chp = OU(rng, 6, 4 * HOUR)
        self.chp_base = {"ESP": rng.uniform(100, 220), "Rod Pump": rng.uniform(30, 110),
                         "PCP": rng.uniform(30, 110), "Natural Flow": rng.uniform(5, 40)}.get(self.lift, 0)

        age_years = self.age / 365.0
        self.cum = self.design * 365 * age_years * rng.uniform(0.35, 0.55)
        self.day_oil = 0.0
        self.day = None
        self.run_s = self.day_s = 0.0
        self.bhp = self.pr - 0.8 * self.dd_design
        self.thp = self.flp = self.wht = None
        self.mott = self.res_t
        self.pgi = self.pgi_sp

    # ---- state machine -----------------------------------------------------
    def _status(self, t, dt, outage):
        ev = self.timeline.active(t)
        ended = self.timeline.just_ended(t, dt)
        if ended:
            u = ended.params["u"]
            if ended.name == "Gas Interference" and self.lift in ("ESP", "PCP", "Rod Pump") and u < 0.4:
                self.trip_until, self.trip_reason = t + (1 + 3 * u) * HOUR, ended.name
            elif ended.name == "Sand Production" and self.lift == "PCP" and u < 0.35:
                self.trip_until, self.trip_reason = t + (2 + 4 * u) * HOUR, ended.name
            elif ended.name == "ESP Pump Wear":
                self.forced_workover = t + (2 + 2 * u) * DAY
            elif ended.name == "Workover":
                self._after_workover()
        if self.forced_workover and t >= self.forced_workover:
            self.forced_workover = None
            self._after_workover()

        if outage and self.lift in LIFTED:
            if self.outage_stagger is None:
                self.outage_stagger = self.rng.uniform(5, 60) * 60
            self.trip_until = max(self.trip_until, outage[1] + self.outage_stagger)
            self.trip_reason = "Power Outage"
        elif not outage:
            self.outage_stagger = None

        if self.forced_workover or (ev and ev.name == "Workover"):
            desired, label = "Workover", "Workover"
        elif ev and ev.name == "Planned Shut-In":
            desired, label = "Shut-In", "Planned Shut-In"
        elif t < self.trip_until:
            desired, label = "Tripped", self.trip_reason
        else:
            desired = "Producing"
            label = ev.name if ev else None

        if desired == "Producing":
            if self.status in ("Shut-In", "Tripped", "Workover"):
                self.startup = (t, t + self.rng.uniform(20, 45) * 60)
            if self.startup and t < self.startup[1]:
                desired = "Starting Up"
            else:
                self.startup = None
        else:
            self.startup = None

        if label is None and self.breakthrough and self.breakthrough[0] <= t <= self.breakthrough[1]:
            label = "Water Breakthrough"
        self.status = desired
        self.scenario = label or "Normal"
        return ev

    def _after_workover(self):
        self.wear = 0.0
        self.wc_shift -= 0.05
        self.trip_until = -1.0

    # ---- physics -----------------------------------------------------------
    def step(self, t, dt, temp, sep_p, outage):
        rng = self.rng
        ev = self._status(t, dt, outage)
        name = ev.name if ev else ""
        prog = ev.progress(t) if ev else 0.0
        flowing = self.status in ("Producing", "Starting Up")
        ramp = 1.0
        if self.status == "Starting Up":
            ramp = clamp((t - self.startup[0]) / (self.startup[1] - self.startup[0]), 0.05, 1.0)

        if name == "ESP Pump Wear":
            self.wear = max(self.wear, prog)

        if t >= self.next_choke_move and self.lift in ("Natural Flow", "Gas Lift"):
            self.choke_sp = clamp(self.choke_sp + rng.choice([-5, -3, 3, 5]), 40, 95)
            self.next_choke_move = t + rng.uniform(4, 12) * DAY

        days = self.age + (t - self.t0) / DAY
        decl = (1 + self.b * self.di * days / 365.0) ** (-1.0 / self.b)
        wc = self.wc0 + 0.02 * (t - self.t0) / (90 * DAY) + self.wc_shift
        if self.breakthrough:
            s, e, d = self.breakthrough
            wc += d * clamp((t - s) / (e - s), 0, 1)
        wc = clamp(wc, 0.02, 0.97)

        # lift setpoints and efficiency
        freq = spm = qgi = rpm = 0.0
        fill = 0.0
        eff = 1.0
        if self.lift == "Natural Flow":
            eff = (self.choke_sp / 70.0) ** 0.6
        elif self.lift == "ESP":
            freq = self.freq_sp * (0.6 + 0.4 * ramp) if flowing else 0.0
            eff = (freq / 60.0) ** 1.3 * (1 - 0.45 * self.wear)
        elif self.lift == "Rod Pump":
            spm = self.spm_sp if flowing else 0.0
            if name == "Rod Pump Fluid Pound":
                fill = 85 - 35 * min(1, prog * 2) + rng.gauss(0, 4)
            elif name == "Gas Interference":
                fill = 70 + rng.gauss(0, 8)
            else:
                fill = 92 + rng.gauss(0, 2)
            fill = clamp(fill, 30, 99)
            runtime = 0.72 if name == "Rod Pump Fluid Pound" else 0.99
            eff = fill / 93.0 * runtime
        elif self.lift == "Gas Lift":
            qgi = self.qgi_nom * ramp if flowing else 0.0
            eff = 0.7 + 0.3 * min(1.2, qgi / self.qgi_nom) * (self.choke_sp / 70.0) ** 0.3
        elif self.lift == "PCP":
            rpm = self.rpm_sp * ramp if flowing else 0.0
            eff = rpm / self.rpm_sp if self.rpm_sp else 0
        if name == "Sand Production":
            eff *= 0.9
        if name == "Gas Interference" and self.lift in ("ESP", "PCP"):
            eff *= 0.78 + 0.1 * rng.gauss(0, 1)

        noise = (1 + self.n_rate.step(dt)) * (1 + rng.gauss(0, 0.008))
        liquid = self.l_design * decl * eff * ramp * noise if flowing else 0.0
        liquid = max(0.0, liquid)
        oil, water = liquid * (1 - wc), liquid * wc
        gas = oil * self.gor / 1000.0 * (1 + self.n_gas.step(dt))

        # pressures and temperatures
        pr_now = self.pr * (1 - 0.015 * (t - self.t0) / (90 * DAY))
        if flowing:
            bhp_t = pr_now - self.dd_design * liquid / self.l_design
            self.bhp = lag(self.bhp, bhp_t, dt, 1 * HOUR)
        else:
            self.bhp = lag(self.bhp, pr_now, dt, 8 * HOUR)
        bhp = max(50.0, self.bhp + rng.gauss(0, 1.5))

        flp_t = sep_p + 12 + 0.006 * liquid
        if self.lift in ("Natural Flow", "Gas Lift"):
            grad = 0.36 * (0.8 + 0.2 * wc) * (1 - min(0.55, self.gor / 4000.0))
            if self.lift == "Gas Lift" and flowing:
                grad *= 0.7
            thp_t = max(flp_t + 25, bhp - grad * self.perf - 14.7) if flowing else \
                max(flp_t, pr_now - 0.33 * self.perf - 14.7)
        else:
            thp_t = flp_t + 8 + 0.01 * liquid if flowing else flp_t
        if name == "Sand Production":
            flp_t += abs(rng.gauss(0, 6))
        self.flp = flp_t if self.flp is None else lag(self.flp, flp_t, dt, 10 * 60)
        self.thp = thp_t if self.thp is None else lag(self.thp, thp_t, dt, 10 * 60)

        wht_t = temp + (self.res_t - temp) * 0.85 * liquid / (liquid + 700) if flowing else temp
        self.wht = wht_t if self.wht is None else lag(self.wht, wht_t, dt, 40 * 60)
        bht = self.res_t - (1.5 if flowing else 0) + rng.gauss(0, 0.3)

        if self.lift == "Gas Lift":
            self.pgi = lag(self.pgi, self.pgi_sp if flowing else 300, dt, 20 * 60)
            chp = self.pgi - 15 + rng.gauss(0, 3)
        else:
            chp = self.chp_base + self.n_chp.step(dt) + (25 if not flowing else 0)

        out = {
            "STATUS": self.status_idx[self.status],
            "SCEN": self.scen_idx[self.scenario],
            "THP": self.thp + rng.gauss(0, 1.0),
            "CHP": max(0.0, chp),
            "FLP": self.flp + rng.gauss(0, 0.8),
            "WHT": self.wht + rng.gauss(0, 0.3),
            "CHOKE": (self.choke_sp if flowing else 0.0),
            "BHP": bhp,
            "BHT": bht,
            "QO": oil,
            "QW": water,
            "QG": max(0.0, gas),
        }

        # totalizers (site local day)
        day = math.floor((t / HOUR + self.utc) / 24)
        if day != self.day:
            self.day, self.day_oil, self.run_s, self.day_s = day, 0.0, 0.0, 0.0
        self.day_oil += oil * dt / DAY
        self.cum += oil * dt / DAY
        out["DAYOIL"] = self.day_oil
        out["CUMOIL"] = self.cum

        on = flowing
        if self.lift == "ESP":
            a_nom = 20 + self.hp * 0.15
            load = 0.45 + 0.4 * (liquid / self.l_design) * (freq / 60) ** 2 + 0.25 * self.wear
            if name == "Gas Interference":
                load *= 0.7 + 0.25 * abs(rng.gauss(0, 1))
            pip = bhp - 0.35 * (self.perf - self.pump_depth) - 14.7
            if name == "Gas Interference":
                pip *= 0.85
            self.mott = lag(self.mott, (bht + 20 + 45 * load + 25 * self.wear + (25 if name == "Gas Interference"
                                                                                  else 0)) if on else bht,
                            dt, 30 * 60)
            out.update({
                "PIP": max(0.0, pip + rng.gauss(0, 2)),
                "PDP": self.thp + 0.38 * self.pump_depth * (0.85 + 0.15 * wc) + (0.02 * liquid if on else 0),
                "MOTT": self.mott + rng.gauss(0, 0.5),
                "AMPS": a_nom * load * (1 + rng.gauss(0, 0.01)) if on else 0.0,
                "FREQ": freq,
                "VIB": (0.08 + 0.35 * self.wear + (0.3 if name == "Sand Production" else 0)
                        + abs(rng.gauss(0, 0.01))) if on else 0.01,
            })
        elif self.lift == "Rod Pump":
            rod = self.pump_depth * 1.8 * 0.87
            fluid = math.pi / 4 * self.plunger ** 2 * self.pump_depth * 0.433 * (0.88 + 0.12 * wc) * 0.95
            dyn = rod * 0.12 * (spm / 6.0)
            pound = name == "Rod Pump Fluid Pound"
            pprl = rod + fluid * (0.7 + 0.3 * fill / 100) + dyn
            mprl = rod - 1.1 * dyn - (0.15 * fluid if pound else 0)
            if pound:
                pprl *= 1 + rng.gauss(0, 0.05)
            self.day_s += dt
            if on:
                self.run_s += dt * (0.72 if pound else 0.99)
            out.update({
                "SPM": spm,
                "FILL": fill if on else 0.0,
                "PPRL": pprl * (1 + rng.gauss(0, 0.015)) if on else rod,
                "MPRL": mprl * (1 + rng.gauss(0, 0.015)) if on else rod,
                "AMPS": (18 + 30 * pprl / (rod + fluid + dyn) * (spm / 6) ** 0.5 + rng.gauss(0, 1)) if on else 0.0,
                "RUNT": 100.0 * self.run_s / max(self.day_s, 1.0),
            })
        elif self.lift == "Gas Lift":
            out.update({
                "QGI": qgi * (1 + rng.gauss(0, 0.01)),
                "PGI": self.pgi,
                "GLCHOKE": self.glchoke_sp if on else 0.0,
            })
        elif self.lift == "PCP":
            torque = 250 + 500 * (liquid / self.l_design) * (rpm / self.rpm_sp if self.rpm_sp else 0)
            if name == "Sand Production":
                torque *= 1 + 0.4 * prog + (0.4 if rng.random() < 0.3 else 0)
            torque = torque * (1 + rng.gauss(0, 0.02)) if on else 0.0
            out.update({
                "RPM": rpm,
                "TRQ": torque,
                "AMPS": (12 + 0.07 * torque + rng.gauss(0, 0.5)) if on else 0.0,
            })
        self.oil, self.water, self.gas_rate = oil, water, max(0.0, gas)
        self.wht_now = out["WHT"]
        return out
