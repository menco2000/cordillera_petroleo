// Design: 3D. Tilted relief of the continent with one solid bar per site.
(function () {
  "use strict";
  const U = window.CP_UI, { M, SITES, state, el, sv, fmt, merc, LEVEL, WELL_LEVEL, icon } = U;
  const OUTLINES = window.CP_MAP;
  const $ = id => document.getElementById(id);
  const svg = $("stage");

  const TILT = 0.6, SHEAR = 0.12, DEPTH = 10;
  const COLOR = { good: "#0ca30c", warning: "#fab219", critical: "#d03b3b", planned: "#8a96a1" };
  const view = { cx: -60, cy: 20, s: 10 };
  let anim = null;

  // flat shading: front = status color, side darker, top lighter
  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    const t = f < 0 ? 0 : 255, p = Math.abs(f);
    return `rgb(${Math.round(r + (t - r) * p)},${Math.round(g + (t - g) * p)},${Math.round(b + (t - b) * p)})`;
  }

  // ---------------------------------------------------------------- projection
  const W = () => svg.clientWidth || window.innerWidth, H = () => svg.clientHeight || window.innerHeight;
  const small = () => W() < 640;
  const toMerc = (lat, lon) => [lon, -merc(lat)];
  function matrix() {
    // centre of the free area between header (+ room for bars) and footer
    const free0 = chromeTop() + (state.view ? 40 : (small() ? 150 : 200)), free1 = chromeBottom();
    const s = view.s, cyScreen = (free0 + free1) / 2;
    return [s, 0, s * SHEAR, s * TILT, W() / 2 - s * view.cx - s * SHEAR * view.cy, cyScreen - s * TILT * view.cy];
  }
  function project(lat, lon) {
    const [x, y] = toMerc(lat, lon), [a, , c, d, e, f] = matrix();
    return [a * x + c * y + e, d * y + f];
  }

  // ---------------------------------------------------------------- relief
  let plate, dyn;
  function buildScene() {
    let dSA = "", dOther = "";
    for (const s of OUTLINES.shapes) {
      const d = s.rings.map(r => "M" + r.map(([lat, lon]) => `${lon},${(-merc(lat)).toFixed(3)}`).join("L") + "Z").join("");
      if (s.sa || s.name === "France") dSA += d; else dOther += d;
    }
    const defs = sv("defs", {}, sv("path", { id: "sa", d: dSA, "vector-effect": "non-scaling-stroke" }));
    plate = sv("g", { "aria-hidden": "true" });
    plate.append(sv("path", { d: dOther, class: "land-other", "data-k": 0 }), sv("use", { href: "#sa", class: "land-base", "data-k": DEPTH }));
    for (let k = DEPTH - 2; k >= 2; k -= 2) plate.append(sv("use", { href: "#sa", class: "land-wall", "data-k": k }));
    plate.append(sv("use", { href: "#sa", class: "land-top", "data-k": 0 }));
    dyn = sv("g", {});
    svg.replaceChildren(defs, plate, dyn);
  }
  function placeScene() {
    const m = matrix().map(v => v.toFixed(5)).join(",");
    for (const n of plate.children) n.setAttribute("transform", `translate(0,${n.dataset.k}) matrix(${m})`);
  }

  // ---------------------------------------------------------------- bars
  function bar(x, y, h, w, color) {
    const dx = w * 0.5, dy = w * 0.3, top = y - h;
    const g = sv("g", {});
    g.append(
      sv("polygon", { class: "front", points: `${x - w / 2},${y} ${x + w / 2},${y} ${x + w / 2},${top} ${x - w / 2},${top}`, fill: color }),
      sv("polygon", { points: `${x + w / 2},${y} ${x + w / 2 + dx},${y - dy} ${x + w / 2 + dx},${top - dy} ${x + w / 2},${top}`, fill: shade(color, -0.25) }),
      sv("polygon", { points: `${x - w / 2},${top} ${x + w / 2},${top} ${x + w / 2 + dx},${top - dy} ${x - w / 2 + dx},${top - dy}`, fill: shade(color, 0.3) }));
    return g;
  }

  // ---------------------------------------------------------------- labels
  // Labels avoid each other, every bar, the header and the footer. A label first tries the spot
  // above its own bar, then higher up, then beside the bar, then further out; when it ends up away
  // from its bar a thin leader line connects them.
  const chromeTop = () => Math.ceil(document.querySelector("header.top").getBoundingClientRect().bottom) + 6;
  const chromeBottom = () => Math.floor(document.querySelector("footer.bottom").getBoundingClientRect().top) - 6;
  let placed = [], obstacles = [];
  const overlaps = (a, b) => a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1];
  let leaders = null;
  function label(bx, btop, bw, title, value) {
    const fs = small() ? 11.5 : 13.5, lh = fs * 1.15;
    const w = Math.max(title.length * fs * 0.56, value.length * fs * 0.5) + 6, h = lh * 2 + 2;
    const minY = chromeTop(), maxY = chromeBottom(), cx = bx + bw * 0.25;
    const cands = [[cx - w / 2, btop - h - 4]];
    for (let i = 1; i <= 6; i++) cands.push([cx - w / 2, btop - h - 4 - i * (h + 3)]);
    for (const dy of [0, -h, h, -2 * h, 2 * h]) cands.push([bx + bw + 6, btop + dy], [bx - bw / 2 - w - 6, btop + dy]);
    for (let i = 1; i <= 8; i++) for (const dy of [-h - 4, 0, -2 * h]) cands.push([cx - w / 2 + i * (w * 0.6), btop + dy], [cx - w / 2 - i * (w * 0.6), btop + dy]);
    const fits = r => r[0] >= 6 && r[0] + r[2] <= W() - 6 && r[1] >= minY && r[1] + r[3] <= maxY;
    const free = r => !placed.some(p => overlaps(r, p)) && !obstacles.some(o => overlaps(r, o));
    let best = null;
    for (const [x, y] of cands) { const r = [x, y, w, h]; if (fits(r) && free(r)) { best = r; break; } }
    if (!best) {                                                       // nothing free: least crowded spot on screen
      best = cands.map(([x, y]) => [Math.max(6, Math.min(W() - w - 6, x)), Math.max(minY, Math.min(maxY - h, y)), w, h])
        .map(r => [r, placed.filter(p => overlaps(r, p)).length * 3 + obstacles.filter(o => overlaps(r, o)).length])
        .sort((a, b) => a[1] - b[1])[0][0];
    }
    placed.push(best);
    const g = sv("g", { "pointer-events": "none" });
    const [lx, ly] = best, mid = lx + w / 2;
    const far = Math.hypot(mid - cx, ly + h - (btop - 4)) > h * 0.9;
    if (far) {
      const ex = Math.max(lx, Math.min(lx + w, cx)), ey = ly + h < btop ? ly + h : (ly > btop ? ly : ly + h / 2);
      leaders.append(sv("line", { x1: cx, y1: btop - 2, x2: ex, y2: ey, stroke: "var(--muted)", "stroke-width": 1 }));
    }
    g.append(sv("text", { class: "lbl", x: mid, y: ly + lh - 2, "text-anchor": "middle", "font-size": fs },
      title, sv("tspan", { class: "v", x: mid, dy: lh, "font-size": fs * 0.88 }, value)));
    return g;
  }

  function interactive(g, tip, onClick, aria) {
    Object.entries({ tabindex: 0, role: onClick ? "button" : "img", "aria-label": aria, class: "bar" }).forEach(([k, v]) => g.setAttribute(k, v));
    g.addEventListener("pointermove", e => { if (e.pointerType === "mouse") U.showTip($("tip"), e, tip()); });
    g.addEventListener("pointerleave", () => { $("tip").hidden = true; });
    g.addEventListener("focus", () => { const r = g.getBoundingClientRect(); U.showTip($("tip"), { clientX: r.right, clientY: r.top }, tip()); });
    g.addEventListener("blur", () => { $("tip").hidden = true; });
    g.addEventListener("click", e => onClick ? onClick() : U.showTip($("tip"), e, tip()));
    g.addEventListener("keydown", e => { if (onClick && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onClick(); } });
    return g;
  }

  function draw() {
    dyn.replaceChildren(); placed = []; obstacles = [];
    const items = [], labels = [];
    const add = (x, y, h, w) => obstacles.push([x - w / 2 - 2, y - h - w * 0.3 - 2, w * 1.5 + 4, h + w * 0.3 + 4]);
    const k = small() ? 0.7 : 1;
    if (!state.view) {
      const max = Math.max(1, ...M.sites.map(m => U.siteFigures(m.code).oil));
      for (const m of M.sites) {
        const [x, y] = project(m.lat, m.lon), st = U.siteStatus(m.code).level, oil = U.siteFigures(m.code).oil;
        const h = (24 + 150 * Math.sqrt(oil / max)) * k;
        const bw = small() ? 9 : 13;
        const g = interactive(bar(x, y, h, bw, COLOR[st]), () => U.briefSite(m.code, "Click to see the wells"), () => openSite(m.code), `${m.name}, ${LEVEL[st].label}, ${fmt(oil)} barrels of oil per day`);
        items.push([y, g]); add(x, y, h, bw); labels.push([y, x, y - h - bw * 0.3, bw, m.name, `${fmt(oil)} bbl/d`]);
      }
    } else {
      const m = SITES[state.view], s = state.data.sites[state.view];
      const [rx, ry] = project(m.lat, m.lon);
      const flows = sv("g", { "aria-hidden": "true" });
      m.wells.forEach(w => { const [x, y] = project(w.lat, w.lon); flows.append(sv("line", { class: "flow", x1: x, y1: y, x2: rx, y2: ry })); });
      dyn.append(flows);
      const max = Math.max(1, ...m.wells.map(w => s.wells[w.id].oil || 0));
      for (const w of m.wells) {
        const [x, y] = project(w.lat, w.lon), v = s.wells[w.id], lv = WELL_LEVEL[v.status] || "planned";
        const h = (10 + 120 * Math.sqrt((v.oil || 0) / max)) * k;
        const bw = small() ? 8 : 11;
        items.push([y, interactive(bar(x, y, h, bw, COLOR[lv]), () => U.briefWell(state.view, w.id), null, `${w.name}, ${v.status}`)]);
        add(x, y, h, bw); labels.push([y, x, y - h - bw * 0.3, bw, w.name, `${fmt(v.oil)} bbl/d`]);
      }
      const st = U.siteStatus(state.view).level, f = U.siteFigures(state.view);
      const rw = small() ? 13 : 18;
      items.push([ry, interactive(bar(rx, ry, 150 * k, rw, COLOR[st]), () => U.briefRefinery(state.view), null, `${m.name} refinery, ${LEVEL[st].label}`)]);
      add(rx, ry, 150 * k, rw); labels.push([ry, rx, ry - 150 * k - rw * 0.3, rw, "Refinery", `${fmt(f.thru)} bbl/d`]);
    }
    items.sort((a, b) => a[0] - b[0]).forEach(([, g]) => dyn.append(g));
    const lg = sv("g", { "aria-hidden": "true" });
    leaders = sv("g", { "aria-hidden": "true", "pointer-events": "none" });   // lines under all label text
    // tallest bars first: they have the least room above them
    labels.sort((a, b) => a[2] - b[2]).forEach(([, x, top, bw, t, v]) => lg.append(label(x, top, bw, t, v)));
    dyn.append(leaders, lg);
  }

  // ---------------------------------------------------------------- chrome
  function renderChrome() {
    const t = $("title"); t.replaceChildren();
    const pv = $("pv"), url = U.piVisionUrl(state.view);
    if (state.view) {
      const m = SITES[state.view], f = U.siteFigures(state.view), st = U.siteStatus(state.view);
      t.append(el("button", { type: "button", onclick: closeSite }, "← All sites"), el("h1", {}, `${m.name}, ${m.country}`),
        el("p", {}, el("b", {}, `${fmt(f.oil)} bbl/d`), ` oil · ${f.producing} of ${f.wells} wells producing · ${LEVEL[st.level].label}`));
    } else {
      const T = U.totals(), flagged = T.levels.warning + T.levels.critical;
      t.append(el("h1", {}, "Cordillera Petróleo"),
        el("p", {}, el("b", {}, `${fmt(T.oil)} bbl/d`), ` oil · ${flagged ? `${flagged} of ${M.sites.length} sites need attention` : "all sites normal"}`));
    }
    pv.hidden = !url; if (url) pv.href = url;
    const lg = $("legend"); lg.replaceChildren();
    const item = (l, txt) => el("span", {}, icon(l), txt);
    lg.append(item("good", state.view ? "Producing" : "Normal"), item("warning", state.view ? "Starting up" : "Watch"),
      item("critical", state.view ? "Tripped" : "Alert"), ...(state.view ? [item("planned", "Stopped")] : []));
    $("asof").textContent = U.asOfText();
  }

  // ---------------------------------------------------------------- navigation
  function fit(lat0, lon0, lat1, lon1, fill) {
    const [x0, y0] = toMerc(lat1, lon0), [x1, y1] = toMerc(lat0, lon1);
    const w = Math.abs(x1 - x0) + Math.abs(y1 - y0) * SHEAR, h = Math.abs(y1 - y0) * TILT;
    // headroom for the tallest bars and their labels above the northern sites
    const top = chromeTop() + (state.view ? 40 : (small() ? 150 : 200)), bottom = H() - chromeBottom() + 10;
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, s: Math.min(W() * fill / w, (H() - top - bottom) * fill / h) };
  }
  const continent = () => fit(-55, -81, 12, -35, small() ? 0.98 : 0.86);
  function siteView(code) {
    const m = SITES[code], lats = [m.lat, ...m.wells.map(w => w.lat)], lons = [m.lon, ...m.wells.map(w => w.lon)];
    const v = fit(Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons), small() ? 0.7 : 0.55);
    v.cy -= (Math.max(...lats) - Math.min(...lats)) * 0.15;      // leave room above for the tallest bars
    return v;
  }
  function animateTo(target) {
    cancelAnimationFrame(anim);
    const from = { ...view }, t0 = performance.now();
    const dur = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 1000;
    const step = now => {
      const p = dur ? Math.min(1, (now - t0) / dur) : 1, e = p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      view.s = Math.exp(Math.log(from.s) + (Math.log(target.s) - Math.log(from.s)) * e);
      view.cx = from.cx + (target.cx - from.cx) * e; view.cy = from.cy + (target.cy - from.cy) * e;
      placeScene(); draw();
      if (p < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }
  function openSite(code) {
    state.view = code; $("tip").hidden = true;
    try { history.replaceState(null, "", `#${code}`); } catch (_) { /* sandboxed */ }
    renderChrome(); animateTo(siteView(code));
  }
  function closeSite() {
    state.view = null; $("tip").hidden = true;
    try { history.replaceState(null, "", location.pathname + location.search); } catch (_) { /* sandboxed */ }
    renderChrome(); animateTo(continent());
  }

  async function main() {
    try { await U.load(); } catch (e) { $("asof").textContent = `Could not load data: ${e.message}`; return; }
    buildScene();
    U.designSwitcher($("designs"), "map3d.html");
    const start = location.hash.slice(1);
    state.view = SITES[start] ? start : null;
    renderChrome();
    Object.assign(view, state.view ? siteView(state.view) : continent());
    placeScene(); draw();
    window.addEventListener("resize", () => { Object.assign(view, state.view ? siteView(state.view) : continent()); placeScene(); draw(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && state.view) closeSite(); });
    window.addEventListener("hashchange", () => { const c = location.hash.slice(1); if (SITES[c] && c !== state.view) openSite(c); else if (!c && state.view) closeSite(); });
    U.autoRefresh(() => { draw(); renderChrome(); });
  }
  main();
})();
