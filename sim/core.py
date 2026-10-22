"""Small building blocks shared by the well and refinery models."""
import math
import random

DAY = 86400.0
HOUR = 3600.0


def rng_for(seed, key):
    """Independent, reproducible random stream per entity."""
    return random.Random(f"{seed}:{key}")


def lag(prev, target, dt, tau):
    """First-order lag (process dynamics, sensor smoothing)."""
    if tau <= 0:
        return target
    return prev + (target - prev) * (1.0 - math.exp(-dt / tau))


def clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


def interp(x, x0, y0, x1, y1):
    f = clamp((x - x0) / (x1 - x0), 0.0, 1.0)
    return y0 + (y1 - y0) * f


class OU:
    """Ornstein-Uhlenbeck noise: mean-reverting drift with stationary std `sigma`."""

    def __init__(self, rng, sigma, tau, mu=0.0):
        self.rng, self.sigma, self.tau, self.mu = rng, sigma, tau, mu
        self.x = mu + rng.gauss(0, sigma)

    def step(self, dt):
        a = math.exp(-dt / self.tau)
        self.x = self.mu + (self.x - self.mu) * a + self.sigma * math.sqrt(1 - a * a) * self.rng.gauss(0, 1)
        return self.x


class Event:
    __slots__ = ("name", "start", "end", "params")

    def __init__(self, name, start, end, params=None):
        self.name, self.start, self.end, self.params = name, start, end, params or {}

    def progress(self, t):
        return clamp((t - self.start) / max(1.0, self.end - self.start), 0.0, 1.0)


class Timeline:
    """Lazily generated, non-overlapping sequence of scenario events.

    kinds: list of (name, mean_gap_days, (min_dur_h, max_dur_h)). Events are drawn
    one after another, so the schedule extends forever and is reproducible.
    """

    def __init__(self, rng, t0, kinds, first_gap_days=(1, 20)):
        self.rng, self.kinds = rng, kinds
        self.events = []
        self.cursor = t0 + rng.uniform(*first_gap_days) * DAY
        self.last = None

    def _extend(self, t):
        while self.cursor <= t + DAY:
            weights = [1.0 / k[1] for k in self.kinds]
            name, gap, (lo, hi) = self.rng.choices(self.kinds, weights=weights)[0]
            start = self.cursor
            end = start + self.rng.uniform(lo, hi) * HOUR
            self.events.append(Event(name, start, end, {"u": self.rng.random()}))
            mean_gap = 1.0 / sum(weights)
            self.cursor = end + self.rng.expovariate(1.0 / mean_gap) * DAY

    def active(self, t):
        self._extend(t)
        while self.events and self.events[0].end < t:
            self.last = self.events.pop(0)
        if self.events and self.events[0].start <= t:
            return self.events[0]
        return None

    def just_ended(self, t, dt):
        """Event that ended inside (t - dt, t]."""
        if self.last and t - dt < self.last.end <= t:
            return self.last
        return None


class Climate:
    """Site ambient dry-bulb and wet-bulb temperature (°F) with daily cycle and weather."""

    def __init__(self, rng, utc, t_amb, t_amp, wb_dep):
        self.utc, self.t_amb, self.t_amp, self.wb_dep = utc, t_amb, t_amp, wb_dep
        self.weather = OU(rng, 3.0, 2.5 * DAY)
        self.humid = OU(rng, 1.5, 1.0 * DAY)
        self.temp = t_amb
        self.wet_bulb = t_amb - wb_dep

    def local_hour(self, t):
        return ((t / HOUR) + self.utc) % 24.0

    def step(self, t, dt):
        h = self.local_hour(t)
        self.temp = self.t_amb + self.t_amp * math.sin(2 * math.pi * (h - 9.0) / 24.0) + self.weather.step(dt)
        self.wet_bulb = self.temp - self.wb_dep - 0.35 * max(0.0, self.temp - self.t_amb) + self.humid.step(dt)
        return self.temp
