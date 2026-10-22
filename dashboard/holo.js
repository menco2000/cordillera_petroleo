// Design: Holo 3D. Tilted, extruded continent with glowing columns per site.
(function () {
  "use strict";
  const U = window.CP_UI, { M, SITES, state, el, sv, fmt, merc, LEVEL, WELL_LEVEL } = U;
  const OUTLINES = window.CP_MAP;
  const $ = id => document.getElementById(id);
  const svg = $("stage");

  const TILT = 0.58, SHEAR = 0.14, DEPTH = 16;            // look of the 3D plate
  const HUE = { good: "#36d6ff", warning: "#ffb627", critical: "#ff4b4b", planned: "#6f8aa0" };
  const METRICS = {
    oil: { label: "Oil production", unit: "bbl/d", get: c => U.siteFigures(c).oil },
    thru: { label: "Refinery throughput", unit: "bbl/d", get: c => U.siteFigures(c).thru },
    wells: { label: "Wells producing", unit: "wells", get: c => U.siteFigures(c).producing },
  };
  let metric = "oil";
  const view = { cx: -60, cy: 20, s: 10 };             // centre in mercator degrees, px per degree
  let anim = null;

  // ---------------------------------------------------------------- projection
  const W = () => svg.clientWidth || window.innerWidth, H = () => svg.clientHeight || window.innerHeight;
  const toMerc = (lat, lon) => [lon, -merc(lat)];
  function matrix() {
    // the plate sits slightly right of centre so the top-left panel doesn't cover the north
    const left = W() > 900 ? 120 : 0;
    const s = view.s, e = (W() + left) / 2 - s * view.cx - s * SHEAR * view.cy, f = H() * 0.53 - s * TILT * view.cy;
    return [s, 0, s * SHEAR, s * TILT, e, f];
  }
  function project(lat, lon) {
    const [x, y] = toMerc(lat, lon), [a, , c, d, e, f] = matrix();
    return [a * x + c * y + e, d * y + f];
  }

  // ---------------------------------------------------------------- static scene
  let landTop, gratG, dyn, plate;
  function buildScene() {
    const defs = sv("defs", {},
      sv("linearGradient", { id: "landFill", x1: 0, y1: 0, x2: 0, y2: 1 },
        sv("stop", { offset: "0", "stop-color": "#0f3b6b" }), sv("stop", { offset: "1", "stop-color": "#0a2547" })),
      sv("filter", { id: "glow", x: "-20%", y: "-20%", width: "140%", height: "140%" }, sv("feGaussianBlur", { stdDeviation: 6 })),
      sv("filter", { id: "glowS", x: "-50%", y: "-50%", width: "200%", height: "200%" },
        sv("feGaussianBlur", { stdDeviation: 2.2, result: "b" }), sv("feMerge", {}, sv("feMergeNode", { in: "b" }), sv("feMergeNode", { in: "SourceGraphic" }))),
      ...Object.entries(HUE).flatMap(([k, c]) => [
        sv("linearGradient", { id: `cf-${k}`, x1: 0, y1: 1, x2: 0, y2: 0 },
          sv("stop", { offset: "0", "stop-color": c, "stop-opacity": .15 }), sv("stop", { offset: "1", "stop-color": c, "stop-opacity": .95 })),
        sv("linearGradient", { id: `cs-${k}`, x1: 0, y1: 1, x2: 0, y2: 0 },
          sv("stop", { offset: "0", "stop-color": c, "stop-opacity": .08 }), sv("stop", { offset: "1", "stop-color": c, "stop-opacity": .6 })),
      ]));
    // continent outline in mercator degrees; drawn once, moved with a transform
    let dSA = "", dOther = "";
    for (const s of OUTLINES.shapes) {
      const d = s.rings.map(r => "M" + r.map(([lat, lon]) => `${lon},${(-merc(lat)).toFixed(3)}`).join("L") + "Z").join("");
      if (s.sa || s.name === "France") dSA += d; else dOther += d;
    }
    defs.append(sv("path", { id: "sa", d: dSA, "vector-effect": "non-scaling-stroke" }));
    gratG = sv("g", {});
    plate = sv("g", {});
    plate.append(sv("use", { href: "#sa", class: "land-glow", "data-k": DEPTH + 4 }));
    for (let k = DEPTH; k >= 2; k -= 2) plate.append(sv("use", { href: "#sa", class: "land-wall", "data-k": k, style: `fill: hsl(${205 + k}, 80%, ${12 + (DEPTH - k) * 0.6}%)` }));
    landTop = sv("use", { href: "#sa", class: "land-top", "data-k": 0 });
    plate.append(landTop, sv("path", { d: dOther, class: "land-other", "data-k": 0 }));
    dyn = sv("g", {});
    svg.replaceChildren(defs, gratG, plate, dyn);
  }

  function placeScene() {
    const m = matrix().map(v => v.toFixed(5)).join(",");
    for (const n of plate.children) n.setAttribute("transform", `translate(0,${n.dataset.k}) matrix(${m})`);
    plate.firstChild.style.display = view.s > 60 ? "none" : "";   // the halo is a continent-scale effect
    // graticule: spacing adapts to zoom so lines stay ~90 px apart
    const step = [20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05].find(st => st * view.s * TILT < 140) || 0.05;
    const span = Math.max(W(), H()) / view.s * 1.6;
    gratG.replaceChildren();
    const x0 = Math.floor((view.cx - span) / step) * step, y0 = Math.floor((view.cy - span) / step) * step;
    let d = "";
    for (let x = x0; x <= view.cx + span; x += step) d += `M${x},${view.cy - span}L${x},${view.cy + span}`;
    for (let y = y0; y <= view.cy + span; y += step) d += `M${view.cx - span},${y}L${view.cx + span},${y}`;
    gratG.append(sv("path", { d, class: "grat", transform: `translate(0,${DEPTH + 30}) matrix(${m})` }));
  }

  // ---------------------------------------------------------------- columns
  function prism(x, y, h, w, hue, cls) {
    const dx = w * 0.55, dy = w * 0.32, top = y - h;
    const g = sv("g", { class: cls || "" });
    g.append(
      sv("polygon", { class: "face-f", points: `${x - w / 2},${y} ${x + w / 2},${y} ${x + w / 2},${top} ${x - w / 2},${top}`, fill: `url(#cf-${hue})` }),
      sv("polygon", { points: `${x + w / 2},${y} ${x + w / 2 + dx},${y - dy} ${x + w / 2 + dx},${top - dy} ${x + w / 2},${top}`, fill: `url(#cs-${hue})` }),
      sv("polygon", { points: `${x - w / 2},${top} ${x + w / 2},${top} ${x + w / 2 + dx},${top - dy} ${x - w / 2 + dx},${top - dy}`, fill: HUE[hue], opacity: .95 }),
      sv("line", { x1: x - w / 2, y1: top, x2: x + w / 2 + dx, y2: top - dy, stroke: "#fff", "stroke-opacity": .6, "stroke-width": .8 }));
    return g;
  }
  function ring(x, y, r, hue) {
    const g = sv("g", { "aria-hidden": "true" });
    g.append(sv("ellipse", { cx: x, cy: y, rx: r, ry: r * TILT, fill: HUE[hue], "fill-opacity": .14, stroke: HUE[hue], "stroke-opacity": .55, "stroke-width": 1.2 }));
    const pulse = sv("ellipse", { cx: x, cy: y, rx: r, ry: r * TILT, fill: "none", stroke: HUE[hue], "stroke-width": 1.5 });
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      pulse.append(sv("animate", { attributeName: "rx", values: `${r * .6};${r * 1.6}`, dur: "2.4s", repeatCount: "indefinite" }),
        sv("animate", { attributeName: "ry", values: `${r * .6 * TILT};${r * 1.6 * TILT}`, dur: "2.4s", repeatCount: "indefinite" }),
        sv("animate", { attributeName: "stroke-opacity", values: ".8;0", dur: "2.4s", repeatCount: "indefinite" }));
    }
    g.append(pulse);
    return g;
  }
  let placed = [];
  function tag(x, y, title, value, align = "start") {
    const g = sv("g", { class: "tag", "pointer-events": "none" });
    const w = Math.max(title.length * 7.6, value.length * 6.6) + 18;
    let bx = align === "start" ? x + 10 : x - w / 2;
    let by = y - 44;
    const hit = () => placed.find(r => bx < r[0] + r[2] + 4 && bx + w + 4 > r[0] && by < r[1] + r[3] + 4 && by + 34 + 4 > r[1]);
    for (let i = 0, r; i < 12 && (r = hit()) && r[1] - 38 >= 70; i++) by = r[1] - 38;   // first try stacking upwards
    if (by < 70) by = 70;                                                                  // keep clear of the tab bar
    for (let i = 0, r; i < 12 && (r = hit()); i++) bx = r[0] + r[2] + 8;                  // then slide sideways
    placed.push([bx, by, w, 34]);
    g.append(sv("polyline", { points: `${x},${y} ${x},${by + 34} ${Math.max(bx, Math.min(x, bx + w))},${by + 34}`, fill: "none", stroke: "rgba(120,210,255,.6)", "stroke-width": 1 }),
      sv("rect", { x: bx, y: by, width: w, height: 34, rx: 2 }),
      sv("text", { x: bx + 9, y: by + 15, "font-size": 14 }, title),
      sv("text", { x: bx + 9, y: by + 28, "font-size": 11, class: "v" }, value));
    return g;
  }

  function hover(g, content, onClick, label) {
    g.setAttribute("tabindex", 0);
    g.setAttribute("role", onClick ? "button" : "img");
    g.setAttribute("aria-label", label);
    g.addEventListener("pointermove", e => showHud(e, content()));
    g.addEventListener("pointerleave", hideHud);
    g.addEventListener("focus", () => { const r = g.getBoundingClientRect(); showHud({ clientX: r.right, clientY: r.top }, content()); });
    g.addEventListener("blur", hideHud);
    if (onClick) {
      g.addEventListener("click", onClick);
      g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } });
    } else g.addEventListener("click", e => showHud(e, content()));
    return g;
  }

  function drawDynamic() {
    dyn.replaceChildren();
    placed = [];
    const items = [];
    if (!state.view) {
      const max = Math.max(1, ...M.sites.map(m => METRICS[metric].get(m.code)));
      for (const m of M.sites) {
        const [x, y] = project(m.lat, m.lon), st = U.siteStatus(m.code).level, v = METRICS[metric].get(m.code);
        const h = 16 + 118 * Math.sqrt(v / max);
        const g = sv("g", { class: "col" });
        g.append(ring(x, y, 26, st));
        // the site's wells as a small skyline around the main column (offsets exaggerated)
        const wells = m.wells.map(w => {
          const [wx, wy] = project(w.lat, w.lon);
          let ox = (wx - x) * 9, oy = (wy - y) * 9;
          const len = Math.hypot(ox, oy), lim = 30;
          if (len > lim) { ox *= lim / len; oy *= lim / len; }
          return { w, x: x + ox, y: y + oy };
        }).sort((a, b) => a.y - b.y);
        const wmax = Math.max(1, ...m.wells.map(w => state.data.sites[m.code].wells[w.id].oil || 0));
        for (const p of wells.filter(p => p.y < y)) {
          const wv = state.data.sites[m.code].wells[p.w.id];
          g.append(prism(p.x, p.y, 6 + 40 * Math.sqrt((wv.oil || 0) / wmax), 5, WELL_LEVEL[wv.status] || "planned"));
        }
        g.append(prism(x, y, h, 15, st));
        for (const p of wells.filter(p => p.y >= y)) {
          const wv = state.data.sites[m.code].wells[p.w.id];
          g.append(prism(p.x, p.y, 6 + 40 * Math.sqrt((wv.oil || 0) / wmax), 5, WELL_LEVEL[wv.status] || "planned"));
        }
        g.append(tag(x, y - h - 6, m.name, `${fmt(v)} ${METRICS[metric].unit}`, "start"));
        hover(g, () => hudFrame(m.code, U.siteTip(m.code)), () => openSite(m.code), `${m.name}, ${LEVEL[st].label}`);
        items.push([y, g]);
      }
    } else {
      const m = SITES[state.view], s = state.data.sites[state.view];
      const [rx, ry] = project(m.lat, m.lon);
      const flows = sv("g", { "aria-hidden": "true" });
      for (const w of m.wells) {
        const [x, y] = project(w.lat, w.lon);
        flows.append(sv("path", { class: "flow", d: `M${x},${y} Q${(x + rx) / 2},${(y + ry) / 2 - 30} ${rx},${ry}` }));
      }
      dyn.append(flows);
      const wmax = Math.max(1, ...m.wells.map(w => s.wells[w.id].oil || 0));
      for (const w of m.wells) {
        const [x, y] = project(w.lat, w.lon), v = s.wells[w.id], lv = WELL_LEVEL[v.status] || "planned";
        const h = 10 + 120 * Math.sqrt((v.oil || 0) / wmax);
        const g = sv("g", { class: "col" });
        g.append(ring(x, y, 16, lv), prism(x, y, h, 12, lv), tag(x, y - h - 4, w.name, `${fmt(v.oil)} bbl/d`, "middle"));
        hover(g, () => hudFrame(w.id, U.wellTip(state.view, w.id)), null, `${w.name}, ${v.status}`);
        items.push([y, g]);
      }
      const st = U.siteStatus(state.view).level;
      const g = sv("g", { class: "col" });
      g.append(ring(rx, ry, 30, st), prism(rx, ry, 170, 24, st), tag(rx, ry - 180, `${m.name} refinery`, `${fmt(s.thru)} bbl/d`, "middle"));
      hover(g, () => hudFrame(`${m.code} refinery`, U.refineryTip(state.view)), null, `${m.name} refinery`);
      items.push([ry, g]);
    }
    items.sort((a, b) => a[0] - b[0]).forEach(([, g]) => dyn.append(g));
  }

  // ---------------------------------------------------------------- HUD
  function hudFrame(id, content) {
    const t = new Date(state.data.asOf).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    return [el("div", { class: "bar" }, el("span", {}, t), el("span", {}, id)), ...content];
  }
  const showHud = (e, content) => U.showTip($("tip"), e, content);
  const hideHud = () => { $("tip").hidden = true; };

  function renderPanel() {
    const p = $("panel"); p.replaceChildren();
    const T = U.totals();
    p.append(el("h1", {}, el("i"), "Cordillera Petróleo"));
    if (state.view) {
      const m = SITES[state.view], f = U.siteFigures(state.view);
      p.append(el("button", { type: "button", onclick: closeSite }, "← All sites"),
        el("div", { class: "cap" }, `${m.name} · ${m.country}`),
        el("div", { class: "big" }, fmt(f.oil), el("small", {}, "bbl/d oil")),
        el("div", { class: "counts" },
          el("div", {}, "Refinery throughput", el("b", {}, `${fmt(f.thru)}`)),
          el("div", {}, "Utilization", el("b", {}, `${fmt(f.util)}%`)),
          el("div", {}, "Wells producing", el("b", {}, `${f.producing}/${f.wells}`))));
    } else {
      const total = metric === "wells" ? T.producing : metric === "thru" ? T.thru : T.oil;
      p.append(el("div", { class: "cap" }, METRICS[metric].label),
        el("div", { class: "big" }, fmt(total), el("small", {}, metric === "wells" ? `of ${T.wells} wells` : "bbl/d")),
        el("div", { class: "counts" }, ["good", "warning", "critical"].map(l =>
          el("div", {}, el("span", { class: "sq", style: `background:${HUE[l]};box-shadow:0 0 6px ${HUE[l]}` }), `${LEVEL[l].label} sites`, el("b", {}, T.levels[l])))));
    }
  }

  function renderTabs() {
    const t = $("tabs"); t.replaceChildren();
    for (const [k, v] of Object.entries(METRICS)) {
      t.append(el("button", { type: "button", "aria-pressed": String(k === metric), disabled: state.view ? true : null,
        onclick: () => { metric = k; renderTabs(); renderPanel(); drawDynamic(); } }, v.label));
    }
    t.style.visibility = state.view ? "hidden" : "visible";
  }

  function renderCompass() {
    // north points "into" the tilted plate; the dial shows that bearing and the tilt
    const c = $("compass"); c.replaceChildren();
    const s = sv("svg", { viewBox: "0 0 128 128", width: 128, height: 128 });
    s.append(sv("circle", { cx: 64, cy: 64, r: 58, fill: "rgba(6,22,44,.82)", stroke: "rgba(80,190,255,.45)" }),
      sv("circle", { cx: 64, cy: 64, r: 44, fill: "none", stroke: "rgba(80,190,255,.25)", "stroke-dasharray": "2 4" }));
    for (let a = 0; a < 360; a += 15) {
      const r1 = a % 90 ? 52 : 47, rad = (a - 90) * Math.PI / 180;
      s.append(sv("line", { x1: 64 + r1 * Math.cos(rad), y1: 64 + r1 * Math.sin(rad), x2: 64 + 57 * Math.cos(rad), y2: 64 + 57 * Math.sin(rad), stroke: "rgba(120,210,255,.6)" }));
    }
    const bearing = -Math.atan(SHEAR) * 180 / Math.PI;
    const rad = (bearing - 90) * Math.PI / 180;
    s.append(sv("path", { d: `M64,64 L${64 + 40 * Math.cos(rad - .18)},${64 + 40 * Math.sin(rad - .18)} A40,40 0 0 1 ${64 + 40 * Math.cos(rad + .18)},${64 + 40 * Math.sin(rad + .18)} Z`, fill: "rgba(54,214,255,.35)" }),
      sv("text", { x: 64 + 34 * Math.cos(rad), y: 64 + 34 * Math.sin(rad) + 4, "text-anchor": "middle", fill: "#e6f6ff", "font-size": 11, "font-family": "Rajdhani", "font-weight": 700 }, "N"),
      sv("text", { x: 64, y: 66, "text-anchor": "middle", fill: "#e6f6ff", "font-size": 15, "font-family": "Rajdhani", "font-weight": 700 }, `${Math.round(Math.acos(TILT) * 180 / Math.PI)}°`),
      sv("text", { x: 64, y: 80, "text-anchor": "middle", fill: "#9fc4dc", "font-size": 9, "font-family": "Archivo" }, "Tilt"));
    c.append(s);
  }

  // ---------------------------------------------------------------- navigation
  function fitTo(lat0, lon0, lat1, lon1, fill) {
    const [x0, y0] = toMerc(lat1, lon0), [x1, y1] = toMerc(lat0, lon1);
    const w = Math.abs(x1 - x0) + Math.abs(y1 - y0) * SHEAR, h = Math.abs(y1 - y0) * TILT;
    const left = W() > 900 ? 240 : 0;
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, s: Math.min((W() - left) * fill / w, (H() - 120) * fill / h) };
  }
  const continent = () => fitTo(-55, -81, 12, -35, W() > 900 ? 0.8 : 0.9);
  function siteView(code) {
    const m = SITES[code], lats = [m.lat, ...m.wells.map(w => w.lat)], lons = [m.lon, ...m.wells.map(w => w.lon)];
    const v = fitTo(Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons), 0.55);
    v.s = Math.min(v.s, 2600);
    return v;
  }
  function animateTo(target, ms = 1100) {
    cancelAnimationFrame(anim);
    const from = { ...view }, t0 = performance.now();
    const dur = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : ms;
    const step = now => {
      const p = dur ? Math.min(1, (now - t0) / dur) : 1, e = p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      view.s = Math.exp(Math.log(from.s) + (Math.log(target.s) - Math.log(from.s)) * e);
      view.cx = from.cx + (target.cx - from.cx) * e; view.cy = from.cy + (target.cy - from.cy) * e;
      placeScene(); drawDynamic();
      if (p < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }
  function openSite(code) {
    state.view = code; hideHud();
    try { history.replaceState(null, "", `#${code}`); } catch (_) { /* sandboxed */ }
    renderPanel(); renderTabs(); animateTo(siteView(code));
  }
  function closeSite() {
    state.view = null; hideHud();
    try { history.replaceState(null, "", location.pathname + location.search); } catch (_) { /* sandboxed */ }
    renderPanel(); renderTabs(); animateTo(continent());
  }

  async function main() {
    const note = t => { const n = $("note"); n.textContent = t; n.hidden = false; };
    try { await U.load(note); } catch (e) { note(`Could not load data: ${e.message}`); return; }
    buildScene();
    U.designSwitcher($("designs"), "holo.html");
    $("asof").textContent = U.asOfText();
    const start = location.hash.slice(1);
    state.view = SITES[start] ? start : null;
    Object.assign(view, state.view ? siteView(state.view) : continent());
    placeScene(); drawDynamic(); renderPanel(); renderTabs(); renderCompass();
    window.addEventListener("resize", () => { Object.assign(view, state.view ? siteView(state.view) : continent()); placeScene(); drawDynamic(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && state.view) closeSite(); });
    U.autoRefresh(() => { drawDynamic(); renderPanel(); $("asof").textContent = U.asOfText(); }, e => note(`Refresh failed: ${e.message}`));
  }
  main();
})();
