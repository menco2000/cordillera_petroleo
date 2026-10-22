// Design: Satellite. Full-screen imagery, details in hover tooltips.
(function () {
  "use strict";
  const U = window.CP_UI, { M, SITES, CFG, state, el, esc, fmt, LEVEL, WELL_LEVEL, icon, pill } = U;
  const OUTLINES = window.CP_MAP;
  const SOUTH_AMERICA = [[-56, -82], [13, -34]];
  const $ = id => document.getElementById(id);
  const tip = () => $("tip");

  function note(text) { const n = $("note"); n.textContent = text; n.hidden = false; }
  const hideTip = () => { tip().hidden = true; };

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
        const g = L.layerGroup();
        for (const s of OUTLINES.shapes) {
          L.polygon(s.rings, { color: "#6f8796", weight: 0.8, fillColor: s.sa ? "#22323e" : "#18232c", fillOpacity: 1, interactive: false }).addTo(g);
        }
        g.addTo(map); g.eachLayer(l => l.bringToBack());
        note(($("note").hidden ? "" : $("note").textContent + " ") + "Satellite imagery needs internet access; showing country outlines.");
      }
    });
    sitesLayer = L.layerGroup().addTo(map);
    detailLayer = L.layerGroup().addTo(map);
    map.on("movestart", hideTip);
  }

  function marker(lat, lon, cls, d, color, labelHtml, ariaLabel, inner = "") {
    const html = `<div class="mk ${cls}" style="--d:${d}px"><span class="dot" style="background:${color}">${inner}</span>` +
      (labelHtml ? `<span class="lbl">${labelHtml}</span>` : "") + `</div>`;
    return L.marker([lat, lon], {
      icon: L.divIcon({ className: "mk-wrap", html, iconSize: [0, 0], iconAnchor: [0, 0] }),
      keyboard: true, title: "", alt: ariaLabel, riseOnHover: true,
    });
  }

  function hoverable(m, content, onClick) {
    m.on("mouseover mousemove", e => U.showTip(tip(), e.originalEvent, content()));
    m.on("mouseout", hideTip);
    if (onClick) m.on("click keypress", e => { if (e.type === "click" || e.originalEvent.key === "Enter") onClick(); });
    else m.on("click", e => U.showTip(tip(), e.originalEvent, content()));   // touch: tap shows the details
    return m;
  }

  function drawSites() {
    sitesLayer.clearLayers();
    const max = Math.max(...M.sites.map(m => U.siteFigures(m.code).oil), 1);
    for (const m of M.sites) {
      const f = U.siteFigures(m.code), st = U.siteStatus(m.code);
      const d = Math.round(14 + 22 * Math.sqrt(f.oil / max));
      hoverable(marker(m.lat, m.lon, "site", d, LEVEL[st.level].color, `${esc(m.name)}<small>${fmt(f.oil)} bbl/d</small>`,
        `${m.name}: ${LEVEL[st.level].label}`), () => U.siteTip(m.code), () => openSite(m.code)).addTo(sitesLayer);
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
      hoverable(marker(w.lat, w.lon, "well", d, LEVEL[l].color, esc(w.name), `${w.name}: ${v.status}`), () => U.wellTip(code, w.id)).addTo(detailLayer);
    }
    const ref = marker(m.lat, m.lon, "ref", 24, "#101820", `${esc(m.name)} refinery<small>${fmt(s.thru)} bbl/d</small>`, `${m.name} refinery`, REFINERY_GLYPH);
    ref.setZIndexOffset(1000);
    hoverable(ref, () => U.refineryTip(code)).addTo(detailLayer);
  }

  const siteBounds = code => L.latLngBounds([[SITES[code].lat, SITES[code].lon], ...SITES[code].wells.map(w => [w.lat, w.lon])]);
  const SITE_PAD = { paddingTopLeft: [60, 120], paddingBottomRight: [180, 60], maxZoom: 12 };

  function openSite(code, animate = true) {
    if (!SITES[code]) return;
    state.view = code; hideTip();
    try { history.replaceState(null, "", `#${code}`); } catch (_) { /* sandboxed */ }
    map.removeLayer(sitesLayer);
    drawSite(code);
    animate ? map.flyToBounds(siteBounds(code), { ...SITE_PAD, duration: 1.6 }) : map.fitBounds(siteBounds(code), SITE_PAD);
    renderChrome();
  }

  function closeSite() {
    state.view = null; hideTip();
    try { history.replaceState(null, "", location.pathname + location.search); } catch (_) { /* sandboxed */ }
    detailLayer.clearLayers();
    sitesLayer.addTo(map);
    map.flyToBounds(SOUTH_AMERICA, { duration: 1.6 });
    renderChrome();
  }

  function renderChrome() {
    const where = $("where"); where.replaceChildren();
    if (state.view) {
      const m = SITES[state.view];
      where.append(el("button", { type: "button", onclick: closeSite }, "← All sites"), el("span", {}, `${m.name}, ${m.country}`), pill(U.siteStatus(state.view).level));
    } else {
      const flagged = M.sites.filter(m => U.siteStatus(m.code).level !== "good").length;
      where.append(el("span", {}, `${M.sites.length} sites · ${flagged ? `${flagged} need attention` : "all normal"}`));
    }
    const st = $("status"); st.className = "chip" + (state.data.live ? " live" : "");
    st.lastChild.textContent = U.asOfText();
    const lg = $("legend"); lg.replaceChildren();
    const row = (level, text) => el("div", { class: "row" }, icon(level), text);
    if (state.view) {
      lg.append(row("good", "Producing"), row("warning", "Starting up"), row("critical", "Tripped"), row("planned", "Shut-in or workover"),
        el("div", { class: "row" }, el("span", { style: "width:12px;height:12px;border-radius:3px;background:#101820;border:1.5px solid #fff;display:inline-block" }), "Refinery"));
    } else {
      lg.append(row("good", "Normal"), row("warning", "Watch"), row("critical", "Alert"), el("div", { class: "row", style: "color:var(--muted)" }, "Size = oil production"));
    }
  }

  async function main() {
    try { await U.load(note); } catch (e) { note(`Could not load data: ${e.message}`); return; }
    U.designSwitcher($("designs"), "index.html");
    initMap();
    drawSites();
    renderChrome();
    if (SITES[location.hash.slice(1)]) openSite(location.hash.slice(1), false);
    window.addEventListener("hashchange", () => { const c = location.hash.slice(1); if (SITES[c] && c !== state.view) openSite(c); else if (!c && state.view) closeSite(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && state.view) closeSite(); });
    U.autoRefresh(() => { drawSites(); if (state.view) drawSite(state.view); renderChrome(); }, e => note(`Refresh failed: ${e.message}`));
  }
  main();
})();
