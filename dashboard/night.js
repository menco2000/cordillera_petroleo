// Design: Night ops. Darkened satellite feed, pulsing beacons, HUD panels.
(function () {
  "use strict";
  const U = window.CP_UI, { M, SITES, CFG, state, el, esc, fmt, LEVEL, WELL_LEVEL, icon } = U;
  const OUTLINES = window.CP_MAP;
  const SOUTH_AMERICA = [[-56, -82], [13, -34]];
  const $ = id => document.getElementById(id);
  const HUE = { good: "#4df0c8", warning: "#ffc23d", critical: "#ff4d5e", planned: "#7b8f8a" };
  const SITE_PAD = { paddingTopLeft: [300, 100], paddingBottomRight: [120, 80], maxZoom: 12 };
  let map, sitesLayer, detailLayer;

  const note = t => { const n = $("note"); n.textContent = ($("note").hidden ? "" : n.textContent + " ") + t; n.hidden = false; };
  const hideTip = () => { $("tip").hidden = true; };
  function hud(id, content) {
    const t = new Date(state.data.asOf).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    return [el("div", { class: "bar" }, el("span", {}, `T ${t}`), el("span", {}, id)), ...content];
  }

  function initMap() {
    map = L.map("map", { zoomControl: false, minZoom: 3, maxZoom: 17, worldCopyJump: true, zoomSnap: 0.25 });
    L.control.zoom({ position: "bottomright" }).addTo(map);
    map.fitBounds(SOUTH_AMERICA, { paddingTopLeft: [260, 0] });
    const mc = CFG.map || {};
    const imagery = L.tileLayer(mc.imagery, { maxZoom: 19, maxNativeZoom: 18, attribution: mc.attribution || "" }).addTo(map);
    const labels = mc.labels ? L.tileLayer(mc.labels, { maxZoom: 19, maxNativeZoom: 18, opacity: 0.75 }).addTo(map) : null;
    let loaded = 0, failed = 0, fellBack = false;
    imagery.on("tileload", () => { loaded++; });
    imagery.on("tileerror", () => {
      failed++;
      if (!loaded && failed >= 4 && !fellBack) {      // no imagery: offline outlines in the same palette
        fellBack = true;
        map.removeLayer(imagery); if (labels) map.removeLayer(labels);
        const g = L.layerGroup();
        for (const s of OUTLINES.shapes) L.polygon(s.rings, { color: "#2e6b60", weight: 0.8, fillColor: s.sa ? "#0b1d1e" : "#071214", fillOpacity: 1, interactive: false }).addTo(g);
        g.addTo(map); g.eachLayer(l => l.bringToBack());
        note("Satellite imagery needs internet access; showing country outlines.");
      }
    });
    sitesLayer = L.layerGroup().addTo(map);
    detailLayer = L.layerGroup().addTo(map);
    map.on("movestart", hideTip);
    map.on("mousemove", e => {
      const { lat, lng } = e.latlng;
      $("readout").replaceChildren(el("span", {}, "LAT ", el("b", {}, `${Math.abs(lat).toFixed(4)}° ${lat < 0 ? "S" : "N"}`)),
        el("span", {}, "LON ", el("b", {}, `${Math.abs(lng).toFixed(4)}° ${lng < 0 ? "W" : "E"}`)), el("span", {}, "ZOOM ", el("b", {}, map.getZoom().toFixed(1))));
    });
  }

  function beacon(lat, lon, hue, d, labelHtml, aria, square = "") {
    const body = square ? `<span class="sq">${square}</span>` : `<span class="ring"></span><span class="ring r2"></span><span class="core"></span>`;
    return L.marker([lat, lon], {
      icon: L.divIcon({ className: "bc-wrap", iconSize: [0, 0], iconAnchor: [0, 0],
        html: `<div class="bc" style="--d:${d}px;--c:${HUE[hue]}">${body}${labelHtml ? `<span class="lbl">${labelHtml}</span>` : ""}</div>` }),
      keyboard: true, alt: aria, riseOnHover: true,
    });
  }
  function hoverable(m, content, onClick) {
    m.on("mouseover mousemove", e => U.showTip($("tip"), e.originalEvent, content()));
    m.on("mouseout", hideTip);
    if (onClick) m.on("click keypress", e => { if (e.type === "click" || e.originalEvent.key === "Enter") onClick(); });
    else m.on("click", e => U.showTip($("tip"), e.originalEvent, content()));
    return m;
  }

  function drawSites() {
    sitesLayer.clearLayers();
    const max = Math.max(1, ...M.sites.map(m => U.siteFigures(m.code).oil));
    for (const m of M.sites) {
      const st = U.siteStatus(m.code).level, f = U.siteFigures(m.code);
      hoverable(beacon(m.lat, m.lon, st, Math.round(10 + 14 * Math.sqrt(f.oil / max)), `${esc(m.name.toUpperCase())}<small>${fmt(f.oil)} BBL/D</small>`, `${m.name}: ${LEVEL[st].label}`),
        () => hud(m.code, U.siteTip(m.code, "Click to open site")), () => openSite(m.code)).addTo(sitesLayer);
    }
  }

  const REFINERY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 14V7l4 2.5V7l4 2.5V3h2.5v11Z" fill="currentColor"/></svg>';
  function drawSite(code) {
    detailLayer.clearLayers();
    const m = SITES[code], s = state.data.sites[code];
    const max = Math.max(1, ...Object.values(s.wells).map(w => w.oil || 0));
    for (const w of m.wells) {
      L.polyline([[w.lat, w.lon], [m.lat, m.lon]], { color: HUE.good, weight: 1.5, opacity: 0.75, className: "flowline", interactive: false }).addTo(detailLayer);
    }
    for (const w of m.wells) {
      const v = s.wells[w.id], lv = WELL_LEVEL[v.status] || "planned";
      hoverable(beacon(w.lat, w.lon, lv, Math.round(8 + 10 * Math.sqrt((v.oil || 0) / max)), `${esc(w.name.toUpperCase())}<small>${fmt(v.oil)} BBL/D</small>`, `${w.name}: ${v.status}`),
        () => hud(w.id, U.wellTip(code, w.id))).addTo(detailLayer);
    }
    const st = U.siteStatus(code).level;
    const ref = beacon(m.lat, m.lon, st, 22, `${esc(m.name.toUpperCase())} REFINERY<small>${fmt(s.thru)} BBL/D</small>`, `${m.name} refinery`, REFINERY);
    ref.setZIndexOffset(1000);
    hoverable(ref, () => hud(`${m.code} REF`, U.refineryTip(code))).addTo(detailLayer);
  }

  const siteBounds = code => L.latLngBounds([[SITES[code].lat, SITES[code].lon], ...SITES[code].wells.map(w => [w.lat, w.lon])]);
  function openSite(code, animate = true) {
    if (!SITES[code]) return;
    state.view = code; hideTip();
    try { history.replaceState(null, "", `#${code}`); } catch (_) { /* sandboxed */ }
    map.removeLayer(sitesLayer); drawSite(code);
    animate ? map.flyToBounds(siteBounds(code), { ...SITE_PAD, duration: 1.8 }) : map.fitBounds(siteBounds(code), SITE_PAD);
    renderPanel();
  }
  function closeSite() {
    state.view = null; hideTip();
    try { history.replaceState(null, "", location.pathname + location.search); } catch (_) { /* sandboxed */ }
    detailLayer.clearLayers(); sitesLayer.addTo(map);
    map.flyToBounds(SOUTH_AMERICA, { paddingTopLeft: [260, 0], duration: 1.8 });
    renderPanel();
  }

  function renderPanel() {
    const p = $("panel"); p.replaceChildren();
    const grid = pairs => el("div", { class: "grid" }, pairs.flatMap(([a, b]) => [el("span", {}, a), el("span", {}, b)]));
    p.append(el("div", { class: "t" }, "Cordillera // Ops"));
    if (state.view) {
      const m = SITES[state.view], f = U.siteFigures(state.view);
      p.append(el("button", { type: "button", onclick: closeSite }, "< ALL SITES"),
        el("div", { class: "sub" }, `${m.name} · ${m.country} · ${LEVEL[U.siteStatus(state.view).level].label}`),
        el("div", { class: "big" }, fmt(f.oil), el("small", {}, "BBL/D OIL")),
        grid([["Refinery", `${fmt(f.thru)} bbl/d`], ["Utilization", `${fmt(f.util)}%`], ["Wells producing", `${f.producing}/${f.wells}`], ["Crude stock", f.crudeDays == null ? "—" : `${fmt(f.crudeDays, 1)} d`]]));
    } else {
      const T = U.totals();
      p.append(el("div", { class: "sub" }, `${M.sites.length} sites · ${U.asOfText()}`),
        el("div", { class: "big" }, fmt(T.oil), el("small", {}, "BBL/D OIL")),
        grid([["Refinery", `${fmt(T.thru)} bbl/d`], ["Utilization", `${fmt(T.util)}%`], ["Wells producing", `${T.producing}/${T.wells}`],
          ["Status", `${T.levels.good} OK · ${T.levels.warning} watch · ${T.levels.critical} alert`]]));
    }
    const lg = $("legend"); lg.replaceChildren();
    const item = (level, text) => el("span", {}, icon(level), text);
    lg.append(...(state.view ? [item("good", "Producing"), item("warning", "Starting up"), item("critical", "Tripped"), item("planned", "Shut-in / workover")]
      : [item("good", "Normal"), item("warning", "Watch"), item("critical", "Alert"), el("span", { style: "color:var(--muted)" }, "Beacon size = oil production")]));
  }

  async function main() {
    try { await U.load(note); } catch (e) { note(`Could not load data: ${e.message}`); return; }
    U.designSwitcher($("designs"), "night.html");
    initMap(); drawSites(); renderPanel();
    if (SITES[location.hash.slice(1)]) openSite(location.hash.slice(1), false);
    document.addEventListener("keydown", e => { if (e.key === "Escape" && state.view) closeSite(); });
    U.autoRefresh(() => { drawSites(); if (state.view) drawSite(state.view); renderPanel(); }, e => note(`Refresh failed: ${e.message}`));
  }
  main();
})();
