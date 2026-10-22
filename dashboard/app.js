(function () {
  "use strict";
  const M = window.CP_MODEL, OUTLINES = window.CP_MAP, CFG = window.CP_CONFIG || { source: "demo" };
  const SITES = Object.fromEntries(M.sites.map(s => [s.code, s]));
  const SVGNS = "http://www.w3.org/2000/svg";
  const SOUTH_AMERICA = [[-56, -82], [13, -34]];
  const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const $ = id => document.getElementById(id);
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
  function sv(tag, attrs) {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
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

  // ---------------------------------------------------------------- data
  async function load() {
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
        note(`PI Web API not reachable (${e.message}). Showing simulated demo data.`);
      }
    }
    state.source = demoSource();
    state.data = await state.source.snapshot();
  }
  function note(text) { const n = $("note"); n.textContent = text; n.hidden = false; }

  // ---------------------------------------------------------------- map
  let map, sitesLayer, detailLayer;

  function initMap() {
    map = L.map("map", { zoomControl: false, minZoom: 3, maxZoom: 17, worldCopyJump: true, zoomSnap: 0.25 });
    L.control.zoom({ position: "bottomright" }).addTo(map);
    map.fitBounds(SOUTH_AMERICA);
    const mc = CFG.map || {};
    const imagery = L.tileLayer(mc.imagery, { maxZoom: 19, maxNativeZoom: 18, attribution: mc.attribution || "" }).addTo(map);
    const labels = mc.labels ? L.tileLayer(mc.labels, { maxZoom: 19, maxNativeZoom: 18, opacity: 0.9 }).addTo(map) : null;
    let loaded = 0, failed = 0, fellBack = false;
    imagery.on("tileload", () => { loaded++; });
    imagery.on("tileerror", () => {
      failed++;
      if (!loaded && failed >= 4 && !fellBack) {      // no imagery at all: offline outlines instead
        fellBack = true;
        map.removeLayer(imagery); if (labels) map.removeLayer(labels);
        drawOutlines();
        note((($("note").hidden ? "" : $("note").textContent + " ")) + "Satellite imagery needs internet access; showing country outlines.");
      }
    });
    sitesLayer = L.layerGroup().addTo(map);
    detailLayer = L.layerGroup().addTo(map);
    map.on("movestart", hideTip);
  }

  function drawOutlines() {
    const g = L.layerGroup();
    for (const s of OUTLINES.shapes) {
      L.polygon(s.rings, { color: "#6f8796", weight: 0.8, fillColor: s.sa ? "#22323e" : "#18232c", fillOpacity: 1, interactive: false }).addTo(g);
    }
    g.addTo(map);
    g.eachLayer(l => l.bringToBack());
  }

  function marker(lat, lon, cls, d, color, labelHtml, ariaLabel) {
    const html = `<div class="mk ${cls}" style="--d:${d}px"><span class="dot" style="background:${color}"></span>` +
      (labelHtml ? `<span class="lbl">${labelHtml}</span>` : "") + `</div>`;
    return L.marker([lat, lon], {
      icon: L.divIcon({ className: "mk-wrap", html, iconSize: [0, 0], iconAnchor: [0, 0] }),
      keyboard: true, title: "", alt: ariaLabel, riseOnHover: true,
    });
  }

  function hoverable(m, content, onClick) {
    m.on("mouseover mousemove", e => showTip(e.originalEvent, content()));
    m.on("mouseout", hideTip);
    if (onClick) m.on("click keypress", e => { if (e.type === "click" || e.originalEvent.key === "Enter") onClick(); });
    else m.on("click", e => showTip(e.originalEvent, content()));   // touch: tap shows the details
    return m;
  }

  function drawSites() {
    sitesLayer.clearLayers();
    const D = state.data.sites;
    const max = Math.max(...Object.values(D).map(s => s.oil || 0), 1);
    for (const m of M.sites) {
      const s = D[m.code], st = siteStatus(m.code);
      const d = Math.round(14 + 22 * Math.sqrt((s.oil || 0) / max));
      const mk = marker(m.lat, m.lon, "site", d, LEVEL[st.level].color,
        `${esc(m.name)}<small>${fmt(s.oil)} bbl/d</small>`, `${m.name}: ${LEVEL[st.level].label}`);
      hoverable(mk, () => siteTip(m.code), () => openSite(m.code)).addTo(sitesLayer);
    }
  }

  const REFINERY_GLYPH = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 14V7l4 2.5V7l4 2.5V3h2.5v11Z" fill="#fff"/></svg>';

  function drawSite(code) {
    detailLayer.clearLayers();
    const m = SITES[code], s = state.data.sites[code];
    const max = Math.max(1, ...Object.values(s.wells).map(w => w.oil || 0));
    for (const w of m.wells) {
      L.polyline([[w.lat, w.lon], [m.lat, m.lon]], { color: "#ffffff", weight: 1.3, opacity: 0.55, dashArray: "4 6", interactive: false }).addTo(detailLayer);
    }
    for (const w of m.wells) {
      const v = s.wells[w.id], l = WELL_LEVEL[v.status] || "planned";
      const d = Math.round(11 + 13 * Math.sqrt((v.oil || 0) / max));
      hoverable(marker(w.lat, w.lon, "well", d, LEVEL[l].color, esc(w.name), `${w.name}: ${v.status}`), () => wellTip(code, w.id)).addTo(detailLayer);
    }
    const ref = L.marker([m.lat, m.lon], {
      icon: L.divIcon({ className: "mk-wrap", iconSize: [0, 0], iconAnchor: [0, 0],
        html: `<div class="mk ref" style="--d:24px"><span class="dot">${REFINERY_GLYPH}</span><span class="lbl">${esc(m.name)} refinery<small>${fmt(s.thru)} bbl/d</small></span></div>` }),
      keyboard: true, alt: `${m.name} refinery`, zIndexOffset: 1000,
    });
    hoverable(ref, () => refineryTip(code)).addTo(detailLayer);
  }

  function siteBounds(code) {
    const m = SITES[code];
    return L.latLngBounds([[m.lat, m.lon], ...m.wells.map(w => [w.lat, w.lon])]);
  }

  function openSite(code) {
    if (!SITES[code]) return;
    state.view = code;
    hideTip();
    try { history.replaceState(null, "", `#${code}`); } catch (_) { /* sandboxed */ }
    map.removeLayer(sitesLayer);
    drawSite(code);
    map.flyToBounds(siteBounds(code), { paddingTopLeft: [60, 120], paddingBottomRight: [180, 60], maxZoom: 12, duration: 1.6 });
    renderChrome();
  }

  function closeSite() {
    state.view = null;
    hideTip();
    try { history.replaceState(null, "", location.pathname + location.search); } catch (_) { /* sandboxed */ }
    detailLayer.clearLayers();
    sitesLayer.addTo(map);
    map.flyToBounds(SOUTH_AMERICA, { duration: 1.6 });
    renderChrome();
  }

  // ---------------------------------------------------------------- tooltips
  const kv = pairs => el("div", { class: "kv" }, pairs.flatMap(([a, b]) => [el("span", {}, a), el("span", {}, b)]));

  function siteTip(code) {
    const m = SITES[code], s = state.data.sites[code], st = siteStatus(code);
    const wells = Object.values(s.wells);
    const prod = wells.filter(w => w.status === "Producing").length;
    const wc = (s.oil + s.water) > 1 ? (100 * s.water) / (s.oil + s.water) : null;
    return [el("h3", {}, `${m.name}, ${m.country}`), pill(st.level),
      kv([["Oil production", `${fmt(s.oil)} bbl/d`], ["Refinery throughput", `${fmt(s.thru)} bbl/d`],
        ["Utilization", `${fmt((100 * s.thru) / m.capacity)}% of ${fmt(m.capacity)}`], ["Wells producing", `${prod} of ${wells.length}`],
        ["Water cut", wc == null ? "—" : `${fmt(wc, 1)}%`]]),
      st.reasons.length ? el("div", { class: "why" }, st.reasons.slice(0, 3).join(" · ")) : null,
      el("div", { class: "hint" }, "Click to see the wells")];
  }

  function wellTip(code, id) {
    const w = SITES[code].wells.find(x => x.id === id), v = state.data.sites[code].wells[id];
    return [el("h3", {}, w.name), pill(WELL_LEVEL[v.status] || "planned", v.status),
      kv([["Oil rate", `${fmt(v.oil)} bbl/d`], ["Water cut", v.wc == null ? "—" : `${fmt(v.wc, 1)}%`],
        ["Oil today", `${fmt(v.dayOil)} bbl`], ["Design rate", `${fmt(w.design)} bbl/d`], ["Lift", w.lift], ["Asset ID", w.id]]),
      v.scenario && v.scenario !== "Normal" ? el("div", { class: "why" }, `Event: ${v.scenario}`) : null];
  }

  function refineryTip(code) {
    const m = SITES[code], s = state.data.sites[code], st = siteStatus(code);
    const days = s.thru > 0 && s.crudeInv != null ? s.crudeInv / s.thru : null;
    return [el("h3", {}, `${m.name} refinery`), pill(st.level),
      kv([["Throughput", `${fmt(s.thru)} bbl/d`], ["Utilization", `${fmt((100 * s.thru) / m.capacity)}%`],
        ["Crude stock", days == null ? "—" : `${fmt(days, 1)} days`]]),
      el("div", { class: "units" }, m.units.map(u => {
        const v = s.units[u.key] || {};
        return el("div", {}, el("span", {}, pill(UNIT_LEVEL[v.status] || "good", u.label)),
          el("span", { class: "m" }, `${fmt(v.metric, u.metricUom === "bbl/d" ? 0 : 1)} ${u.metricUom}`));
      })),
      (() => { const ev = m.units.map(u => s.units[u.key]?.scenario).filter(x => x && x !== "Normal");
        return ev.length ? el("div", { class: "why" }, `Events: ${[...new Set(ev)].join(", ")}`) : null; })()];
  }

  function showTip(e, content) {
    const tip = $("tip");
    tip.replaceChildren(...content.filter(Boolean));
    tip.hidden = false;
    const pad = 16, W = window.innerWidth, H = window.innerHeight;
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + tip.offsetWidth > W - 8) x = e.clientX - tip.offsetWidth - pad;
    if (y + tip.offsetHeight > H - 8) y = Math.max(8, e.clientY - tip.offsetHeight - pad);
    tip.style.left = `${Math.max(8, x)}px`; tip.style.top = `${y}px`;
  }
  function hideTip() { $("tip").hidden = true; }

  // ---------------------------------------------------------------- chrome
  function renderChrome() {
    const where = $("where"); where.replaceChildren();
    if (state.view) {
      const m = SITES[state.view];
      where.append(el("button", { type: "button", onclick: closeSite }, "← All sites"),
        el("span", {}, `${m.name}, ${m.country}`), pill(siteStatus(state.view).level));
    } else {
      const flagged = M.sites.filter(m => siteStatus(m.code).level !== "good").length;
      where.append(el("span", {}, `${M.sites.length} sites · ${flagged ? `${flagged} need attention` : "all normal"}`));
    }
    const st = $("status"); st.className = "chip" + (state.data.live ? " live" : "");
    const d = new Date(state.data.asOf);
    st.lastChild.textContent = `${state.data.live ? "Live" : "Demo data"} · ${d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`;
    const lg = $("legend"); lg.replaceChildren();
    const row = (level, text) => el("div", { class: "row" }, icon(level), text);
    if (state.view) {
      lg.append(row("good", "Producing"), row("warning", "Starting up"), row("critical", "Tripped"), row("planned", "Shut-in or workover"),
        el("div", { class: "row" }, el("span", { style: "width:12px;height:12px;border-radius:3px;background:#101820;border:1.5px solid #fff;display:inline-block" }), "Refinery"));
    } else {
      lg.append(row("good", "Normal"), row("warning", "Watch"), row("critical", "Alert"), el("div", { class: "row", style: "color:var(--muted)" }, "Size = oil production"));
    }
  }

  function redraw() {
    drawSites();
    if (state.view) drawSite(state.view);
    renderChrome();
  }

  async function refresh() {
    try { state.data = await state.source.snapshot(); redraw(); }
    catch (e) { note(`Refresh failed: ${e.message}`); }
  }

  async function main() {
    try { await load(); } catch (e) { note(`Could not load data: ${e.message}`); return; }
    initMap();
    drawSites();
    renderChrome();
    const start = location.hash.slice(1);
    if (SITES[start]) {
      state.view = start; map.removeLayer(sitesLayer); drawSite(start);
      map.fitBounds(siteBounds(start), { paddingTopLeft: [60, 120], paddingBottomRight: [180, 60], maxZoom: 12 });
      renderChrome();
    }
    window.addEventListener("hashchange", () => { const c = location.hash.slice(1); if (SITES[c] && c !== state.view) openSite(c); else if (!c && state.view) closeSite(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && state.view) closeSite(); });
    if (state.data.live) setInterval(refresh, (CFG.refreshSeconds || 60) * 1000);
  }
  main();
})();
