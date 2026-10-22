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
    return [x0 - pad * 1.6, y0 - pad, x1 - x0 + pad * 2.6, y1 - y0 + pad * 2];   // room on the left for the stats column
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
        const c = chip("site", st, "refinery", m.name, `${fmt(f.oil)} bbl/d`, () => U.siteTip(m.code), () => openSite(m.code), `${m.name}, ${LEVEL[st].label}, ${fmt(f.oil)} barrels per day`);
        const stem = el("div", { class: "stem" });
        box.append(stem, c); chips.push({ c, stem, lat: m.lat, lon: m.lon });
      }
    } else {
      const m = SITES[state.view], s = state.data.sites[state.view];
      for (const w of m.wells) {
        const v = s.wells[w.id], lv = WELL_LEVEL[v.status] || "planned";
        const c = chip("well", lv, "well", w.name, `${fmt(v.oil)} bbl/d`, () => U.wellTip(state.view, w.id), null, `${w.name}, ${v.status}`);
        const stem = el("div", { class: "stem" });
        box.append(stem, c); chips.push({ c, stem, lat: w.lat, lon: w.lon });
      }
      const st = U.siteStatus(state.view).level;
      const c = chip("site", st, "refinery", `${m.name} refinery`, `${fmt(s.thru)} bbl/d`, () => U.refineryTip(state.view), null, `${m.name} refinery`);
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
      const hit = () => placed.find(r => x < r[0] + r[2] + 6 && x + w + 6 > r[0] && y - h < r[1] + 6 && y + 6 > r[1] - r[3]);
      for (let i = 0, r; i < 14 && (r = hit()) && r[1] - r[3] - 8 >= h + 12; i++) y = r[1] - r[3] - 8;   // stack upwards
      if (y < h + 12) y = h + 12;                                                                            // stay on screen
      for (let i = 0, r; i < 14 && (r = hit()); i++) x = r[0] + r[2] + 8;                                    // then slide right
      placed.push([x, y, w, h]);
      ch.c.style.left = `${x}px`; ch.c.style.top = `${y}px`;
      Object.assign(ch.stem.style, { left: `${p[0]}px`, top: `${y - 4}px`, height: `${Math.max(0, p[1] - y + 4)}px` });
    }
  }

  // ---------------------------------------------------------------- side figures
  function renderStats() {
    const S = $("stats"), B = $("bottom"); S.replaceChildren(); B.replaceChildren();
    const seg = parts => el("div", { class: "seg" }, parts.filter(p => p[1] > 0).map(([c, n]) => el("i", { style: `flex:${n};background:${c}` })));
    const row = (color, name, value, share) => el("div", { class: "row" }, el("i", { class: "d", style: `background:${color}` }),
      el("span", { class: "n" }, name), el("span", { class: "v" }, value), el("span", { class: "p" }, share));
    const big = (label, value, unit) => el("div", {}, el("span", {}, label), el("b", {}, value, unit ? el("small", {}, unit) : null));
    if (!state.view) {
      const T = U.totals();
      S.append(el("h1", {}, "Production overview"), el("div", { class: "lbl" }, "Oil production"),
        el("div", { class: "hero" }, fmt(T.oil), el("small", {}, "bbl/d")),
        el("div", { class: "sec" }, "Site status"),
        seg([[HUE.good, T.levels.good], [HUE.warning, T.levels.warning], [HUE.critical, T.levels.critical]]),
        el("div", { class: "rows" }, [...M.sites].sort((a, b) => U.siteFigures(b.code).oil - U.siteFigures(a.code).oil).map(m =>
          row(HUE[U.siteStatus(m.code).level], m.name, fmt(U.siteFigures(m.code).oil), `${fmt(100 * U.siteFigures(m.code).oil / T.oil)}%`))));
      B.append(big("Refinery throughput", fmt(T.thru), "bbl/d"), big("Utilization", fmt(T.util), "%"),
        big("Wells producing", `${T.producing}`, `of ${T.wells}`), big("Water cut", fmt(T.wc, 1), "%"));
    } else {
      const m = SITES[state.view], s = state.data.sites[state.view], f = U.siteFigures(state.view);
      const counts = { good: 0, warning: 0, critical: 0, planned: 0 };
      Object.values(s.wells).forEach(v => counts[WELL_LEVEL[v.status] || "planned"]++);
      S.append(el("h1", {}, m.name), el("div", { class: "lbl" }, "Oil production", el("button", { type: "button", onclick: closeSite }, "← All sites")),
        el("div", { class: "hero" }, fmt(f.oil), el("small", {}, "bbl/d")),
        el("div", { class: "sec" }, "Wells"),
        seg([[HUE.good, counts.good], [HUE.warning, counts.warning], [HUE.critical, counts.critical], [HUE.planned, counts.planned]]),
        el("div", { class: "rows" }, [...m.wells].sort((a, b) => (s.wells[b.id].oil || 0) - (s.wells[a.id].oil || 0)).map(w =>
          row(HUE[WELL_LEVEL[s.wells[w.id].status] || "planned"], `${w.name} · ${s.wells[w.id].status}`, fmt(s.wells[w.id].oil), `${fmt(100 * (s.wells[w.id].oil || 0) / Math.max(1, f.oil))}%`))));
      B.append(big("Refinery throughput", fmt(f.thru), "bbl/d"), big("Utilization", fmt(f.util), "%"),
        big("Crude stock", f.crudeDays == null ? "—" : fmt(f.crudeDays, 1), "days"), big("Water cut", f.wc == null ? "—" : fmt(f.wc, 1), "%"));
    }
  }

  // ---------------------------------------------------------------- navigation
  const continentBox = () => { const W = svg.clientWidth; return W > 900 ? [CONT[0] - CONT[2] * .32, CONT[1] - 7, CONT[2] * 1.45, CONT[3] + 11] : [CONT[0], CONT[1] - 12, CONT[2], CONT[3] + 14]; };
  function openSite(code) {
    state.view = code; $("tip").hidden = true;
    try { history.replaceState(null, "", `#${code}`); } catch (_) { /* sandboxed */ }
    drawSite(code); layers.cont.style.opacity = 0;
    renderStats(); buildChips(); animateTo(siteBox(code));
  }
  function closeSite() {
    state.view = null; $("tip").hidden = true;
    try { history.replaceState(null, "", location.pathname + location.search); } catch (_) { /* sandboxed */ }
    layers.site.replaceChildren(); layers.arcs.replaceChildren(); layers.cont.style.opacity = 1;
    renderStats(); buildChips(); animateTo(continentBox());
  }

  async function main() {
    const note = t => { $("asof").textContent = t; };
    try { await U.load(note); } catch (e) { note(`Could not load data: ${e.message}`); return; }
    const asof = () => { $("asof").textContent = U.asOfText() + ($("asof").dataset.note ? ` · ${$("asof").dataset.note}` : ""); };
    if (!state.data.live) $("asof").dataset.note = "PI Web API not reachable";
    U.designSwitcher($("designs"), "hex.html");
    buildScene(); drawContinent();
    const start = location.hash.slice(1);
    state.view = SITES[start] ? start : null;
    if (state.view) { drawSite(state.view); layers.cont.style.opacity = 0; }
    vb = state.view ? siteBox(state.view) : continentBox();
    renderStats(); buildChips(); setVB(vb); asof();
    window.addEventListener("resize", () => setVB(state.view ? siteBox(state.view) : continentBox()));
    document.addEventListener("keydown", e => { if (e.key === "Escape" && state.view) closeSite(); });
    U.autoRefresh(() => { drawContinent(); if (state.view) drawSite(state.view); renderStats(); buildChips(); asof(); });
  }
  main();
})();
