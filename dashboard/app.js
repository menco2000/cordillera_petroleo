(function () {
  "use strict";
  const M = window.CP_MODEL, MAP = window.CP_MAP, CFG = window.CP_CONFIG || { source: "demo" };
  const SITES = Object.fromEntries(M.sites.map(s => [s.code, s]));
  const SVGNS = "http://www.w3.org/2000/svg";
  const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const $ = id => document.getElementById(id);

  const state = { source: null, data: null, trends: null, events: null, details: {}, view: null, hoverWell: null };

  // ---------------------------------------------------------------- helpers
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
    return e;
  }
  function sv(tag, attrs, ...kids) {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) e.setAttribute(k, v);
    for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
    return e;
  }
  const fmt = (v, d = 0) => v == null || Number.isNaN(v) ? "—" : (d ? nf1 : nf0).format(v);
  const sum = a => a.reduce((x, y) => x + (+y || 0), 0);
  const merc = lat => (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (Math.max(-85, Math.min(85, lat)) * Math.PI) / 360));
  const proj = (lon, lat) => [lon, -merc(lat)];

  // ---------------------------------------------------------------- status
  const LEVEL = {
    good: { color: "var(--good)", label: "Normal" },
    warning: { color: "var(--warning)", label: "Watch" },
    critical: { color: "var(--critical)", label: "Alert" },
    planned: { color: "var(--planned)", label: "Planned" },
  };
  const WELL_LEVEL = { "Producing": "good", "Starting Up": "warning", "Tripped": "critical", "Shut-In": "planned", "Workover": "planned" };
  const UNIT_LEVEL = { "Normal Operation": "good", "Reduced Rate": "warning", "Startup": "warning", "Upset": "critical", "Shutdown": "critical" };
  // events that need attention now; slow ones (heater fouling) are shown but don't change the status
  const ACUTE = new Set(["Vacuum Loss", "Compressor Trip", "Cooling Tower Degraded", "Power Outage"]);
  const UNIT_TEXT = { "Normal Operation": "Normal", "Reduced Rate": "Reduced rate", "Startup": "Starting up", "Upset": "Upset", "Shutdown": "Shutdown" };

  function icon(level) {
    const c = LEVEL[level].color;
    const g = sv("svg", { viewBox: "0 0 12 12", class: "ic", "aria-hidden": "true" });
    if (level === "good") g.append(sv("circle", { cx: 6, cy: 6, r: 6, fill: c }), sv("path", { d: "M3.2 6.2 5.2 8.1 8.9 4.1", stroke: "#fff", "stroke-width": 1.6, fill: "none", "stroke-linecap": "round" }));
    else if (level === "warning") g.append(sv("path", { d: "M6 .6 11.6 11 H.4 Z", fill: c, "stroke-linejoin": "round" }), sv("rect", { x: 5.3, y: 4, width: 1.4, height: 3.8, rx: .6, fill: "#3a2a00" }), sv("circle", { cx: 6, cy: 9.3, r: .8, fill: "#3a2a00" }));
    else if (level === "critical") g.append(sv("rect", { x: 0, y: 0, width: 12, height: 12, rx: 3, fill: c }), sv("path", { d: "M3.8 3.8 8.2 8.2 M8.2 3.8 3.8 8.2", stroke: "#fff", "stroke-width": 1.6, "stroke-linecap": "round" }));
    else g.append(sv("circle", { cx: 6, cy: 6, r: 6, fill: c }), sv("rect", { x: 3, y: 5.2, width: 6, height: 1.6, rx: .8, fill: "#fff" }));
    return g;
  }
  const pill = (level, text) => el("span", { class: "pill" }, icon(level), text || LEVEL[level].label);

  function siteStatus(code) {
    const s = state.data.sites[code], m = SITES[code];
    let level = "good"; const reasons = [], info = [];
    const bump = l => { if (l === "critical" || (l === "warning" && level === "good")) level = l; };
    for (const u of m.units) {
      const v = s.units[u.key] || {};
      const l = UNIT_LEVEL[v.status] || "good";
      // a secondary unit running below rate is normal when crude is light; only the CDU counts
      if (l === "critical" || (l === "warning" && u.key === "CDU")) { bump(l); reasons.push(`${u.label}: ${UNIT_TEXT[v.status]}`); }
      if (v.scenario && ACUTE.has(v.scenario)) { bump("warning"); reasons.push(`${u.label}: ${v.scenario}`); }
      else if (v.scenario && v.scenario !== "Normal") info.push(`${u.label}: ${v.scenario}`);
    }
    const ws = Object.values(s.wells);
    const tripped = ws.filter(w => w.status === "Tripped").length;
    const planned = ws.filter(w => w.status === "Shut-In" || w.status === "Workover").length;
    if (tripped) { bump(tripped / ws.length >= 0.3 ? "critical" : "warning"); reasons.unshift(`${tripped} well${tripped > 1 ? "s" : ""} tripped`); }
    if (planned) reasons.push(`${planned} planned stop${planned > 1 ? "s" : ""}`);
    return { level, reasons: reasons.concat(info) };
  }

  // ---------------------------------------------------------------- data
  async function load() {
    const want = CFG.source || "auto";
    const { demoSource, piSource } = window.CP_SOURCES;
    if (want !== "demo") {
      try {
        const src = piSource(CFG.piwebapi);
        const snap = await src.snapshot();
        state.source = src; state.data = snap;
        return;
      } catch (e) {
        if (want === "piwebapi") throw e;
        showBanner(`PI Web API could not be reached (${e.message}). Showing simulated demo data. See dashboard/README.md for CORS and authentication.`);
      }
    }
    state.source = demoSource();
    state.data = await state.source.snapshot();
  }

  async function loadExtras() {
    const src = state.source;
    try {
      const t = await src.trend();
      if (t) for (const [c, v] of Object.entries(t)) state.data.sites[c].trend = v;
    } catch (e) { console.warn("trend", e); }
    try {
      const ev = await src.events();
      if (ev) for (const [c, v] of Object.entries(ev)) state.data.sites[c].events = v;
    } catch (e) { console.warn("events", e); }
  }

  async function loadDetail(code) {
    if (state.details[code] || !state.source.siteDetail) return;
    try {
      const d = await state.source.siteDetail(code);
      if (!d) return;
      state.details[code] = true;
      for (const [id, v] of Object.entries(d)) Object.assign(state.data.sites[code].wells[id], v);
      if (state.view === code) render();
    } catch (e) { console.warn("detail", e); }
  }

  function showBanner(text) { const b = $("banner"); b.textContent = text; b.hidden = false; }

  // ---------------------------------------------------------------- aggregates
  function companyTrend() {
    const sites = Object.values(state.data.sites).filter(s => s.trend && s.trend.days.length);
    if (!sites.length) return null;
    const days = sites[0].trend.days;
    return {
      days,
      oil: days.map((_, i) => sum(sites.map(s => s.trend.oil[i]))),
      thru: days.map((_, i) => sum(sites.map(s => s.trend.thru[i]))),
    };
  }
  const avg = a => { const v = (a || []).filter(x => x != null); return v.length ? sum(v) / v.length : null; };

  // ---------------------------------------------------------------- header + kpis
  function renderHeader() {
    const c = $("crumbs"); c.replaceChildren();
    if (state.view) {
      c.append(el("button", { type: "button", onclick: () => go(null) }, "All sites"), el("span", { class: "sep" }, "›"),
        el("span", { class: "here" }, `${SITES[state.view].name}, ${SITES[state.view].country}`));
    } else c.append(el("span", { class: "here" }, "All sites"));
    const live = state.data.live;
    const src = $("src"); src.className = "src" + (live ? " live" : "");
    src.lastChild.textContent = live ? "Live · PI Web API" : "Demo data · simulator";
    const d = new Date(state.data.asOf);
    $("asof").textContent = `As of ${d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`;
  }

  function sparkline(values, color, w = 200, h = 26) {
    const v = (values || []).map(x => (x == null ? null : +x));
    const svg = sv("svg", { class: "spark", viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "none", "aria-hidden": "true" });
    const ok = v.filter(x => x != null);
    if (ok.length < 2) return svg;
    const lo = Math.min(...ok) * 0.95, hi = Math.max(...ok) * 1.02 || 1;
    const X = i => (i / (v.length - 1)) * (w - 4) + 2, Y = x => h - 3 - ((x - lo) / (hi - lo || 1)) * (h - 6);
    let d = "";
    v.forEach((x, i) => { if (x != null) d += (d ? "L" : "M") + X(i).toFixed(1) + "," + Y(x).toFixed(1); });
    svg.append(sv("path", { d: d + `L${X(v.length - 1)},${h}L${X(0)},${h}Z`, fill: color, opacity: 0.12 }),
      sv("path", { d, fill: "none", stroke: color, "stroke-width": 1.6, "vector-effect": "non-scaling-stroke", "stroke-linejoin": "round" }));
    const li = v.length - 1;
    if (v[li] != null) svg.append(sv("circle", { cx: X(li), cy: Y(v[li]), r: 2.4, fill: color }));
    return svg;
  }

  function kpi(label, value, unit, foot, spark) {
    return el("div", { class: "kpi" }, el("div", { class: "label" }, label),
      el("div", { class: "value" }, value, unit ? el("small", {}, unit) : null),
      el("div", { class: "foot" }, foot || ""), spark || null);
  }

  function delta(now, ref) {
    if (now == null || !ref) return null;
    const p = (100 * (now - ref)) / ref;
    return el("span", { class: p >= 0 ? "delta-up" : "delta-down" }, `${p >= 0 ? "▲" : "▼"} ${Math.abs(p).toFixed(1)}%`);
  }

  function renderKpis() {
    const k = $("kpis"); k.replaceChildren();
    const D = state.data.sites;
    if (!state.view) {
      const sites = Object.values(D), cap = sum(M.sites.map(s => s.capacity));
      const oil = sum(sites.map(s => s.oil)), water = sum(sites.map(s => s.water)), thru = sum(sites.map(s => s.thru));
      const wells = sites.flatMap(s => Object.values(s.wells));
      const prod = wells.filter(w => w.status === "Producing").length;
      const tripped = wells.filter(w => w.status === "Tripped").length;
      const planned = wells.filter(w => w.status === "Shut-In" || w.status === "Workover").length;
      const t = companyTrend();
      const st = M.sites.map(s => [s, siteStatus(s.code)]).filter(([, x]) => x.level !== "good");
      k.append(
        kpi("Oil production", fmt(oil), "bbl/d", t ? [delta(oil, avg(t.oil)), " vs 30-day average"] : "", t && sparkline(t.oil, "var(--series-1)")),
        kpi("Refinery throughput", fmt(thru), "bbl/d", `${fmt((100 * thru) / cap)}% of ${fmt(cap)} bbl/d capacity`, t && sparkline(t.thru, "var(--series-2)")),
        kpi("Wells producing", `${prod}`, `of ${wells.length}`, [tripped ? pill("critical", `${tripped} tripped`) : null, planned ? pill("planned", `${planned} planned`) : null, !tripped && !planned ? pill("good", "All running") : null]),
        kpi("Water cut", fmt((100 * water) / (oil + water), 1), "%", "Share of water in produced liquid"),
        kpi("Sites needing attention", `${st.length}`, `of ${M.sites.length}`, st.length ? st.map(([s]) => s.name).join(", ") : "All sites normal"),
      );
    } else {
      const s = D[state.view], m = SITES[state.view];
      const wells = Object.values(s.wells);
      const prod = wells.filter(w => w.status === "Producing").length;
      const tripped = wells.filter(w => w.status === "Tripped").length;
      const planned = wells.filter(w => w.status === "Shut-In" || w.status === "Workover").length;
      const up = avg(wells.map(w => w.uptime7d));
      const days = s.thru > 0 ? s.crudeInv / s.thru : null;
      k.append(
        kpi("Oil production", fmt(s.oil), "bbl/d", s.trend ? [delta(s.oil, avg(s.trend.oil)), " vs 30-day average"] : "", s.trend && sparkline(s.trend.oil, "var(--series-1)")),
        kpi("Refinery throughput", fmt(s.thru), "bbl/d", `${fmt((100 * s.thru) / m.capacity)}% of ${fmt(m.capacity)} bbl/d capacity`, s.trend && sparkline(s.trend.thru, "var(--series-2)")),
        kpi("Wells producing", `${prod}`, `of ${wells.length}`, [tripped ? pill("critical", `${tripped} tripped`) : null, planned ? pill("planned", `${planned} planned`) : null, !tripped && !planned ? pill("good", "All running") : null]),
        kpi("Well uptime, 7 days", up == null ? "…" : fmt(up, 1), up == null ? "" : "%", "Time wells spent producing"),
        kpi("Crude stock", days == null ? "—" : fmt(days, 1), days == null ? "" : "days", `${fmt(s.crudeInv)} bbl in crude tanks`),
      );
    }
  }

  // ---------------------------------------------------------------- side panel
  function renderSide() {
    const side = $("side"); side.replaceChildren();
    const D = state.data.sites;
    if (!state.view) {
      side.append(el("header", {}, el("h2", {}, "Sites"), el("span", { class: "hint" }, "Ranked by oil production")));
      side.append(el("div", { class: "list-head" }, el("span", {}, "Site"), el("span", {}, "Oil production, bbl/d"), el("span", { class: "cell-r" }, "Refinery"), el("span", { class: "cell-r" }, "Wells")));
      const max = Math.max(...Object.values(D).map(s => s.oil));
      const list = el("div", { class: "sites" });
      [...M.sites].sort((a, b) => D[b.code].oil - D[a.code].oil).forEach(m => {
        const s = D[m.code], st = siteStatus(m.code);
        const prod = Object.values(s.wells).filter(w => w.status === "Producing").length;
        list.append(el("button", { class: "site-row", type: "button", onclick: () => go(m.code), onmouseenter: () => highlightSite(m.code), onmouseleave: () => highlightSite(null) },
          el("div", {}, el("div", { class: "nm" }, m.name), el("div", { class: "sub" }, `${m.country} · ${m.basin}`),
            el("div", { class: "why" }, pill(st.level), " ", st.reasons[0] || "")),
          el("div", {}, el("div", { class: "bar" }, el("i", { style: `width:${(100 * s.oil) / max}%` })), el("div", { class: "barval num" }, fmt(s.oil))),
          el("div", { class: "cell-r" }, `${fmt((100 * s.thru) / m.capacity)}%`, el("small", {}, "utilization")),
          el("div", { class: "cell-r" }, `${prod}/${Object.keys(s.wells).length}`, el("small", {}, "producing"))));
      });
      side.append(list);
      return;
    }
    const m = SITES[state.view], s = D[state.view], st = siteStatus(state.view);
    side.append(el("header", {}, el("h2", {}, `${m.name} refinery`), pill(st.level)));
    side.append(el("div", { class: "section-label" }, `${m.field} · ${m.basin}`));
    const units = el("div", { class: "units" });
    for (const u of m.units) {
      const v = s.units[u.key] || {};
      const l = UNIT_LEVEL[v.status] || "good";
      units.append(el("div", { class: "unit" }, el("div", { class: "u-name", title: u.label }, u.label),
        el("div", { class: "u-val" }, fmt(v.metric, u.metricUom === "bbl/d" ? 0 : 1), el("small", {}, `${u.metricUom} · ${u.metricAttr.toLowerCase()}`)),
        el("div", {}, pill(l, UNIT_TEXT[v.status] || "—")),
        v.scenario && v.scenario !== "Normal" ? el("div", { class: "u-note" }, `Event: ${v.scenario}`) : null));
    }
    side.append(el("div", { class: "section-label" }, "Refinery units"), units);
    side.append(el("div", { class: "section-label" }, "Wells"));
    const rows = m.wells.map(w => [w, s.wells[w.id]]).sort((a, b) => (b[1].oil || 0) - (a[1].oil || 0));
    const tb = el("tbody");
    for (const [w, v] of rows) {
      const l = WELL_LEVEL[v.status] || "planned";
      tb.append(el("tr", { "data-well": w.id, class: state.hoverWell === w.id ? "hl" : null, onmouseenter: () => highlightWell(w.id), onmouseleave: () => highlightWell(null) },
        el("td", {}, el("b", {}, w.name), el("div", { style: "font-size:.72rem;color:var(--muted)" }, `${w.id} · ${w.lift}`)),
        el("td", {}, pill(l, v.status), v.scenario && v.scenario !== "Normal" ? el("div", { style: "font-size:.72rem;color:var(--ink-2);margin-top:2px" }, v.scenario) : null),
        el("td", { class: "r" }, fmt(v.oil)), el("td", { class: "r" }, v.wc == null ? "—" : fmt(v.wc, 1)),
        el("td", { class: "r" }, v.uptime7d == null ? "…" : fmt(v.uptime7d, 1)),
        el("td", {}, sparkline(v.spark, "var(--series-1)", 72, 22))));
    }
    side.append(el("div", { class: "tablewrap" }, el("table", {},
      el("thead", {}, el("tr", {}, el("th", {}, "Well"), el("th", {}, "Status"), el("th", { class: "r" }, "Oil bbl/d"), el("th", { class: "r" }, "W/C %"),
        el("th", { class: "r" }, "Uptime 7d %"), el("th", {}, "Oil, 7 days"))), tb)));
  }

  // ---------------------------------------------------------------- map
  const map = { svg: null, vb: null, anim: null, layers: {} };
  const CONTINENT = (() => { const [x0, y0] = proj(-82, 13), [x1, y1] = proj(-34, -56); return [x0, y0, x1 - x0, y1 - y0]; })();

  function initMap() {
    const svg = map.svg = $("map");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.append(sv("rect", { x: -200, y: -200, width: 400, height: 400, fill: "var(--sea)" }));
    const land = sv("g", {});
    for (const s of MAP.shapes) land.append(sv("path", { d: s.d, class: "land" + (s.sa ? " sa" : "") }));
    svg.append(land);
    for (const k of ["flows", "markers", "labels"]) { map.layers[k] = sv("g", {}); svg.append(map.layers[k]); }
    map.vb = CONTINENT.slice();
    setViewBox(map.vb);
    new ResizeObserver(() => drawMarkers()).observe(svg);
    svg.addEventListener("pointerleave", () => { $("map-tip").hidden = true; });
  }

  function setViewBox(vb) { map.vb = vb; map.svg.setAttribute("viewBox", vb.map(v => v.toFixed(4)).join(" ")); }
  function unitsPerPx() {
    const W = map.svg.clientWidth || 600, H = map.svg.clientHeight || 600;
    return Math.max(map.vb[2] / W, map.vb[3] / H);
  }

  function siteBox(code) {
    const m = SITES[code];
    const pts = [proj(m.lon, m.lat), ...m.wells.map(w => proj(w.lon, w.lat))];
    let [x0, y0] = pts[0], x1 = x0, y1 = y0;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const pad = Math.max(x1 - x0, y1 - y0) * 0.22 + 0.06;
    x0 -= pad; y0 -= pad; x1 += pad * 1.6; y1 += pad;   // extra room on the right for labels
    return [x0, y0, x1 - x0, y1 - y0];
  }

  function animateTo(target) {
    cancelAnimationFrame(map.anim);
    const from = map.vb.slice(), t0 = performance.now();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dur = reduce ? 0 : 900;
    // interpolate in log-space of size so zooming feels even
    const step = now => {
      const p = dur ? Math.min(1, (now - t0) / dur) : 1;
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      const w = Math.exp(Math.log(from[2]) + (Math.log(target[2]) - Math.log(from[2])) * e);
      const h = Math.exp(Math.log(from[3]) + (Math.log(target[3]) - Math.log(from[3])) * e);
      const cx = from[0] + from[2] / 2 + (target[0] + target[2] / 2 - from[0] - from[2] / 2) * e;
      const cy = from[1] + from[3] / 2 + (target[1] + target[3] / 2 - from[1] - from[3] / 2) * e;
      setViewBox([cx - w / 2, cy - h / 2, w, h]);
      drawMarkers();
      if (p < 1) map.anim = requestAnimationFrame(step);
    };
    map.anim = requestAnimationFrame(step);
  }

  function buildMarkers() {
    const { flows, markers, labels } = map.layers;
    flows.replaceChildren(); markers.replaceChildren(); labels.replaceChildren();
    const D = state.data.sites;
    if (!state.view) {
      for (const m of M.sites) {
        const [x, y] = proj(m.lon, m.lat), st = siteStatus(m.code);
        const g = sv("g", { class: "site", tabindex: 0, role: "button", "aria-label": `${m.name}, ${LEVEL[st.level].label}`, "data-site": m.code });
        g.append(sv("circle", { class: "halo", cx: x, cy: y }), sv("circle", { class: "dot", cx: x, cy: y, fill: LEVEL[st.level].color, stroke: "var(--ring)" }));
        g.addEventListener("click", () => go(m.code));
        g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(m.code); } });
        g.addEventListener("pointermove", e => siteTip(e, m.code));
        g.addEventListener("pointerleave", () => { $("map-tip").hidden = true; });
        markers.append(g);
        labels.append(sv("text", { class: "lbl", "data-for": m.code, x, y }, m.name), sv("text", { class: "lbl2", "data-for2": m.code, x, y }, `${fmt(D[m.code].oil)} bbl/d`));
      }
    } else {
      const m = SITES[state.view], s = D[state.view];
      const [rx, ry] = proj(m.lon, m.lat);
      for (const w of m.wells) {
        const [x, y] = proj(w.lon, w.lat);
        flows.append(sv("line", { class: "flow", x1: x, y1: y, x2: rx, y2: ry }));
      }
      for (const w of m.wells) {
        const [x, y] = proj(w.lon, w.lat), v = s.wells[w.id], l = WELL_LEVEL[v.status] || "planned";
        const g = sv("g", { class: "site", "data-well": w.id, tabindex: 0, "aria-label": `${w.name}, ${v.status}` });
        g.append(sv("circle", { class: "halo", cx: x, cy: y }), sv("circle", { class: "dot", cx: x, cy: y, fill: LEVEL[l].color, stroke: "var(--ring)" }));
        g.addEventListener("pointermove", e => wellTip(e, w.id));
        g.addEventListener("pointerenter", () => highlightWell(w.id));
        g.addEventListener("pointerleave", () => { $("map-tip").hidden = true; highlightWell(null); });
        markers.append(g);
        labels.append(sv("text", { class: "lbl2", "data-for": w.id, x, y }, w.name));
      }
      markers.append(sv("rect", { class: "refinery", "data-ref": 1, x: rx, y: ry }));
      labels.append(sv("text", { class: "lbl", "data-for": "REF", x: rx, y: ry }, `${m.name} refinery`),
        sv("text", { class: "lbl2", "data-for2": "REF", x: rx, y: ry }, `${fmt(s.thru)} bbl/d`));
    }
    renderMapLegend();
    drawMarkers();
  }

  // keep marker and label sizes constant in screen pixels while the viewBox changes
  function drawMarkers() {
    if (!map.svg) return;
    const k = unitsPerPx(), D = state.data.sites;
    const zoomedOut = !state.view;
    if (zoomedOut) {
      const max = Math.max(...Object.values(D).map(s => s.oil));
      for (const g of map.layers.markers.querySelectorAll("[data-site]")) {
        const s = D[g.dataset.site], r = (6 + 12 * Math.sqrt(s.oil / max)) * k;
        g.querySelector(".dot").setAttribute("r", r);
        g.querySelector(".dot").setAttribute("stroke-width", 2 * k);
        g.querySelector(".halo").setAttribute("r", Math.max(r, 14 * k));
        const x = +g.querySelector(".dot").getAttribute("cx"), y = +g.querySelector(".dot").getAttribute("cy");
        const t1 = map.layers.labels.querySelector(`[data-for="${g.dataset.site}"]`), t2 = map.layers.labels.querySelector(`[data-for2="${g.dataset.site}"]`);
        for (const [t, dy, fs] of [[t1, -2, 13], [t2, 12, 11.5]]) {
          t.setAttribute("x", x + r + 5 * k); t.setAttribute("y", y + dy * k);
          t.setAttribute("font-size", fs * k); t.setAttribute("stroke-width", 3 * k);
        }
      }
    } else {
      const s = D[state.view], max = Math.max(1, ...Object.values(s.wells).map(w => w.oil || 0));
      for (const g of map.layers.markers.querySelectorAll("[data-well]")) {
        const v = s.wells[g.dataset.well];
        const r = (5 + 9 * Math.sqrt((v.oil || 0) / max)) * (state.hoverWell === g.dataset.well ? 1.35 : 1) * k;
        const dot = g.querySelector(".dot");
        dot.setAttribute("r", r); dot.setAttribute("stroke-width", 2 * k);
        g.querySelector(".halo").setAttribute("r", Math.max(r, 12 * k));
        const t = map.layers.labels.querySelector(`[data-for="${g.dataset.well}"]`);
        t.setAttribute("x", +dot.getAttribute("cx") + r + 4 * k); t.setAttribute("y", +dot.getAttribute("cy") + 4 * k);
        t.setAttribute("font-size", 11.5 * k); t.setAttribute("stroke-width", 3 * k);
      }
      const ref = map.layers.markers.querySelector("[data-ref]");
      if (ref) {
        const m = SITES[state.view], [rx, ry] = proj(m.lon, m.lat), sz = 14 * k;
        ref.setAttribute("x", rx - sz / 2); ref.setAttribute("y", ry - sz / 2); ref.setAttribute("width", sz); ref.setAttribute("height", sz);
        ref.setAttribute("rx", 3 * k); ref.setAttribute("stroke-width", 2 * k);
        const t1 = map.layers.labels.querySelector('[data-for="REF"]'), t2 = map.layers.labels.querySelector('[data-for2="REF"]');
        for (const [t, dy, fs] of [[t1, -2, 13], [t2, 12, 11.5]]) {
          t.setAttribute("x", rx + sz / 2 + 6 * k); t.setAttribute("y", ry + dy * k); t.setAttribute("font-size", fs * k); t.setAttribute("stroke-width", 3 * k);
        }
      }
      drawScale(k);
    }
    $("scalebar").hidden = zoomedOut;
  }

  function drawScale(k) {
    const m = SITES[state.view];
    const kmPerUnit = 111.32 * Math.cos((m.lat * Math.PI) / 180);
    const pxPerKm = 1 / (k * kmPerUnit);
    const km = [1, 2, 5, 10, 20, 50, 100].find(x => x * pxPerKm >= 60) || 100;
    const sb = $("scalebar");
    sb.firstElementChild.style.width = `${km * pxPerKm}px`;
    sb.lastElementChild.textContent = `${km} km`;
  }

  function renderMapLegend() {
    const L = $("map-legend"); L.replaceChildren();
    const row = (level, text) => el("div", { class: "row" }, icon(level), text);
    if (!state.view) {
      L.append(row("good", "Normal"), row("warning", "Watch: unit event or well tripped"), row("critical", "Alert: unit upset or ≥30% wells tripped"),
        el("div", { class: "row", style: "color:var(--muted)" }, "Circle size = oil production"));
    } else {
      L.append(row("good", "Producing"), row("warning", "Starting up"), row("critical", "Tripped"), row("planned", "Shut-in or workover"),
        el("div", { class: "row" }, sv("svg", { viewBox: "0 0 12 12", class: "ic", width: 12, height: 12 }, sv("rect", { x: 1, y: 1, width: 10, height: 10, rx: 2, fill: "var(--ink)" })), "Refinery"),
        el("div", { class: "row", style: "color:var(--muted)" }, "Circle size = oil rate"));
    }
  }

  function placeTip(e, content) {
    const tip = $("map-tip"), wrap = $("mapwrap").getBoundingClientRect();
    tip.replaceChildren(...content); tip.hidden = false;
    let x = e.clientX - wrap.left + 14, y = e.clientY - wrap.top + 14;
    if (x + tip.offsetWidth > wrap.width - 8) x = e.clientX - wrap.left - tip.offsetWidth - 14;
    if (y + tip.offsetHeight > wrap.height - 8) y = e.clientY - wrap.top - tip.offsetHeight - 14;
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  }
  const kv = pairs => el("div", { class: "kv" }, pairs.flatMap(([a, b]) => [el("span", {}, a), el("span", {}, b)]));
  function siteTip(e, code) {
    const m = SITES[code], s = state.data.sites[code], st = siteStatus(code);
    const prod = Object.values(s.wells).filter(w => w.status === "Producing").length;
    placeTip(e, [el("b", {}, `${m.name}, ${m.country}`), el("div", { style: "margin:3px 0" }, pill(st.level)),
      kv([["Oil production", `${fmt(s.oil)} bbl/d`], ["Refinery", `${fmt(s.thru)} bbl/d`], ["Utilization", `${fmt((100 * s.thru) / m.capacity)}%`], ["Wells producing", `${prod} of ${Object.keys(s.wells).length}`]]),
      st.reasons.length ? el("div", { style: "margin-top:4px;color:var(--ink-2)" }, st.reasons.slice(0, 2).join(" · ")) : null,
      el("div", { style: "margin-top:4px;color:var(--muted)" }, "Click to open")].filter(Boolean));
  }
  function wellTip(e, id) {
    const m = SITES[state.view], w = m.wells.find(x => x.id === id), v = state.data.sites[state.view].wells[id];
    placeTip(e, [el("b", {}, w.name), el("div", { style: "margin:3px 0" }, pill(WELL_LEVEL[v.status] || "planned", v.status)),
      kv([["Oil rate", `${fmt(v.oil)} bbl/d`], ["Water cut", v.wc == null ? "—" : `${fmt(v.wc, 1)}%`], ["Today", `${fmt(v.dayOil)} bbl`], ["Lift", w.lift], ["Asset ID", w.id]]),
      v.scenario && v.scenario !== "Normal" ? el("div", { style: "margin-top:4px;color:var(--ink-2)" }, `Event: ${v.scenario}`) : null].filter(Boolean));
  }

  function highlightWell(id) {
    state.hoverWell = id;
    for (const tr of document.querySelectorAll("tr[data-well]")) tr.classList.toggle("hl", tr.dataset.well === id);
    drawMarkers();
  }
  function highlightSite(code) {
    for (const g of map.layers.markers.querySelectorAll("[data-site]")) g.style.opacity = code && g.dataset.site !== code ? 0.35 : 1;
  }

  // ---------------------------------------------------------------- trend chart
  let showTable = false;
  function renderTrend() {
    const box = $("trend"); box.replaceChildren();
    const t = state.view ? state.data.sites[state.view].trend : companyTrend();
    const cap = state.view ? SITES[state.view].capacity : sum(M.sites.map(s => s.capacity));
    $("trend-title").textContent = state.view ? `${SITES[state.view].name}: production and refining, last 30 days` : "Company production and refining, last 30 days";
    const lg = $("trend-legend"); lg.replaceChildren(
      el("span", {}, el("i", { style: "background:var(--series-1)" }), "Oil production (daily average)"),
      el("span", {}, el("i", { style: "background:var(--series-2)" }), "Refinery throughput (daily average)"),
      el("span", {}, el("i", { class: "dash" }), "Refinery capacity"));
    if (!t || !t.days.length) { box.append(el("div", { class: "empty" }, "No history yet. Backfill the data and the rollup analyses (README step 4).")); return; }
    const W = Math.max(320, box.clientWidth - 32 || 640), H = 260, P = { l: 52, r: 96, t: 14, b: 26 };
    const vals = [...t.oil, ...t.thru, cap].filter(v => v != null);
    const step = niceStep(Math.max(...vals) / 4);
    const ymax = Math.ceil((Math.max(...vals) * 1.04) / step) * step;
    const X = i => P.l + (i / Math.max(1, t.days.length - 1)) * (W - P.l - P.r);
    const Y = v => H - P.b - (v / ymax) * (H - P.t - P.b);
    const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Daily oil production and refinery throughput, last 30 days" });
    const grid = sv("g", { class: "grid" }), axis = sv("g", { class: "axis" });
    for (let v = 0; v <= ymax + 1e-9; v += step) {
      grid.append(sv("line", { x1: P.l, x2: W - P.r, y1: Y(v), y2: Y(v) }));
      axis.append(sv("text", { x: P.l - 8, y: Y(v) + 4, "text-anchor": "end" }, v >= 1000 ? `${fmt(v / 1000, 1)}k` : fmt(v)));
    }
    t.days.forEach((d, i) => {
      const lastI = t.days.length - 1;
      const every = W < 560 ? 14 : 7;
      if ((i % every === 0 && lastI - i >= every / 2) || i === lastI) {
        const dt = new Date(d + "T00:00:00Z");
        axis.append(sv("text", { x: X(i), y: H - 6, "text-anchor": i === 0 ? "start" : i === t.days.length - 1 ? "end" : "middle" },
          dt.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })));
      }
    });
    svg.append(grid, axis, sv("line", { class: "cap", x1: P.l, x2: W - P.r, y1: Y(cap), y2: Y(cap) }),
      sv("text", { x: W - P.r + 6, y: Y(cap) + 4, fill: "var(--muted)", "font-size": 11 }, "Capacity"));
    const line = (arr, color, label) => {
      let d = ""; arr.forEach((v, i) => { if (v != null) d += (d ? "L" : "M") + X(i).toFixed(1) + "," + Y(v).toFixed(1); });
      svg.append(sv("path", { d, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      const li = arr.length - 1;
      return { y: Y(arr[li]), label, color, x: X(li) };
    };
    const ends = [line(t.thru, "var(--series-2)", "Throughput"), line(t.oil, "var(--series-1)", "Oil")];
    if (Math.abs(ends[0].y - ends[1].y) < 14) { const mid = (ends[0].y + ends[1].y) / 2; const up = ends[0].y < ends[1].y ? 0 : 1; ends[up].y = mid - 7; ends[1 - up].y = mid + 7; }
    for (const e of ends) svg.append(sv("circle", { cx: e.x, cy: Y(e.label === "Oil" ? t.oil.at(-1) : t.thru.at(-1)), r: 3.5, fill: e.color, stroke: "var(--surface)", "stroke-width": 2 }),
      sv("text", { x: e.x + 8, y: e.y + 4, fill: "var(--ink-2)", "font-size": 11.5, "font-weight": 600 }, e.label));
    const cross = sv("line", { class: "cross", y1: P.t, y2: H - P.b, visibility: "hidden" });
    const hit = sv("rect", { x: P.l, y: P.t, width: W - P.l - P.r, height: H - P.t - P.b, fill: "transparent" });
    svg.append(cross, hit);
    const tip = el("div", { class: "tip", hidden: true });
    hit.addEventListener("pointermove", e => {
      const r = svg.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(t.days.length - 1, Math.round(((px - P.l) / (W - P.l - P.r)) * (t.days.length - 1))));
      cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.setAttribute("visibility", "visible");
      const dt = new Date(t.days[i] + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
      const row = (c, n, v) => el("div", { class: "row" }, el("b", {}, `${fmt(v)} bbl/d`), el("span", { class: "key" }, el("i", { style: `background:${c}` }), n));
      tip.replaceChildren(el("div", { style: "color:var(--muted);margin-bottom:3px" }, dt), row("var(--series-1)", "Oil production", t.oil[i]), row("var(--series-2)", "Refinery throughput", t.thru[i]));
      tip.hidden = false;
      const left = (X(i) / W) * r.width + 16;
      tip.style.left = `${left + tip.offsetWidth > r.width ? left - tip.offsetWidth - 28 : left}px`; tip.style.top = "8px";
    });
    hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); tip.hidden = true; });
    box.append(svg, tip);
    const tbl = $("trend-table"); tbl.replaceChildren(); tbl.hidden = !showTable;
    if (showTable) {
      tbl.append(el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "Day"), el("th", { class: "r" }, "Oil production bbl/d"), el("th", { class: "r" }, "Refinery throughput bbl/d"))),
        el("tbody", {}, t.days.map((d, i) => el("tr", {}, el("td", {}, d), el("td", { class: "r" }, fmt(t.oil[i])), el("td", { class: "r" }, fmt(t.thru[i])))).reverse())));
    }
  }
  function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw))); const f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }

  // ---------------------------------------------------------------- events
  function renderEvents() {
    const box = $("events"); box.replaceChildren();
    const codes = state.view ? [state.view] : M.sites.map(s => s.code);
    const evs = codes.flatMap(c => (state.data.sites[c].events || []).map(e => ({ ...e, site: SITES[c].name })))
      .sort((a, b) => b.end.localeCompare(a.end)).slice(0, state.view ? 12 : 14);
    if (!evs.length) { box.append(el("div", { class: "empty" }, state.data.sites[codes[0]].events ? "No completed extraction runs in the last 7 days." : "Loading…")); return; }
    const dur = (a, b) => { const h = (new Date(b) - new Date(a)) / 3.6e6; return h >= 48 ? `${fmt(h / 24, 1)} d` : `${fmt(h, 1)} h`; };
    box.append(el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "Stopped"), el("th", {}, "Well"), el("th", { class: "r" }, "Run length"), el("th", { class: "r" }, "Oil in run, bbl"), el("th", {}, "Reason"))),
      el("tbody", {}, evs.map(e => el("tr", {},
        el("td", { class: "num" }, new Date(e.end).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })),
        el("td", {}, el("b", {}, e.well), state.view ? null : el("div", { style: "font-size:.72rem;color:var(--muted)" }, e.site)),
        el("td", { class: "r" }, dur(e.start, e.end)), el("td", { class: "r" }, fmt(e.oil)),
        el("td", { class: "reason" }, !e.reason || e.reason === "Normal" ? "Operator stop" : e.reason))))));
  }

  // ---------------------------------------------------------------- navigation
  function go(code) {
    state.view = code && SITES[code] ? code : null;
    try { history.replaceState(null, "", state.view ? `#${state.view}` : location.pathname + location.search); } catch (_) { /* sandboxed */ }
    setTitles();
    $("map-tip").hidden = true; state.hoverWell = null;
    render();
    animateTo(state.view ? siteBox(state.view) : CONTINENT);
    if (state.view) loadDetail(state.view);
  }

  function setTitles() {
    $("map-title").textContent = state.view ? `${SITES[state.view].name} wellfield` : "Sites";
    $("map-hint").textContent = state.view ? "Dashed lines: flow from each well to the refinery" : "Select a site to see its wells";
  }

  function render() {
    renderHeader(); renderKpis(); renderSide(); buildMarkers(); renderTrend(); renderEvents();
  }

  async function refresh() {
    const app = document.querySelector(".app"); app.classList.add("loading");
    try {
      const keep = state.data;
      const snap = await state.source.snapshot();
      for (const [c, s] of Object.entries(snap.sites)) {   // keep slower-changing pieces
        const old = keep.sites[c];
        s.trend = s.trend || old.trend; s.events = s.events || old.events;
        for (const [id, w] of Object.entries(s.wells)) { const o = old.wells[id] || {}; w.spark ??= o.spark; w.uptime7d ??= o.uptime7d; }
      }
      state.data = snap;
      render(); drawMarkers();
    } catch (e) { showBanner(`Refresh failed: ${e.message}`); }
    app.classList.remove("loading");
  }

  async function main() {
    try { await load(); } catch (e) { showBanner(`Could not load data: ${e.message}`); return; }
    initMap();
    $("refresh").addEventListener("click", refresh);
    $("trend-table-btn").addEventListener("click", () => { showTable = !showTable; $("trend-table-btn").textContent = showTable ? "Hide table" : "Show table"; renderTrend(); });
    window.addEventListener("resize", () => renderTrend());
    window.addEventListener("hashchange", () => go(location.hash.slice(1)));
    const start = location.hash.slice(1);
    state.view = SITES[start] ? start : null;
    setTitles();
    render();
    setViewBox(state.view ? siteBox(state.view) : CONTINENT); drawMarkers();
    if (state.view) loadDetail(state.view);
    if (state.data.live) {
      await loadExtras(); render();
      setInterval(refresh, (CFG.refreshSeconds || 60) * 1000);
      setInterval(async () => { await loadExtras(); render(); }, 5 * 60 * 1000);
    }
  }
  main();
})();
