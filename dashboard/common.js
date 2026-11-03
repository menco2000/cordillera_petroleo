// Shared by the map (topo.html) and the plant view: data loading, status rules and tooltip content.
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
  // why the browser could not read PI Web API, in words someone can act on (shown on the pages)
  function explainPI(e) {
    const url = (CFG.piwebapi || {}).url, m = String(e && e.message || e);
    if (e && e.name === "AbortError") return `PI Web API at ${url} did not answer in time.`;
    if (/HTTP 401/.test(m)) return `PI Web API refused the login (401): the browser must send your Windows login. Add ${url.replace(/\/piwebapi.*$/, "")} to the Local intranet sites (Internet Options > Security) or allow it in your browser policy.`;
    if (/HTTP 403/.test(m)) return `PI Web API answered 403: your Windows user has no read access to the AF database, or PI Web API blocks this request.`;
    if (/HTTP (404|400)/.test(m)) return `PI Web API answered ${m.match(/HTTP \d+/)[0]}: check piwebapi.url, afServer and the AF database name in config.js (${m}).`;
    if (e instanceof TypeError) return `The browser could not reach PI Web API at ${url}. Usually: its HTTPS certificate is not trusted (open the url once in this browser), or PI Web API does not allow this page's address (CORS, see the README).`;
    return `PI Web API error: ${m}`;
  }

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
        state.piError = explainPI(e);
        if (want === "piwebapi") throw new Error(state.piError);
        note && note(`${state.piError} Showing simulated demo data.`);
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

  // ---------------------------------------------------------------- tooltips
  function showTip(tip, e, content) {
    tip.replaceChildren(...content);
    tip.hidden = false;
    const pad = 18, W = window.innerWidth, H = window.innerHeight;
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + tip.offsetWidth > W - 8) x = e.clientX - tip.offsetWidth - pad;
    if (y + tip.offsetHeight > H - 8) y = Math.max(8, e.clientY - tip.offsetHeight - pad);
    tip.style.left = `${Math.max(8, x)}px`; tip.style.top = `${y}px`;
  }

  // How current the numbers are. PI timestamps, not the time the page asked: if nothing has been
  // written for a while (simulator stopped, interface down) the page says so in words.
  const ago = ms => { const m = Math.round(ms / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
  const when = t => new Date(t).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  function freshness(asOf, live) {
    const src = live ? `PI Web API, ${(CFG.piwebapi || {}).afServer}` : "Demo data (simulator)";
    if (!asOf) return { source: `${src} · no timestamps in the values`, stale: live ? "No value has a timestamp: check that the PI points exist and have data." : null, short: null };
    const age = Date.now() - new Date(asOf).getTime(), limit = Math.max(10 * 60000, 3 * (CFG.refreshSeconds || 60) * 1000);
    const stale = live && age > limit;
    return {
      source: live ? `${src} · newest value ${when(asOf)} (${ago(age)}) · checked every ${CFG.refreshSeconds || 60} s` : `${src} · snapshot of ${when(asOf)}`,
      stale: stale ? `Values are not up to date: the newest one is from ${when(asOf)}, ${ago(age)}. Is the simulator (python -m sim run) or the data interface writing to PI?` : null,
      short: stale ? `data ${ago(age).replace(" ago", " old")}` : null,
    };
  }

  function asOfText() {
    const d = new Date(state.data.asOf);
    return `${state.data.live ? "Live" : "Demo data"} · ${d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`;
  }

  // short hover/tap content for the landing pages: status and one number, details live in PI Vision
  function briefSite(code, hint) {
    const m = SITES[code], f = siteFigures(code), st = siteStatus(code);
    return [el("h3", {}, m.name), el("div", { class: "sub" }, m.country), pill(st.level),
      el("div", { class: "num" }, fmt(f.oil), el("small", {}, " bbl/d oil")),
      st.reasons[0] ? el("div", { class: "why" }, st.reasons[0]) : null,
      hint ? el("div", { class: "hint" }, hint) : null].filter(Boolean);
  }
  function briefWell(code, id) {
    const w = SITES[code].wells.find(x => x.id === id), v = state.data.sites[code].wells[id];
    return [el("h3", {}, w.name), pill(WELL_LEVEL[v.status] || "planned", v.status),
      el("div", { class: "num" }, fmt(v.oil), el("small", {}, " bbl/d oil"))];
  }
  function briefRefinery(code) {
    const m = SITES[code], f = siteFigures(code), st = siteStatus(code);
    return [el("h3", {}, `${m.name} refinery`), pill(st.level),
      el("div", { class: "num" }, fmt(f.thru), el("small", {}, " bbl/d processed"))];
  }

  // PI Vision link for a site (template in config.js); falls back to the PI Vision home page
  function piVisionUrl(code) {
    const pv = CFG.piVision || {};
    const asset = `\\${(CFG.piwebapi || {}).afServer}\${M.database}\${code ? SITES[code].path : M.rootPath}`;
    const tpl = code ? pv.siteDisplay : pv.overviewDisplay;
    return tpl ? tpl.replace("{asset}", encodeURIComponent(asset)) : pv.home || null;
  }

  window.CP_UI = {
    M, SITES, CFG, state, el, sv, esc, fmt, LEVEL, WELL_LEVEL, UNIT_LEVEL, UNIT_TEXT, icon, pill,
    siteStatus, siteFigures, totals, load, autoRefresh, showTip, asOfText, freshness, when, ago, briefSite, briefWell, briefRefinery, piVisionUrl,
  };
})();
