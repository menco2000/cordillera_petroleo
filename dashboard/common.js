// Shared by every map design: data loading, status rules and tooltip content.
// Each design only decides how things look.
(function () {
  "use strict";
  const M = window.CP_MODEL, CFG = window.CP_CONFIG || { source: "demo" };
  const SITES = Object.fromEntries(M.sites.map(s => [s.code, s]));
  const SVGNS = "http://www.w3.org/2000/svg";
  const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const state = { source: null, data: null, view: null };

  // ---------------------------------------------------------------- helpers
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
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
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (v, d = 0) => v == null || Number.isNaN(+v) ? "—" : (d ? nf1 : nf0).format(v);
  const merc = lat => (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (Math.max(-85, Math.min(85, lat)) * Math.PI) / 360));

  // ---------------------------------------------------------------- status
  const LEVEL = {
    good: { color: "var(--good)", label: "Normal" },
    warning: { color: "var(--warning)", label: "Watch" },
    critical: { color: "var(--critical)", label: "Alert" },
    planned: { color: "var(--planned)", label: "Planned" },
  };
  const WELL_LEVEL = { "Producing": "good", "Starting Up": "warning", "Tripped": "critical", "Shut-In": "planned", "Workover": "planned" };
  const UNIT_LEVEL = { "Normal Operation": "good", "Reduced Rate": "warning", "Startup": "warning", "Upset": "critical", "Shutdown": "critical" };
  const UNIT_TEXT = { "Normal Operation": "Normal", "Reduced Rate": "Reduced rate", "Startup": "Starting up", "Upset": "Upset", "Shutdown": "Shutdown" };
  // events that need attention now; slow ones (heater fouling) are shown but don't change the status
  const ACUTE = new Set(["Vacuum Loss", "Compressor Trip", "Cooling Tower Degraded", "Power Outage"]);

  function icon(level) {
    const c = LEVEL[level].color;
    const g = sv("svg", { viewBox: "0 0 12 12", class: "ic", "aria-hidden": "true" });
    if (level === "good") g.append(sv("circle", { cx: 6, cy: 6, r: 6, fill: c }), sv("path", { d: "M3.2 6.2 5.2 8.1 8.9 4.1", stroke: "#fff", "stroke-width": 1.6, fill: "none", "stroke-linecap": "round" }));
    else if (level === "warning") g.append(sv("path", { d: "M6 .6 11.6 11 H.4 Z", fill: c }), sv("rect", { x: 5.3, y: 4, width: 1.4, height: 3.8, rx: .6, fill: "#3a2a00" }), sv("circle", { cx: 6, cy: 9.3, r: .8, fill: "#3a2a00" }));
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

  function siteFigures(code) {
    const m = SITES[code], s = state.data.sites[code];
    const wells = Object.values(s.wells);
    return {
      oil: s.oil || 0, water: s.water || 0, thru: s.thru || 0, capacity: m.capacity,
      util: m.capacity ? (100 * (s.thru || 0)) / m.capacity : null,
      producing: wells.filter(w => w.status === "Producing").length, wells: wells.length,
      wc: (s.oil + s.water) > 1 ? (100 * s.water) / (s.oil + s.water) : null,
      crudeDays: s.thru > 0 && s.crudeInv != null ? s.crudeInv / s.thru : null,
    };
  }

  function totals() {
    const f = M.sites.map(m => siteFigures(m.code));
    const sum = k => f.reduce((a, x) => a + (x[k] || 0), 0);
    const oil = sum("oil"), water = sum("water"), thru = sum("thru"), capacity = sum("capacity");
    const levels = { good: 0, warning: 0, critical: 0 };
    M.sites.forEach(m => levels[siteStatus(m.code).level]++);
    return { oil, water, thru, capacity, util: (100 * thru) / capacity, producing: sum("producing"), wells: sum("wells"),
      wc: (100 * water) / (oil + water), levels };
  }

  // ---------------------------------------------------------------- data
  async function load(note) {
    const want = CFG.source || "auto";
    const { demoSource, piSource } = window.CP_SOURCES;
    if (want !== "demo") {
      try {
        const src = piSource(CFG.piwebapi);
        state.data = await src.snapshot();
        state.source = src;
        return;
      } catch (e) {
        if (want === "piwebapi") throw e;
        note && note(`PI Web API not reachable (${e.message}). Showing simulated demo data.`);
      }
    }
    state.source = demoSource();
    state.data = await state.source.snapshot();
  }

  function autoRefresh(onData, onError) {
    if (!state.data.live) return;
    setInterval(async () => {
      try { state.data = await state.source.snapshot(); onData(); } catch (e) { onError && onError(e); }
    }, (CFG.refreshSeconds || 60) * 1000);
  }

  // ---------------------------------------------------------------- tooltip content
  const kv = pairs => el("div", { class: "kv" }, pairs.flatMap(([a, b]) => [el("span", {}, a), el("span", {}, b)]));

  function siteTip(code, hint = "Click to see the wells") {
    const m = SITES[code], f = siteFigures(code), st = siteStatus(code);
    return [el("h3", {}, `${m.name}, ${m.country}`), pill(st.level),
      kv([["Oil production", `${fmt(f.oil)} bbl/d`], ["Refinery throughput", `${fmt(f.thru)} bbl/d`],
        ["Utilization", `${fmt(f.util)}% of ${fmt(f.capacity)}`], ["Wells producing", `${f.producing} of ${f.wells}`],
        ["Water cut", f.wc == null ? "—" : `${fmt(f.wc, 1)}%`]]),
      st.reasons.length ? el("div", { class: "why" }, st.reasons.slice(0, 3).join(" · ")) : null,
      hint ? el("div", { class: "hint" }, hint) : null].filter(Boolean);
  }

  function wellTip(code, id) {
    const w = SITES[code].wells.find(x => x.id === id), v = state.data.sites[code].wells[id];
    return [el("h3", {}, w.name), pill(WELL_LEVEL[v.status] || "planned", v.status),
      kv([["Oil rate", `${fmt(v.oil)} bbl/d`], ["Water cut", v.wc == null ? "—" : `${fmt(v.wc, 1)}%`],
        ["Oil today", `${fmt(v.dayOil)} bbl`], ["Design rate", `${fmt(w.design)} bbl/d`], ["Lift", w.lift], ["Asset ID", w.id]]),
      v.scenario && v.scenario !== "Normal" ? el("div", { class: "why" }, `Event: ${v.scenario}`) : null].filter(Boolean);
  }

  function refineryTip(code) {
    const m = SITES[code], s = state.data.sites[code], f = siteFigures(code), st = siteStatus(code);
    const ev = [...new Set(m.units.map(u => s.units[u.key]?.scenario).filter(x => x && x !== "Normal"))];
    return [el("h3", {}, `${m.name} refinery`), pill(st.level),
      kv([["Throughput", `${fmt(f.thru)} bbl/d`], ["Utilization", `${fmt(f.util)}%`],
        ["Crude stock", f.crudeDays == null ? "—" : `${fmt(f.crudeDays, 1)} days`]]),
      el("div", { class: "units" }, m.units.map(u => {
        const v = s.units[u.key] || {};
        return el("div", {}, el("span", {}, pill(UNIT_LEVEL[v.status] || "good", u.label)),
          el("span", { class: "m" }, `${fmt(v.metric, u.metricUom === "bbl/d" ? 0 : 1)} ${u.metricUom}`));
      })),
      ev.length ? el("div", { class: "why" }, `Events: ${ev.join(", ")}`) : null].filter(Boolean);
  }

  function showTip(tip, e, content) {
    tip.replaceChildren(...content);
    tip.hidden = false;
    const pad = 18, W = window.innerWidth, H = window.innerHeight;
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + tip.offsetWidth > W - 8) x = e.clientX - tip.offsetWidth - pad;
    if (y + tip.offsetHeight > H - 8) y = Math.max(8, e.clientY - tip.offsetHeight - pad);
    tip.style.left = `${Math.max(8, x)}px`; tip.style.top = `${y}px`;
  }

  function asOfText() {
    const d = new Date(state.data.asOf);
    return `${state.data.live ? "Live" : "Demo data"} · ${d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`;
  }

  // the views a user can switch between (top of every page)
  const DESIGNS = [["index.html", "Satellite"], ["holo.html", "Holo 3D"], ["hex.html", "Hex grid"], ["night.html", "Night ops"]];
  function designSwitcher(container, current) {
    container.replaceChildren(...DESIGNS.map(([href, label]) =>
      el("a", { href: href + location.hash, class: href === current ? "on" : null, "aria-current": href === current ? "page" : null }, label)));
  }

  window.CP_UI = {
    M, SITES, CFG, state, el, sv, esc, fmt, merc, LEVEL, WELL_LEVEL, UNIT_LEVEL, UNIT_TEXT, icon, pill,
    siteStatus, siteFigures, totals, load, autoRefresh, kv, siteTip, wellTip, refineryTip, showTip, asOfText, designSwitcher,
  };
})();
