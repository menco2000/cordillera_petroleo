// Design: Topo. Contour map with oil production drawn live as contour bands, in the Signal design
// system: production on the blue sequential scale, problems in orange with a word, the site or well
// you point at in the highlight blue (on the map and in the ranked list at once).
(function () {
  "use strict";
  const U = window.CP_UI, { M, SITES, CFG, state, el, sv, fmt, LEVEL, WELL_LEVEL } = U;
  const R = window.CP_RELIEF;
  const $ = id => document.getElementById(id);
  const stage = $("stage"), canvas = $("base"), over = $("over"), labels = $("labels");

  // Signal sequential scale seq-1 … seq-5, low to high
  const BANDS = ["#e8effd", "#b7cbf7", "#7a9ff0", "#3a6fe3", "#0a2f8a"];
  const MARK = { good: "#0f1b2d", warning: "#eaa56a", critical: "#c2410c" };
  const STOPPED = new Set(["Shut-In", "Workover"]);

  const W = () => stage.clientWidth, H = () => stage.clientHeight;
  const small = () => window.innerWidth <= 700;

  // ---------------------------------------------------------------- projection
  const gx = (lon, z) => (lon + 180) / 360 * 2 ** z * 256;
  const gy = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z * 256; };
  let rel = null, frame = { s: 1, ox: 0, oy: 0 };
  const project = (lat, lon) => [frame.ox + (gx(lon, rel.z) - rel.x0) * frame.s, frame.oy + (gy(lat, rel.z) - rel.y0) * frame.s];

  // the whole continent inside the map area
  function fitContinent() {
    const pad = small() ? 12 : 28, aspect = rel.w / rel.h;
    let h = H() - 2 * pad, w = h * aspect;
    if (w > W() - 2 * pad) { w = W() - 2 * pad; h = w / aspect; }
    frame = { s: w / rel.w, ox: (W() - w) / 2, oy: (H() - h) / 2 };
  }

  // the site's wells fill most of the map area; the terrain always covers it
  function fitSite(code) {
    const m = SITES[code], pts = [m, ...m.wells];
    const xs = pts.map(p => gx(p.lon, rel.z) - rel.x0), ys = pts.map(p => gy(p.lat, rel.z) - rel.y0);
    const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
    const fw = W() - (small() ? 90 : 260), fh = H() - (small() ? 90 : 140);
    const s = Math.max(Math.min(fw / (bx1 - bx0 || 1), fh / (by1 - by0 || 1)) * 0.8, W() / rel.w, H() / rel.h);
    let ox = W() / 2 - (bx0 + bx1) / 2 * s, oy = H() / 2 - (by0 + by1) / 2 * s;
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
  // flat bands (no gradients); each band outlined in a darker step of its own colour
  const BAND_RGBA = BANDS.map(h => {
    const c = rgb(h), line = c.map(v => Math.round(v * 0.72 + 15 * 0.28));
    return { fill: [...c, 0.82 * 255], line: [...line, 0.9 * 255] };
  });

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
    const n = BANDS.length, lv = new Uint8Array(f.length);
    for (let i = 0; i < f.length; i++) lv[i] = Math.floor(Math.min(f[i], 0.999) * (n + 1));
    const img = new ImageData(cw, ch), d = img.data;
    for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
      const k = j * cw + i, l = lv[k];
      if (!l) continue;
      const edge = (i > 0 && lv[k - 1] < l) || (j > 0 && lv[k - cw] < l) || (i < cw - 1 && lv[k + 1] < l) || (j < ch - 1 && lv[k + cw] < l);
      const c = edge ? BAND_RGBA[l - 1].line : BAND_RGBA[l - 1].fill;
      d[k * 4] = c[0]; d[k * 4 + 1] = c[1]; d[k * 4 + 2] = c[2]; d[k * 4 + 3] = c[3];
    }
    return img;
  }

  async function paint() {
    const base = await image(rel.img);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W() * dpr); canvas.height = Math.round(H() * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#ffffff";
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
  // further out. It avoids other labels and every point, and stays inside the map; a thin leader
  // line connects it to its point.
  const overlaps = (a, b) => a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1];
  function placeAll(items, gap) {
    const dots = items.map(it => [it.x - 7, it.y - 7, 14, 14]);
    const placed = [];
    const fits = r => r[0] >= 6 && r[0] + r[2] <= W() - 6 && r[1] >= 6 && r[1] + r[3] <= H() - 6;
    const cost = r => placed.filter(p => overlaps(r, p)).length * 4 + dots.filter(d => overlaps(r, d)).length;
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

  // status in words (Signal: never colour alone)
  const siteWord = code => { const st = U.siteStatus(code); return st.level === "good" ? null : { cls: st.level === "critical" ? "" : "watch", text: LEVEL[st.level].label, reason: st.reasons[0] }; };
  const wellWord = v => v.status === "Tripped" ? { cls: "bad", text: "Tripped" } : v.status === "Starting Up" ? { cls: "watch", text: "Starting up" }
    : STOPPED.has(v.status) ? { cls: "off", text: v.status === "Shut-In" ? "Shut in" : "Workover" } : null;

  const tip = $("tip");
  function hover(node, key, content) {
    node.addEventListener("pointerenter", () => hl(key));
    node.addEventListener("pointermove", e => { if (e.pointerType === "mouse") U.showTip(tip, e, content()); });
    node.addEventListener("pointerleave", () => { tip.hidden = true; hl(null); });
    node.addEventListener("focus", () => { hl(key); const r = node.getBoundingClientRect(); U.showTip(tip, { clientX: r.right, clientY: r.top }, content()); });
    node.addEventListener("blur", () => { tip.hidden = true; hl(null); });
  }
  // one highlight at a time: the same site / well on the map and in the list
  function hl(key) {
    for (const n of document.querySelectorAll(".hl")) n.classList.remove("hl");
    if (key) for (const n of document.querySelectorAll(`[data-k="${CSS.escape(key)}"]`)) n.classList.add("hl");
  }

  function drawMarks() {
    labels.replaceChildren(); over.replaceChildren(); tip.hidden = true;
    const items = [], dots = sv("g", {});
    const r = small() ? 4 : 5;
    if (!state.view) {
      for (const m of M.sites) {
        const [x, y] = project(m.lat, m.lon), oil = U.siteFigures(m.code).oil, st = U.siteStatus(m.code).level, word = siteWord(m.code);
        const node = el("button", { type: "button", class: "chip", "data-k": m.code, onclick: () => openSite(m.code),
          "aria-label": `${m.name}, ${LEVEL[st].label}, ${fmt(oil)} barrels of oil per day. Open site.` },
          el("span", { class: "n" }, m.name), el("span", { class: "v" }, fmt(oil), el("small", {}, " bbl/d")),
          word ? el("span", { class: `why ${word.cls}` }, word.text) : null);
        hover(node, m.code, () => U.briefSite(m.code, "Click to see the wells"));
        labels.append(node);
        dots.append(sv("circle", { cx: x, cy: y, r: word ? r : r - 1, fill: MARK[st] || MARK.good, stroke: "#fff", "stroke-width": 1.5, "data-k": m.code, class: "dot" }));
        items.push({ x, y, node, key: m.code });
      }
    } else {
      const m = SITES[state.view], s = state.data.sites[state.view];
      for (const w of m.wells) {
        const [x, y] = project(w.lat, w.lon), v = s.wells[w.id], word = wellWord(v), lv = WELL_LEVEL[v.status] || "planned";
        const stopped = STOPPED.has(v.status);
        const dot = sv("circle", { cx: x, cy: y, r, fill: stopped ? "#fff" : MARK[lv] || MARK.good, stroke: stopped ? "#89929e" : "#fff", "stroke-width": stopped ? 1.5 : 2, class: "dot",
          "data-k": w.id, tabindex: 0, role: "img", "aria-label": `${w.name}, ${v.status}, ${fmt(v.oil)} barrels of oil per day` });
        hover(dot, w.id, () => U.briefWell(state.view, w.id));
        dot.addEventListener("click", e => U.showTip(tip, e, U.briefWell(state.view, w.id)));
        dots.append(dot);
        const node = el("div", { class: "tag", "data-k": w.id }, el("div", { class: "n" }, w.name),
          el("div", { class: `v ${word && word.cls !== "off" ? word.cls : ""}` }, word ? word.text : [fmt(v.oil), el("small", {}, " bbl/d")]));
        hover(node, w.id, () => U.briefWell(state.view, w.id));
        node.addEventListener("click", e => U.showTip(tip, e, U.briefWell(state.view, w.id)));
        labels.append(node); items.push({ x, y, node, key: w.id });
      }
      const [x, y] = project(m.lat, m.lon), q = small() ? 14 : 16, f = U.siteFigures(state.view);
      const ref = sv("rect", { x: x - q / 2, y: y - q / 2, width: q, height: q, fill: "#0f1b2d", stroke: "#fff", "stroke-width": 2, class: "dot",
        "data-k": "REF", tabindex: 0, role: "img", "aria-label": `${m.name} refinery, ${fmt(f.thru)} barrels per day processed` });
      hover(ref, "REF", () => U.briefRefinery(state.view));
      ref.addEventListener("click", e => U.showTip(tip, e, U.briefRefinery(state.view)));
      dots.append(ref);
      const node = el("div", { class: "tag ref", "data-k": "REF" }, el("div", { class: "n" }, "Refinery"), el("div", { class: "v" }, fmt(f.thru), el("small", {}, " bbl/d")));
      hover(node, "REF", () => U.briefRefinery(state.view));
      labels.append(node); items.push({ x, y, node, key: "REF" });
    }
    for (const it of items) { it.w = it.node.offsetWidth; it.h = it.node.offsetHeight; }
    placeAll(items, state.view ? 9 : (small() ? 12 : 18));
    const leads = sv("g", { "aria-hidden": "true" });
    for (const it of items) if (it.lead && (!state.view || Math.hypot(it.lead[2] - it.lead[0], it.lead[3] - it.lead[1]) > 16)) {
      const [x1, y1, x2, y2] = it.lead;
      leads.append(sv("line", { class: "lead", x1, y1, x2, y2, "data-k": it.key }));
    }
    over.append(leads, dots);
  }

  // ---------------------------------------------------------------- pane: ranked list + legend
  function row(key, name, value, unit, frac, word, onclick) {
    const b = el("button", { type: "button", class: `row${word && word.cls === "off" ? " off" : ""}`, "data-k": key, onclick },
      el("span", { class: "nm" }, name), el("span", { class: "val" }, value, unit ? el("small", {}, ` ${unit}`) : null),
      el("span", { class: "bar", "aria-hidden": "true" }, el("i", { style: `width:${Math.max(0, Math.min(100, frac * 100)).toFixed(1)}%` })),
      word && word.cls !== "off" ? el("span", { class: `why ${word.cls}` }, word.reason ? `${word.text}: ${word.reason}` : word.text) : null);
    // the row already carries the numbers: hovering it only highlights the mark on the map
    b.addEventListener("pointerenter", () => hl(key));
    b.addEventListener("pointerleave", () => hl(null));
    b.addEventListener("focus", () => hl(key));
    b.addEventListener("blur", () => hl(null));
    return b;
  }

  function renderList() {
    const list = $("list");
    if (!state.view) {
      const sites = M.sites.map(m => ({ m, oil: U.siteFigures(m.code).oil })).sort((a, b) => b.oil - a.oil);
      const mx = Math.max(1, ...sites.map(s => s.oil));
      $("listTitle").textContent = "Sites"; $("listSub").textContent = "Oil production, bbl/d · highest first";
      list.replaceChildren(...sites.map(({ m, oil }) => row(m.code, m.name, fmt(oil), "", oil / mx, siteWord(m.code), () => openSite(m.code))));
    } else {
      const m = SITES[state.view], s = state.data.sites[state.view];
      const wells = m.wells.map(w => ({ w, v: s.wells[w.id] })).sort((a, b) => (b.v.oil || 0) - (a.v.oil || 0));
      const mx = Math.max(1, ...wells.map(x => x.v.oil || 0));
      $("listTitle").textContent = "Wells"; $("listSub").textContent = "Oil rate, bbl/d · highest first";
      const showTip = (key, fn) => () => {
        const d = over.querySelector(`[data-k="${CSS.escape(key)}"]`);
        if (d) { const r = d.getBoundingClientRect(); U.showTip(tip, { clientX: r.right, clientY: r.top }, fn()); }
      };
      list.replaceChildren(...wells.map(({ w, v }) => {
        const word = wellWord(v);
        return row(w.id, w.name, word && word.cls === "off" ? word.text : fmt(v.oil), word && word.cls === "off" ? "" : "", (v.oil || 0) / mx, word,
          showTip(w.id, () => U.briefWell(state.view, w.id)));
      }));
    }
  }

  function renderLegend() {
    $("ramp").replaceChildren(...BANDS.map(c => el("span", { style: `background:${c}` })));
    $("rampTitle").textContent = state.view ? "Oil rate around each well" : "Oil production around each site";
    $("rampHigh").textContent = state.view ? "High (busiest well)" : "High (busiest site)";
    const key = (cls, text) => el("span", {}, el("i", { class: cls }), text);
    $("keys").replaceChildren(...(state.view
      ? [key("", "Producing well"), key("watch", "Starting up"), key("bad", "Tripped"), key("off", "Shut in / workover"), key("sq", "Refinery")]
      : [key("", "Site, normal"), key("watch", "Watch"), key("bad", "Alert")]));
  }

  // ---------------------------------------------------------------- top bar
  function renderChrome() {
    const sum = $("summary");
    if (state.view) {
      const m = SITES[state.view], f = U.siteFigures(state.view), word = siteWord(state.view);
      $("h1").textContent = `${m.name}, ${m.country}`;
      sum.replaceChildren(el("button", { type: "button", onclick: closeSite, title: "Back to all sites (Esc)" }, "All sites"), " › ",
        `${fmt(f.oil)} bbl/d oil · ${f.producing} of ${f.wells} wells producing · `,
        word ? el("b", {}, word.reason ? `${word.text}: ${word.reason}` : word.text) : "normal");
      $("plant").hidden = false; $("plant").href = `plant.html#${state.view}`;
    } else {
      const T = U.totals(), flagged = T.levels.warning + T.levels.critical;
      $("h1").textContent = "Cordillera Petróleo";
      sum.replaceChildren(`${fmt(T.oil)} bbl/d oil · ${T.producing} of ${T.wells} wells producing · `,
        flagged ? el("b", {}, `${flagged} of ${M.sites.length} sites need attention`) : "all sites normal");
      $("plant").hidden = true;
    }
    const pv = $("pv"), url = U.piVisionUrl(state.view);
    pv.hidden = !url; if (url) pv.href = url;
    $("site").value = state.view || "";
    // Signal: always say where the numbers come from, and how old they are
    const fr = U.freshness(state.data.asOf, state.data.live);
    $("asof").textContent = fr.source;
    const pe = $("pierr"), why = !state.data.live && state.piError ? `Why not live: ${state.piError}` : null;
    pe.hidden = !why; pe.textContent = why || "";
    renderList(); renderLegend();
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
    if (!reduce) { map.classList.add("out"); await new Promise(r => setTimeout(r, 200)); }
    if (code) image(R.sites[code].img).catch(() => {});
    await render();
    map.classList.remove("out");
    if (small()) document.body.classList.remove("pane-open");
  }
  const openSite = code => switchTo(code);
  const closeSite = () => switchTo(null);

  // left pane: open on desktop unless collapsed last time; a drawer on phones
  function setPane(open) {
    document.body.classList.toggle("pane-open", open);
    try { localStorage.setItem("cp.topo.pane", open ? "open" : "closed"); } catch (_) { /* no storage */ }
    render();
  }

  async function main() {
    try { await U.load(); } catch (e) { $("asof").textContent = `Could not load data: ${e.message}`; return; }
    $("site").replaceChildren(el("option", { value: "" }, "All sites"), ...M.sites.map(s => el("option", { value: s.code }, `${s.name}, ${s.country}`)));
    $("site").addEventListener("change", e => switchTo(e.target.value || null));
    for (const b of document.querySelectorAll("[data-open]")) b.addEventListener("click", () => setPane(true));
    $("paneClose").addEventListener("click", () => setPane(false));
    $("paneBtn").addEventListener("click", () => setPane(!document.body.classList.contains("pane-open")));
    let pane = null;
    try { pane = localStorage.getItem("cp.topo.pane"); } catch (_) { /* no storage */ }
    if (!small() && pane !== "closed") document.body.classList.add("pane-open");
    const start = location.hash.slice(1);
    state.view = SITES[start] ? start : null;
    await render();
    let t;
    window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(render, 120); });
    document.addEventListener("keydown", e => {
      if (e.key !== "Escape") return;
      if (small() && document.body.classList.contains("pane-open")) document.body.classList.remove("pane-open");
      else if (state.view) closeSite();
    });
    document.addEventListener("pointerdown", e => { if (e.pointerType !== "mouse" && !e.target.closest(".dot, .tag, .row")) tip.hidden = true; });
    window.addEventListener("hashchange", () => { const c = location.hash.slice(1); if (SITES[c] && c !== state.view) openSite(c); else if (!c && state.view) closeSite(); });
    U.autoRefresh(render);
  }
  main();
})();
