// Design: Hex grid. Land as hexagons that light up around each site.
(function () {
  "use strict";
  const U = window.CP_UI, { M, SITES, state, el, sv, fmt, merc, LEVEL, WELL_LEVEL } = U;
  const OUTLINES = window.CP_MAP;
  const $ = id => document.getElementById(id);
  const svg = $("map");
  const HUE = { good: "#3b82ff", warning: "#ffa53b", critical: "#ff3d7f", planned: "#6d6f9c" };
  const BASE = "#1b1c46";
  const SQ3 = Math.sqrt(3);
  const toXY = (lat, lon) => [lon, -merc(lat)];
  const toLat = y => (Math.atan(Math.sinh((-y * Math.PI) / 180)) * 180) / Math.PI;

  // ---------------------------------------------------------------- land mask
  const rings = OUTLINES.shapes.filter(s => s.sa || s.name === "France").flatMap(s => s.rings).map(r => {
    let a = 90, b = -90, c = 180, d = -180;
    for (const [lat, lon] of r) { a = Math.min(a, lat); b = Math.max(b, lat); c = Math.min(c, lon); d = Math.max(d, lon); }
    return { r, box: [a, b, c, d] };
  });
  function onLand(lat, lon) {
    let inside = false;
    for (const { r, box } of rings) {
      if (lat < box[0] || lat > box[1] || lon < box[2] || lon > box[3]) continue;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [yi, xi] = r[i], [yj, xj] = r[j];
        if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  }
  function hexGrid(x0, y0, x1, y1, r) {
    const cells = [], dx = SQ3 * r, dy = 1.5 * r;
    for (let row = 0, y = y0; y <= y1; y += dy, row++) {
      for (let x = x0 + (row % 2 ? dx / 2 : 0); x <= x1; x += dx) if (onLand(toLat(y), x)) cells.push([x, y]);
    }
    return cells;
  }
  const hexPath = (x, y, r) => {
    let d = "";
    for (let i = 0; i < 6; i++) { const a = (Math.PI / 3) * i + Math.PI / 6; d += (i ? "L" : "M") + (x + r * Math.cos(a)).toFixed(4) + "," + (y + r * Math.sin(a)).toFixed(4); }
    return d + "Z";
  };

  // cells take the hue of the strongest nearby source; brightness falls off with distance
  function paintCells(cells, r, sources) {
    const buckets = new Map();
    for (const [x, y] of cells) {
      let best = null, bw = 0;
      for (const s of sources) {
        const w = 1 - Math.hypot(x - s.x, y - s.y) / s.reach;
        if (w > bw) { bw = w; best = s; }
      }
      const key = best ? `${best.hue}|${Math.min(5, Math.ceil(bw * 5))}` : "base";
      (buckets.get(key) || buckets.set(key, []).get(key)).push(hexPath(x, y, r * 0.84));
    }
    const g = sv("g", { "aria-hidden": "true" });
    for (const [key, paths] of buckets) {
      if (key === "base") { g.append(sv("path", { d: paths.join(""), fill: BASE })); continue; }
      const [hue, lvl] = key.split("|");
      g.append(sv("path", { d: paths.join(""), fill: HUE[hue], "fill-opacity": (0.22 + 0.155 * lvl).toFixed(2) }));
    }
    return g;
  }

  // ---------------------------------------------------------------- scene
  let continentCells = null, vb = null, anim = null;
  const CONT = (() => { const [x0, y0] = toXY(13, -82), [x1, y1] = toXY(-56, -34); return [x0, y0, x1 - x0, y1 - y0]; })();
  const layers = {};
  function buildScene() {
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    const defs = sv("defs", {}, sv("linearGradient", { id: "arcGrad", x1: 0, y1: 0, x2: 1, y2: 0 },
      sv("stop", { offset: 0, "stop-color": "#3b82ff" }), sv("stop", { offset: 1, "stop-color": "#ff3d9a" })));
    layers.cont = sv("g", {}); layers.site = sv("g", {}); layers.arcs = sv("g", {});
    svg.replaceChildren(defs, layers.cont, layers.site, layers.arcs);
  }
  function drawContinent() {
    const r = 0.42;
    continentCells = continentCells || hexGrid(CONT[0], CONT[1], CONT[0] + CONT[2], CONT[1] + CONT[3], r);
    const max = Math.max(1, ...M.sites.map(m => U.siteFigures(m.code).oil));
    const sources = M.sites.map(m => {
      const [x, y] = toXY(m.lat, m.lon);
      return { x, y, hue: U.siteStatus(m.code).level, reach: 1.2 + 3.2 * Math.sqrt(U.siteFigures(m.code).oil / max) };
    });
    layers.cont.replaceChildren(paintCells(continentCells, r, sources));
  }
  function siteBox(code) {
    const m = SITES[code], pts = [toXY(m.lat, m.lon), ...m.wells.map(w => toXY(w.lat, w.lon))];
    let [x0, y0] = pts[0], x1 = x0, y1 = y0;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const pad = Math.max(x1 - x0, y1 - y0) * 0.35 + 0.05;
    return [x0 - pad, y0 - pad * 1.4, x1 - x0 + pad * 2.4, y1 - y0 + pad * 2.6];   // room on the right and top for chips
  }
  function drawSite(code) {
    const m = SITES[code], s = state.data.sites[code], [bx, by, bw, bh] = siteBox(code);
    const r = Math.max(bw, bh) / 70;
    const cells = hexGrid(bx - bw * .3, by - bh * .3, bx + bw * 1.3, by + bh * 1.3, r);
    const max = Math.max(1, ...Object.values(s.wells).map(w => w.oil || 0));
    const [rx, ry] = toXY(m.lat, m.lon);
    const sources = [{ x: rx, y: ry, hue: U.siteStatus(code).level, reach: r * 7 },
      ...m.wells.map(w => { const [x, y] = toXY(w.lat, w.lon), v = s.wells[w.id];
        return { x, y, hue: WELL_LEVEL[v.status] || "planned", reach: r * (2.2 + 3 * Math.sqrt((v.oil || 0) / max)) }; })];
    layers.site.replaceChildren(paintCells(cells, r, sources));
    layers.arcs.replaceChildren(...m.wells.map(w => {
      const [x, y] = toXY(w.lat, w.lon), mx = (x + rx) / 2, my = (y + ry) / 2, len = Math.hypot(rx - x, ry - y);
      return sv("path", { class: "arc", d: `M${x},${y} Q${mx + (ry - y) * .25},${my - (rx - x) * .25 - len * .15} ${rx},${ry}` });
    }));
  }

  // ---------------------------------------------------------------- view box + chips
  function setVB(v) { vb = v; svg.setAttribute("viewBox", v.map(n => n.toFixed(5)).join(" ")); placeChips(); }
  function toScreen(x, y) {
    const W = svg.clientWidth, H = svg.clientHeight, k = Math.min(W / vb[2], H / vb[3]);
    return [(x - vb[0]) * k + (W - vb[2] * k) / 2, (y - vb[1]) * k + (H - vb[3] * k) / 2];
  }
  function animateTo(target, ms = 1000) {
    cancelAnimationFrame(anim);
    const from = vb.slice(), t0 = performance.now();
    const dur = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : ms;
    const step = now => {
      const p = dur ? Math.min(1, (now - t0) / dur) : 1, e = p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      const w = Math.exp(Math.log(from[2]) + (Math.log(target[2]) - Math.log(from[2])) * e);
      const h = Math.exp(Math.log(from[3]) + (Math.log(target[3]) - Math.log(from[3])) * e);
      const cx = from[0] + from[2] / 2 + (target[0] + target[2] / 2 - from[0] - from[2] / 2) * e;
      const cy = from[1] + from[3] / 2 + (target[1] + target[3] / 2 - from[1] - from[3] / 2) * e;
      setVB([cx - w / 2, cy - h / 2, w, h]);
      if (p < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }

  const GLYPH = {
    refinery: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 14.5V7l4 2.5V7l4 2.5V2.5h3v12Z" fill="#fff"/></svg>',
    well: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5C5.2 5.6 4 8.2 4 10.4a4 4 0 0 0 8 0c0-2.2-1.2-4.8-4-8.9Z" fill="#fff"/></svg>',
  };
  let chips = [];
  function chip(cls, hue, glyph, title, value, onEnter, onClick, label) {
    const b = el("button", { class: `callout ${cls}`, type: "button", "aria-label": label });
    const ico = el("span", { class: "ico", style: `background:${HUE[hue]}` }); ico.innerHTML = GLYPH[glyph];
    b.append(ico, el("span", {}, el("small", {}, title), el("b", {}, value)));
    b.addEventListener("pointermove", e => U.showTip($("tip"), e, onEnter()));
    b.addEventListener("pointerleave", () => { $("tip").hidden = true; });
    b.addEventListener("focus", () => { const r = b.getBoundingClientRect(); U.showTip($("tip"), { clientX: r.right, clientY: r.bottom }, onEnter()); });
    b.addEventListener("blur", () => { $("tip").hidden = true; });
    b.addEventListener("click", onClick || (e => U.showTip($("tip"), e, onEnter())));
    return b;
  }
  function buildChips() {
    const box = $("chips"); box.replaceChildren(); chips = [];
    if (!state.view) {
      for (const m of M.sites) {
        const st = U.siteStatus(m.code).level, f = U.siteFigures(m.code);
        const c = chip("site", st, "refinery", m.name, `${fmt(f.oil)} bbl/d`, () => U.briefSite(m.code, "Click to see the wells"), () => openSite(m.code), `${m.name}, ${LEVEL[st].label}, ${fmt(f.oil)} barrels per day`);
        const stem = el("div", { class: "stem" });
        box.append(stem, c); chips.push({ c, stem, lat: m.lat, lon: m.lon });
      }
    } else {
      const m = SITES[state.view], s = state.data.sites[state.view];
      for (const w of m.wells) {
        const v = s.wells[w.id], lv = WELL_LEVEL[v.status] || "planned";
        const c = chip("well", lv, "well", w.name, `${fmt(v.oil)} bbl/d`, () => U.briefWell(state.view, w.id), null, `${w.name}, ${v.status}`);
        const stem = el("div", { class: "stem" });
        box.append(stem, c); chips.push({ c, stem, lat: w.lat, lon: w.lon });
      }
      const st = U.siteStatus(state.view).level;
      const c = chip("site", st, "refinery", "Refinery", `${fmt(s.thru)} bbl/d`, () => U.briefRefinery(state.view), null, `${m.name} refinery`);
      const stem = el("div", { class: "stem" });
      box.append(stem, c); chips.push({ c, stem, lat: m.lat, lon: m.lon });
    }
    placeChips();
  }
  function placeChips() {
    const placed = [];
    const items = chips.map(ch => ({ ch, p: toScreen(...toXY(ch.lat, ch.lon)) })).sort((a, b) => b.p[1] - a.p[1]);
    for (const { ch, p } of items) {
      const w = ch.c.offsetWidth || 140, h = ch.c.offsetHeight || 46;
      let x = p[0] + 8, y = p[1] - 14;                                   // chip bottom-left corner
      const minY = h + (window.innerWidth < 640 ? 150 : 96);              // below the header
      const hit = () => placed.find(r => x < r[0] + r[2] + 6 && x + w + 6 > r[0] && y - h < r[1] + 6 && y + 6 > r[1] - r[3]);
      for (let i = 0, r; i < 14 && (r = hit()) && r[1] - r[3] - 8 >= minY; i++) y = r[1] - r[3] - 8;     // stack upwards
      if (y < minY) y = minY;                                                                                // stay below the header
      for (let i = 0, r; i < 14 && (r = hit()); i++) x = r[0] + r[2] + 8;                                    // then slide right
      if (x + w > window.innerWidth - 8) {                                                                   // no room: put it left of the point
        x = p[0] - w - 8;
        for (let i = 0, r; i < 14 && (r = hit()); i++) x = r[0] - w - 8;
      }
      x = Math.max(8, x);
      placed.push([x, y, w, h]);
      ch.c.style.left = `${x}px`; ch.c.style.top = `${y}px`;
      Object.assign(ch.stem.style, { left: `${p[0]}px`, top: `${y - 4}px`, height: `${Math.max(0, p[1] - y + 4)}px` });
    }
  }

  // ---------------------------------------------------------------- chrome
  function renderChrome() {
    const t = $("title"); t.replaceChildren();
    const pv = $("pv"), url = U.piVisionUrl(state.view);
    if (state.view) {
      const m = SITES[state.view], f = U.siteFigures(state.view), st = U.siteStatus(state.view);
      t.append(el("button", { type: "button", onclick: closeSite }, "← ALL SITES"), el("h1", {}, m.name),
        el("p", {}, el("b", {}, `${fmt(f.oil)} bbl/d`), ` oil · ${f.producing} of ${f.wells} wells producing · ${LEVEL[st.level].label}`));
    } else {
      const T = U.totals(), flagged = T.levels.warning + T.levels.critical;
      t.append(el("h1", {}, "Cordillera Petróleo"),
        el("p", {}, el("b", {}, `${fmt(T.oil)} bbl/d`), ` oil · ${flagged ? `${flagged} of ${M.sites.length} sites need attention` : "all sites normal"}`));
    }
    pv.hidden = !url; if (url) pv.href = url;
    const item = (hue, txt) => el("span", {}, el("i", { style: `background:${HUE[hue]}` }), txt);
    $("legend").replaceChildren(...(state.view
      ? [item("good", "Producing"), item("warning", "Starting up"), item("critical", "Tripped"), item("planned", "Stopped")]
      : [item("good", "Normal"), item("warning", "Watch"), item("critical", "Alert")]));
    $("asof").textContent = U.asOfText();
  }

  // ---------------------------------------------------------------- navigation
  const continentBox = () => svg.clientWidth > 640 ? [CONT[0] - 3, CONT[1] - 8, CONT[2] + 12, CONT[3] + 14] : [CONT[0] - 1, CONT[1] - 16, CONT[2] + 6, CONT[3] + 24];
  function openSite(code) {
    state.view = code; $("tip").hidden = true;
    try { history.replaceState(null, "", `#${code}`); } catch (_) { /* sandboxed */ }
    drawSite(code); layers.cont.style.opacity = 0;
    renderChrome(); buildChips(); animateTo(siteBox(code));
  }
  function closeSite() {
    state.view = null; $("tip").hidden = true;
    try { history.replaceState(null, "", location.pathname + location.search); } catch (_) { /* sandboxed */ }
    layers.site.replaceChildren(); layers.arcs.replaceChildren(); layers.cont.style.opacity = 1;
    renderChrome(); buildChips(); animateTo(continentBox());
  }

  async function main() {
    try { await U.load(); } catch (e) { $("asof").textContent = `Could not load data: ${e.message}`; return; }
    U.designSwitcher($("designs"), "hex.html");
    buildScene(); drawContinent();
    const start = location.hash.slice(1);
    state.view = SITES[start] ? start : null;
    if (state.view) { drawSite(state.view); layers.cont.style.opacity = 0; }
    vb = state.view ? siteBox(state.view) : continentBox();
    renderChrome(); buildChips(); setVB(vb);
    window.addEventListener("resize", () => setVB(state.view ? siteBox(state.view) : continentBox()));
    document.addEventListener("keydown", e => { if (e.key === "Escape" && state.view) closeSite(); });
    U.autoRefresh(() => { drawContinent(); if (state.view) drawSite(state.view); renderChrome(); buildChips(); });
  }
  main();
})();
