// Design: Topo. Paper contour map with oil production drawn live as colored contour bands.
(function () {
  "use strict";
  const U = window.CP_UI, { M, SITES, state, el, sv, fmt, LEVEL, WELL_LEVEL } = U;
  const R = window.CP_RELIEF;
  const $ = id => document.getElementById(id);
  const canvas = $("base"), over = $("over"), labels = $("labels");

  // heat bands, low to high; each band is laid over the one below it like stacked tracing paper
  const BANDS = ["#5ac8dc", "#5ad2aa", "#bedc5a", "#fac83c", "#f58c32", "#dc3c32"];
  const OUTLINE = [40, 40, 60];
  const STOPPED = new Set(["Shut-In", "Workover"]);

  const W = () => window.innerWidth, H = () => window.innerHeight;
  const small = () => W() <= 640;

  // ---------------------------------------------------------------- projection
  const gx = (lon, z) => (lon + 180) / 360 * 2 ** z * 256;
  const gy = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z * 256; };
  let rel = null, frame = { s: 1, ox: 0, oy: 0 };
  const project = (lat, lon) => [frame.ox + (gx(lon, rel.z) - rel.x0) * frame.s, frame.oy + (gy(lat, rel.z) - rel.y0) * frame.s];

  const rectOf = n => { const r = n.getBoundingClientRect(); return r.width ? [r.left - 6, r.top - 6, r.width + 12, r.height + 12] : null; };
  const chromeTop = () => Math.ceil(document.querySelector("header.top").getBoundingClientRect().bottom) + 10;
  const chromeBottom = () => Math.floor(document.querySelector("footer.bottom").getBoundingClientRect().top) - 10;

  function fitContinent() {
    const aspect = rel.w / rel.h;
    // wide screens: full height, the header sits beside the map; otherwise between header and footer
    const fullH = H() - 48, fullW = fullH * aspect;
    const side = Math.max(document.querySelector(".title").offsetWidth, $("legend").offsetWidth) + 64;
    let box;
    if ((W() - fullW) / 2 >= side) box = [(W() - fullW) / 2, 24, fullW, fullH];
    else {
      const top = chromeTop(), h = Math.max(200, chromeBottom() - top), w = Math.min(W() - 16, h * aspect);
      box = [(W() - w) / 2, top + (h - w / aspect) / 2, w, w / aspect];
    }
    frame = { s: box[2] / rel.w, ox: box[0], oy: box[1] };
  }

  function fitSite(code) {
    const m = SITES[code], pts = [m, ...m.wells];
    const xs = pts.map(p => gx(p.lon, rel.z) - rel.x0), ys = pts.map(p => gy(p.lat, rel.z) - rel.y0);
    const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
    const top = chromeTop() + 20, bottom = chromeBottom() - 30, fw = W() - (small() ? 80 : 360), fh = bottom - top;
    // fit the wells into the free area, but never so small that the map stops covering the screen
    const s = Math.max(Math.min(fw / (bx1 - bx0 || 1), fh / (by1 - by0 || 1)) * 0.78, W() / rel.w, H() / rel.h);
    let ox = W() / 2 - (bx0 + bx1) / 2 * s, oy = (top + bottom) / 2 - (by0 + by1) / 2 * s;
    ox = Math.min(0, Math.max(W() - rel.w * s, ox)); oy = Math.min(0, Math.max(H() - rel.h * s, oy));
    frame = { s, ox, oy };
  }

  // ---------------------------------------------------------------- base map + heat
  const images = {};
  function image(src) {
    if (!images[src]) images[src] = new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => fail(new Error(`can't load ${src}`)); i.src = src; });
    return images[src];
  }

  const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  // band L over the paper = paper * 0.45^L + colour stack; as one RGBA per band
  const BAND_RGBA = (() => {
    let k = 1, q = [0, 0, 0];
    return BANDS.map(h => {
      const c = rgb(h); k *= 0.45; q = q.map((v, i) => v * 0.45 + c[i] * 0.55);
      const a = 1 - k, col = q.map(v => v / a);
      const oa = 0.7 + a * 0.3, oc = col.map((v, i) => (OUTLINE[i] * 0.7 + v * a * 0.3) / oa);
      return { fill: [...col, a * 255], line: [...oc, oa * 255] };
    });
  })();

  // sum of gaussians (each pt: [x, y, weight]) on a grid with `g` screen px per cell, normalized to 0..1
  function field(cw, ch, g, pts, sigma) {
    const f = new Float32Array(cw * ch), sg = sigma / g, r = Math.ceil(sg * 3), k = -1 / (2 * sg * sg);
    for (const [x, y, wt] of pts) {
      const cx = x / g, cy = y / g;
      const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(cw - 1, Math.ceil(cx + r));
      const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(ch - 1, Math.ceil(cy + r));
      for (let j = y0; j <= y1; j++) {
        const dy2 = (j - cy) ** 2, row = j * cw;
        for (let i = x0; i <= x1; i++) f[row + i] += wt * Math.exp(((i - cx) ** 2 + dy2) * k);
      }
    }
    let mx = 0; for (let i = 0; i < f.length; i++) if (f[i] > mx) mx = f[i];
    if (mx > 0) for (let i = 0; i < f.length; i++) f[i] /= mx;
    return f;
  }

  function heatLayer(cw, ch, g) {
    let f;
    if (!state.view) {
      const pts = M.sites.map(m => [...project(m.lat, m.lon), U.siteFigures(m.code).oil]);
      const mx = Math.max(1, ...pts.map(p => p[2]));
      const wide = field(cw, ch, g, pts.map(([x, y, o]) => [x, y, 0.35 + 0.65 * Math.sqrt(o / mx)]), Math.max(60, 120 * frame.s));
      const tight = field(cw, ch, g, pts.map(([x, y, o]) => [x, y, Math.sqrt(o / mx)]), Math.max(15, 18 * frame.s));
      f = wide.map((v, i) => Math.min(1, 0.18 * v + 0.9 * tight[i]));
    } else {
      const m = SITES[state.view], s = state.data.sites[state.view];
      const mx = Math.max(1, ...m.wells.map(w => s.wells[w.id].oil || 0));
      const pts = m.wells.map(w => [...project(w.lat, w.lon), 0.15 + Math.sqrt((s.wells[w.id].oil || 0) / mx)]);
      pts.push([...project(m.lat, m.lon), 1.2]);
      f = field(cw, ch, g, pts, 55 * frame.s);
    }
    const lv = new Uint8Array(f.length);
    for (let i = 0; i < f.length; i++) lv[i] = Math.floor(Math.min(f[i], 0.999) * 7);
    const img = new ImageData(cw, ch), d = img.data;
    for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
      const n = j * cw + i, l = lv[n];
      if (!l) continue;
      const edge = (i > 0 && lv[n - 1] !== l) || (j > 0 && lv[n - cw] !== l) || (i < cw - 1 && lv[n + 1] < l) || (j < ch - 1 && lv[n + cw] < l);
      const c = edge ? BAND_RGBA[l - 1].line : BAND_RGBA[l - 1].fill;
      d[n * 4] = c[0]; d[n * 4 + 1] = c[1]; d[n * 4 + 2] = c[2]; d[n * 4 + 3] = c[3];
    }
    return img;
  }

  async function paint() {
    const base = await image(rel.img);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W() * dpr); canvas.height = Math.round(H() * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
    ctx.fillRect(0, 0, W(), H());
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(base, frame.ox, frame.oy, rel.w * frame.s, rel.h * frame.s);
    const heat = heatLayer(canvas.width, canvas.height, 1 / dpr);
    const tmp = document.createElement("canvas"); tmp.width = heat.width; tmp.height = heat.height;
    tmp.getContext("2d").putImageData(heat, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(tmp, 0, 0);
  }

  // ---------------------------------------------------------------- labels
  // Each label tries the spot right of its point, then left, then rows above and below, then
  // further out. It avoids other labels, every point, the header and the footer; a thin
  // leader line connects it to its point.
  const overlaps = (a, b) => a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1];
  function placeAll(items, gap) {
    const chrome = [...document.querySelectorAll(".title > *, #pv, #legend, #designs, #asof")].map(rectOf).filter(Boolean);
    const dots = items.map(it => [it.x - 7, it.y - 7, 14, 14]);
    const placed = [];
    const fits = r => r[0] >= 6 && r[0] + r[2] <= W() - 6 && r[1] >= 6 && r[1] + r[3] <= H() - 6;
    const cost = r => placed.filter(p => overlaps(r, p)).length * 4 + chrome.filter(c => overlaps(r, c)).length * 3 + dots.filter(d => overlaps(r, d)).length;
    // the most crowded points first: they have the fewest good spots
    const crowd = it => items.filter(o => Math.hypot(o.x - it.x, o.y - it.y) < 120).length;
    for (const it of [...items].sort((a, b) => crowd(b) - crowd(a) || a.y - b.y)) {
      const { x, y, w, h } = it, cands = [];
      for (const g of [gap, gap + 30, gap + 70, gap + 120]) {
        for (const dy of [0, -1, 1, -2, 2, -3, 3]) {
          const yy = y - h / 2 + dy * (h + 4);
          cands.push([x + g, yy], [x - g - w, yy]);
        }
      }
      for (const dy of [-1, 1]) cands.push([x - w / 2, dy < 0 ? y - gap - h : y + gap]);
      let best = null;
      for (const [cx, cy] of cands) { const r = [cx, cy, w, h]; if (fits(r) && !cost(r)) { best = r; break; } }
      if (!best) best = cands.map(([cx, cy]) => [Math.max(6, Math.min(W() - w - 6, cx)), Math.max(6, Math.min(H() - h - 6, cy)), w, h])
        .map(r => [r, cost(r)]).sort((a, b) => a[1] - b[1])[0][0];
      placed.push(best);
      it.node.style.left = `${best[0]}px`; it.node.style.top = `${best[1]}px`;
      // leader from the point to the nearest edge of the label
      const ex = Math.max(best[0], Math.min(best[0] + w, x)), ey = Math.max(best[1], Math.min(best[1] + h, y));
      if (Math.hypot(ex - x, ey - y) > 7) it.lead = [x, y, ex, ey];
    }
  }

  function flag(level) {
    if (level === "warning") return sv("svg", { viewBox: "0 0 12 11", class: "flag", role: "img", "aria-label": "Watch" }, sv("path", { d: "M6 .5 11.5 10.5H.5Z", fill: "var(--watch)" }));
    if (level === "critical") return sv("svg", { viewBox: "0 0 11 11", class: "flag", role: "img", "aria-label": "Alert" }, sv("rect", { x: .5, y: .5, width: 10, height: 10, rx: 1.5, fill: "var(--alert)" }));
    return null;
  }

  const tip = $("tip");
  function hover(node, content) {
    node.addEventListener("pointermove", e => { if (e.pointerType === "mouse") U.showTip(tip, e, content()); });
    node.addEventListener("pointerleave", () => { tip.hidden = true; });
    node.addEventListener("focus", () => { const r = node.getBoundingClientRect(); U.showTip(tip, { clientX: r.right, clientY: r.top }, content()); });
    node.addEventListener("blur", () => { tip.hidden = true; });
  }

  function drawMarks() {
    labels.replaceChildren(); over.replaceChildren(); tip.hidden = true;
    const items = [], dots = sv("g", {});
    const r = small() ? 4 : 5;
    if (!state.view) {
      for (const m of M.sites) {
        const [x, y] = project(m.lat, m.lon), oil = U.siteFigures(m.code).oil, st = U.siteStatus(m.code).level;
        const node = el("button", { type: "button", class: "chip", onclick: () => openSite(m.code),
          "aria-label": `${m.name}, ${LEVEL[st].label}, ${fmt(oil)} barrels of oil per day. Open site.` },
          el("span", { class: "n" }, flag(st), m.name), el("span", { class: "v" }, fmt(oil), el("small", {}, " bbl/d")));
        hover(node, () => U.briefSite(m.code, "Click to see the wells"));
        labels.append(node);
        dots.append(sv("circle", { cx: x, cy: y, r: r - 1, fill: "var(--ink)", stroke: "#fff", "stroke-width": 1.5 }));
        items.push({ x, y, node });
      }
    } else {
      const m = SITES[state.view], s = state.data.sites[state.view];
      for (const w of m.wells) {
        const [x, y] = project(w.lat, w.lon), v = s.wells[w.id];
        const stopped = STOPPED.has(v.status), lv = WELL_LEVEL[v.status] || "planned";
        const fill = stopped ? "#fff" : lv === "critical" ? "var(--alert)" : lv === "warning" ? "var(--watch)" : "var(--ink)";
        const dot = sv("circle", { cx: x, cy: y, r, fill, stroke: stopped ? "var(--ink)" : "#fff", "stroke-width": stopped ? 1.5 : 2, class: "dot",
          tabindex: 0, role: "img", "aria-label": `${w.name}, ${v.status}, ${fmt(v.oil)} barrels of oil per day` });
        hover(dot, () => U.briefWell(state.view, w.id));
        dot.addEventListener("click", e => U.showTip(tip, e, U.briefWell(state.view, w.id)));
        dots.append(dot);
        const value = stopped ? "stopped" : lv === "critical" ? "tripped" : `${fmt(v.oil)} bbl/d`;
        const node = el("div", { class: "tag" }, el("div", { class: "n" }, w.name), el("div", { class: `v${lv === "critical" ? " bad" : ""}` }, value));
        hover(node, () => U.briefWell(state.view, w.id));
        node.addEventListener("click", e => U.showTip(tip, e, U.briefWell(state.view, w.id)));
        labels.append(node); items.push({ x, y, node });
      }
      const [x, y] = project(m.lat, m.lon), q = small() ? 14 : 16, f = U.siteFigures(state.view);
      const ref = sv("rect", { x: x - q / 2, y: y - q / 2, width: q, height: q, fill: "var(--ink)", stroke: "#fff", "stroke-width": 2, class: "dot",
        tabindex: 0, role: "img", "aria-label": `${m.name} refinery, ${fmt(f.thru)} barrels per day processed` });
      hover(ref, () => U.briefRefinery(state.view));
      ref.addEventListener("click", e => U.showTip(tip, e, U.briefRefinery(state.view)));
      dots.append(ref);
      const node = el("div", { class: "tag ref" }, el("div", { class: "n" }, "Refinery"), el("div", { class: "v" }, `${fmt(f.thru)} bbl/d`));
      hover(node, () => U.briefRefinery(state.view));
      labels.append(node); items.push({ x, y, node });
    }
    for (const it of items) { it.w = it.node.offsetWidth; it.h = it.node.offsetHeight; }
    placeAll(items, state.view ? 9 : (small() ? 12 : 18));
    const leads = sv("g", { "aria-hidden": "true" });
    for (const it of items) if (it.lead && (!state.view || Math.hypot(it.lead[2] - it.lead[0], it.lead[3] - it.lead[1]) > 16)) {
      const [x1, y1, x2, y2] = it.lead;
      leads.append(sv("line", { class: "lead", x1, y1, x2, y2 }));
    }
    over.append(leads, dots);
  }

  // ---------------------------------------------------------------- chrome
  const back = () => el("button", { type: "button", onclick: closeSite },
    sv("svg", { width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": "true" }, sv("path", { d: "M9 3 5 7l4 4", stroke: "currentColor", "stroke-width": 1.6, fill: "none", "stroke-linecap": "round" })), "All sites");

  function renderChrome() {
    const t = $("title"); t.replaceChildren();
    document.body.classList.toggle("site", !!state.view);
    if (state.view) {
      const m = SITES[state.view], f = U.siteFigures(state.view);
      t.append(back(), el("h1", {}, `${m.name}, ${m.country}`),
        el("p", {}, el("b", {}, `${fmt(f.oil)} bbl/d`), ` oil · ${f.producing} of ${f.wells} wells producing`));
    } else {
      const T = U.totals(), flagged = T.levels.warning + T.levels.critical;
      t.append(el("h1", {}, "Cordillera Petróleo"),
        el("p", {}, el("b", {}, `${fmt(T.oil)} bbl/d`), ` oil · ${flagged ? `${flagged} of ${M.sites.length} sites need attention` : "all sites normal"}`));
    }
    const pv = $("pv"), url = U.piVisionUrl(state.view);
    pv.hidden = !url; if (url) pv.href = url;

    const lg = $("legend"); lg.replaceChildren();
    lg.title = state.view ? "Relative to the busiest well at this site" : "Relative to the busiest site";
    lg.append(el("div", { class: "h" }, state.view ? "Oil rate" : "Oil production"),
      el("div", { class: "sw" }, BANDS.map(c => el("span", { style: `background:${c}` }))),
      el("div", { class: "ends" }, el("span", {}, "Low"), el("span", {}, "High")));
    const keys = el("div", { class: "keys" });
    if (state.view) keys.append(el("span", {}, el("i", {}), "Producing"), el("span", {}, el("i", { class: "off" }), "Stopped"));
    else {
      const T = U.totals();
      if (T.levels.warning) keys.append(el("span", {}, flag("warning"), "Watch"));
      if (T.levels.critical) keys.append(el("span", {}, flag("critical"), "Alert"));
    }
    if (keys.childNodes.length) lg.append(keys);
    $("asof").textContent = U.asOfText();
    const hdr = document.querySelector("header.top").getBoundingClientRect(), ftr = document.querySelector("footer.bottom").getBoundingClientRect();
    document.body.style.setProperty("--fade-top", `${Math.ceil(hdr.bottom + 40)}px`);
    document.body.style.setProperty("--fade-bottom", `${Math.ceil(H() - ftr.top + 30)}px`);
  }

  // ---------------------------------------------------------------- views
  let busy = 0;
  async function render() {
    const my = ++busy;
    rel = state.view ? R.sites[state.view] : R.continent;
    renderChrome();
    state.view ? fitSite(state.view) : fitContinent();
    try { await paint(); } catch (e) { $("asof").textContent = `Could not draw the map: ${e.message}`; }
    if (my !== busy) return;
    drawMarks();
  }

  async function switchTo(code) {
    state.view = code; tip.hidden = true;
    try { history.replaceState(null, "", code ? `#${code}` : location.pathname + location.search); } catch (_) { /* sandboxed */ }
    const map = $("map"), reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduce) { map.classList.add("out"); await new Promise(r => setTimeout(r, 220)); }
    if (code) image(R.sites[code].img).catch(() => {});
    await render();
    map.classList.remove("out");
  }
  const openSite = code => switchTo(code);
  const closeSite = () => switchTo(null);

  async function main() {
    try { await U.load(); } catch (e) { $("asof").textContent = `Could not load data: ${e.message}`; return; }
    U.designSwitcher($("designs"), "topo.html");
    const start = location.hash.slice(1);
    state.view = SITES[start] ? start : null;
    await render();
    let t;
    window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(render, 120); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && state.view) closeSite(); });
    document.addEventListener("pointerdown", e => { if (e.pointerType !== "mouse" && !e.target.closest(".dot, .tag")) tip.hidden = true; });
    window.addEventListener("hashchange", () => { const c = location.hash.slice(1); if (SITES[c] && c !== state.view) openSite(c); else if (!c && state.view) closeSite(); });
    U.autoRefresh(render);
  }
  main();
})();
