// The plant view's model and panels: the layout of a site from its AF hierarchy, the process flows,
// live PI values and the side panels. plant.js only decides how things are drawn.

const U = window.CP_UI, P = window.CP_PLANT, { M, SITES, CFG, state, el, fmt } = U;
export const $ = id => document.getElementById(id);

// ------------------------------------------------------------------ look + process
// Colours follow the Signal design system: status is carried by lightness and words, with problems in
// orange (delta-bad) and normal running in neutral grey (context), never green vs red. Products use
// Signal's categorical palette, six groups at most (the utilities share one grey).
export const LEVEL_HEX = { good: "#89929e", warning: "#eaa56a", critical: "#c2410c", planned: "#c3c9d1" };
export const LEVEL_CSS = LEVEL_HEX;
export const LEVEL_TEXT = { good: "Normal", warning: "Reduced / starting", critical: "Tripped / upset", planned: "Stopped" };
const UTILITIES = "Utilities: steam, cooling water, recycle gas";
export const PRODUCTS = {
  crude: { label: "Crude oil", color: "#0a2240", r: 0.34, uom: "bbl/d" },
  gasoline: { label: "Naphtha / gasoline", color: "#e08a2e", r: 0.24, uom: "bbl/d" },
  jet: { label: "Jet / kerosene", color: "#3fa9bb", r: 0.24, uom: "bbl/d" },
  diesel: { label: "Diesel", color: "#7d5cc4", r: 0.26, uom: "bbl/d" },
  residue: { label: "Residue / fuel oil", color: "#4a5565", r: 0.3, uom: "bbl/d" },
  gas: { label: "Recycle gas", color: "#a5adb8", r: 0.2, uom: "Mscf/d", group: UTILITIES },
  steam: { label: "Steam", color: "#a5adb8", r: 0.18, uom: "lb/h", group: UTILITIES },
  water: { label: "Cooling water", color: "#a5adb8", r: 0.2, uom: "gpm", group: UTILITIES },
};
export const TANK_PRODUCT = { "Crude Oil": "crude", "Gasoline": "gasoline", "Jet Kerosene": "jet", "Diesel": "diesel", "Fuel Oil": "residue" };
export const STATUS_LEVEL = { ...U.WELL_LEVEL, ...U.UNIT_LEVEL, Running: "good", Stopped: "planned", Tripped: "critical", Maintenance: "warning" };

// process flows between AF elements (element id suffix), the PI attribute that measures them and where
// they leave / enter the equipment (fraction of its height)
export const FLOWS = [
  ["SEP-001", "P-001", "crude", ["SEP-001", "QO"]],
  ["P-001", "PL-001", "crude", ["P-001", "FLOW"]],
  ["PL-001", "TK-101", "crude", ["TK-101", "QIN"]],
  ["PL-001", "TK-102", "crude", ["TK-102", "QIN"]],
  ["TK-101", "P-101", "crude", ["TK-101", "QOUT"], 0.1],
  ["TK-102", "P-101", "crude", ["TK-102", "QOUT"], 0.1],
  ["P-101", "D-101", "crude", ["P-101", "FLOW"]],
  ["D-101", "H-101", "crude", ["C-101", "QF"]],
  ["H-101", "C-101", "crude", ["C-101", "QF"], 0.3, 0.25],
  ["C-101", "TK-401", "gasoline", ["C-101", "QNAP"], 0.95, 0.9],
  ["C-101", "TK-402", "jet", ["C-101", "QKER"], 0.7, 0.9],
  ["C-101", "R-301", "diesel", ["C-101", "QDSL"], 0.45, 0.9],
  ["C-101", "H-201", "residue", ["C-101", "QRES"], 0.05],
  ["H-201", "C-201", "residue", ["C-201", "QF"], 0.3, 0.3],
  ["C-201", "TK-404", "residue", ["TK-404", "QIN"], 0.1, 0.9],
  ["K-301", "R-301", "gas", ["K-301", "FLOW"], 0.5, 0.7],
  ["R-301", "V-301", "diesel", ["R-301", "QF"], 0.1],
  ["V-301", "TK-403", "diesel", ["TK-403", "QIN"], 0.5, 0.9],
  ["B-501", "EJ-201", "steam", ["EJ-201", "QSTM"], 0.8, 0.8],
  ["B-501", "C-101", "steam", ["B-501", "QSTM"], 0.8, 0.15],
  ["CT-501", "EJ-201", "water", ["CT-501", "QCW"], 0.3, 0.5],
  ["CT-501", "K-301", "water", ["CT-501", "QCW"], 0.3, 0.4],
];

// ------------------------------------------------------------------ layout from the AF tree
// Process areas sit in a row in AF order (which is the flow order); a pipe rack runs behind them and
// the utilities sit behind the rack. Units are pads inside their area, equipment sits on its unit pad.
// World units are roughly metres: x east, z south (towards the viewer), y up.
export const GROUND = 0.8;                       // top of the unit pads, where equipment stands
const GAP = 2.6, PAD = 2.6, AREA_GAP = 9, RACK_GAP = 5;

function layoutWellfield(wc) {
  const wells = wc.children, n = wells.length;
  const lats = wells.map(w => w.node.props["Location|Latitude"]), lons = wells.map(w => w.node.props["Location|Longitude"]);
  const la0 = Math.min(...lats), la1 = Math.max(...lats), lo0 = Math.min(...lons), lo1 = Math.max(...lons);
  const S = Math.max(26, Math.min(40, Math.sqrt(n) * 12));
  const span = Math.max(la1 - la0, (lo1 - lo0) * Math.cos(la0 * Math.PI / 180)) || 1;
  // real relative positions, squeezed into a square, then pushed apart so the models don't touch
  const pts = wells.map((w, i) => [((lons[i] - (lo0 + lo1) / 2) * Math.cos(la0 * Math.PI / 180)) / span * S, -((lats[i] - (la0 + la1) / 2)) / span * S]);
  for (let it = 0; it < 60; it++) for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const dx = pts[j][0] - pts[i][0], dz = pts[j][1] - pts[i][1], dd = Math.hypot(dx, dz) || 0.01, min = 8.5;
    if (dd < min) { const k = (min - dd) / 2 / dd; pts[i][0] -= dx * k; pts[i][1] -= dz * k; pts[j][0] += dx * k; pts[j][1] += dz * k; }
  }
  const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  wells.forEach((w, i) => { w.x = pts[i][0] - cx; w.z = pts[i][1] - cz; });
  wc.w = Math.max(...xs) - Math.min(...xs) + 10; wc.d = Math.max(...zs) - Math.min(...zs) + 8;
}

function layoutUnit(wc) {
  if (wc.node.template === "Wellfield") return layoutWellfield(wc);
  const eqs = wc.children;
  if (!eqs.length) { wc.w = 8; wc.d = 8; return; }
  const cols = wc.node.template === "Storage Zone" && eqs.length > 2 ? 2 : eqs.length;
  const rows = Math.ceil(eqs.length / cols);
  const colW = Array.from({ length: cols }, (_, c) => Math.max(...eqs.filter((_, i) => i % cols === c).map(e => e.part.w)));
  const rowD = Array.from({ length: rows }, (_, r) => Math.max(...eqs.filter((_, i) => Math.floor(i / cols) === r).map(e => e.part.d)));
  const W = colW.reduce((a, b) => a + b, 0) + GAP * (cols - 1), D = rowD.reduce((a, b) => a + b, 0) + GAP * (rows - 1);
  eqs.forEach((e, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    e.x = -W / 2 + colW.slice(0, c).reduce((a, b) => a + b, 0) + GAP * c + colW[c] / 2;
    e.z = -D / 2 + rowD.slice(0, r).reduce((a, b) => a + b, 0) + GAP * r + rowD[r] / 2;
  });
  wc.w = W + 2 * PAD; wc.d = D + 2 * PAD;
}

function layoutArea(area) {
  area.children.forEach(layoutUnit);
  const W = area.children.reduce((a, c) => a + c.w, 0) + GAP * (area.children.length - 1);
  let x = -W / 2;
  for (const c of area.children) { c.x = x + c.w / 2; c.z = 0; x += c.w + GAP; }
  area.w = W + 2 * PAD; area.d = Math.max(...area.children.map(c => c.d)) + 2 * PAD + 3;
}

// Areas are laid out in two rows, like a conveyor: the first row runs in AF order (which is the flow
// order), the second runs back the other way, so the flow turns at the right end. Each row has a pipe
// rack behind it and a cross rack at the right end joins the two.

// makePart(node) -> { w, d, h, ports?: { out, in } } for each equipment element (depth >= 3); the view
// keeps whatever else it returns. Result: the layout tree in world units, pipe routes and the racks.
export function layoutSite(code, makePart) {
  const root = P.sites[code], byId = {}, items = [];
  const wrap = (node, depth, parent) => {
    const it = { node, depth, parent, children: [], x: 0, z: 0, w: 0, d: 0 };
    byId[node.id] = it; items.push(it);
    if (depth >= 3) it.part = makePart(node);
    it.children = node.children.map(c => wrap(c, depth + 1, it));
    return it;
  };
  const top = wrap(root, 0, null);
  const areas = top.children, utilities = areas.filter(a => a.node.name === "Utilities"), process = areas.filter(a => !utilities.includes(a));
  areas.forEach(layoutArea);
  const width = list => list.reduce((s, a) => s + a.w, 0) + AREA_GAP * Math.max(0, list.length - 1);
  const depth = list => Math.max(0, ...list.map(a => a.d));
  const spanOf = list => [Math.min(...list.map(a => a.x - a.w / 2)), Math.max(...list.map(a => a.x + a.w / 2))];
  // place a list of areas side by side ending at x1 (dir -1: in reverse order, so the flow runs back)
  const place = (list, x1, z, dir, row) => {
    let x = x1 - width(list);
    for (const a of dir > 0 ? list : list.slice().reverse()) { a.x = x + a.w / 2; a.z = z; a.row = row; x += a.w + AREA_GAP; }
  };
  // split where the two rows come out closest in length; utilities close the second row
  const seq = process.concat(utilities);
  let k = 1, best = Infinity;
  for (let i = 1; i < seq.length; i++) { const d = Math.abs(width(seq.slice(0, i)) - width(seq.slice(i))); if (d < best) { best = d; k = i; } }
  const r0 = seq.slice(0, k), r1 = seq.slice(k), X1 = Math.max(width(r0), width(r1)) / 2;
  const rack0 = -depth(r0) / 2 - RACK_GAP, rack1 = depth(r0) / 2 + 7.1, z1 = rack1 + RACK_GAP + depth(r1) / 2;
  place(r0, X1, 0, 1, 0);
  place(r1, X1, z1, -1, 1);
  const xc = X1 + 3;
  const rows = [{ z: rack0, x0: spanOf(r0)[0] + 6, x1: xc + 6 }, { z: rack1, x0: spanOf(r1)[0] + 6, x1: xc + 6 }];
  const connector = { x: xc, z0: rack0, z1: rack1 };
  // world positions = area + unit + equipment offsets
  for (const a of areas) {
    a.wx = a.x; a.wz = a.z;
    for (const u of a.children) {
      u.wx = a.wx + u.x; u.wz = a.wz + u.z - 1.2; u.row = a.row;
      for (const e of u.children) { e.wx = u.wx + e.x; e.wz = u.wz + e.z; e.row = a.row; }
    }
  }

  // ---------------------------------------------------------------- pipe routes
  const pipes = [], S = id => byId[`${code}-${id}`];
  const V = (x, y, z) => ({ x, y, z });
  const rackOf = it => rows[it.row || 0].z;
  const portOf = (it, frac, toward) => {
    const pt = it.part;
    if (pt.ports) { const p = (toward === "in" ? pt.ports.in : pt.ports.out) || pt.ports.out; return V(it.wx + p.x, GROUND + p.y, it.wz + p.z); }
    const face = it.wz > rackOf(it) ? -1 : 1;           // the side facing its pipe rack
    return V(it.wx, GROUND + Math.max(0.9, pt.h * frac), it.wz + face * pt.d / 2 * 0.9);
  };
  const add = (pts, product, flowTag, from, to) => {
    pts = pts.filter((p, i) => !i || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y, p.z - pts[i - 1].z) > 1e-3);
    pipes.push({ pts, product, flowTag, from, to, flow: null, speed: 0 });
  };
  // flowlines: a header along the front of the wellfield, into the west end of the separator
  const sep = S("SEP-001"), wf = byId[`${code}-WF`];
  let lane = 0;
  if (sep && wf) for (const w of wf.children) {
    const l = lane++, a = portOf(w, 0, "out"), y = 1.4;           // on sleepers, just above the pad
    const b = V(sep.wx - sep.part.w / 2 + 0.4, GROUND + 1.6, sep.wz);
    const zf = wf.wz + wf.d / 2 - 1.2 - (l % 4) * 0.35, xw = b.x - 1.2 - (l % 4) * 0.35;
    add([a, V(a.x, y, a.z), V(a.x, y, zf), V(xw, y, zf), V(xw, b.y, b.z), b], "crude", `${w.node.tag}.QO`, w, sep);
  }
  // everything else over the pipe racks, one lane each; between rows over the cross rack
  lane = 0;
  for (const [f, t, product, [fid, attr], ff = 0.5, tf = 0.5] of FLOWS) {
    const A = S(f), B = S(t), src = S(fid);
    if (!A || !B || !src) continue;
    const a = portOf(A, ff, "out"), b = portOf(B, tf, "in"), l = lane++, H = 7 + (l % 5) * 0.8;
    const za = rackOf(A) + 1.4 - (l % 7) * 0.75, zb = rackOf(B) + 1.4 - (l % 7) * 0.75;
    const mid = (A.row || 0) === (B.row || 0) ? [V(a.x, H, za), V(b.x, H, za)]
      : [V(a.x, H, za), V(connector.x + (l % 7) * 0.75, H, za), V(connector.x + (l % 7) * 0.75, H, zb), V(b.x, H, zb)];
    add([a, V(a.x, a.y, za), ...mid, V(b.x, b.y, zb), b], product, `${src.node.tag}.${attr}`, A, B);
  }
  return { code, root: top, byId, items, areas, racks: rows, connector, pipes };
}

// ------------------------------------------------------------------ live values
// ctx is the state both views share: the site on screen, the selection and the latest PI values
export const ctx = { site: null, selected: null, values: {}, times: {}, asOf: null, live: false };

export const statusAttr = it => (P.templates[it.node.template] || []).find(a => /Status$/.test(a[0]));
export function statusOf(it) {
  for (let n = it; n; n = n.parent) {
    const a = statusAttr(n);
    if (a) { const v = ctx.values[`${n.node.tag}.${a[1]}`]; return { text: v, level: STATUS_LEVEL[v] || "planned", own: n === it }; }
  }
  return { text: null, level: "planned", own: false };
}

// flow and animation speed of each pipe from its PI attribute
export function updatePipes() {
  const cap = SITES[ctx.site.code].capacity;
  for (const p of ctx.site.pipes) {
    const f = +ctx.values[p.flowTag];
    p.flow = Number.isFinite(f) ? f : null;
    const ref = p.product === "crude" || p.product === "residue" ? cap * 0.6 : ["gasoline", "jet", "diesel"].includes(p.product) ? cap * 0.2 : null;
    p.speed = !(f > 0.5) ? 0 : ref ? 0.25 + 1.6 * Math.min(1, f / ref) : 0.7;
  }
}

export const tankFraction = (node) => {
  const lvl = +ctx.values[`${node.tag}.LVL`];
  return Math.max(0.01, Math.min(1, (lvl || 0) / (node.props["Max Fill Height"] || 48)));
};

export async function fetchValues() {
  const r = await state.source.tagValues(ctx.site.code);
  ctx.values = r.values; ctx.times = r.times || {}; ctx.asOf = r.asOf; ctx.live = r.live;
}
export function initialValues(code) {
  ctx.values = state.source.name === "demo" ? { ...(state.data.sites[code].tags || {}) } : {};
}

// ------------------------------------------------------------------ panels
const fmtV = v => typeof v === "number" ? fmt(v, Math.abs(v) < 10 && v !== 0 ? 1 : 0) : v ?? "—";

export function asOfText() {
  return ctx.asOf || ctx.live ? U.freshness(ctx.asOf, ctx.live).source : "";
}

export function renderInfo(it, select) {
  const n = it.node, st = statusOf(it), attrs = P.templates[n.template] || [], values = ctx.values;
  const kind = ["Site", "Area", "Unit", "Equipment"][Math.min(3, it.depth)];
  $("infoKind").textContent = kind === n.template ? kind : `${kind} · ${n.template}`;
  const rows = attrs.filter(a => !/Status$|Scenario$/.test(a[0])).map(([name, suffix, uom]) => {
    const v = values[`${n.tag}.${suffix}`], t = ctx.times[`${n.tag}.${suffix}`];
    return el("tr", { title: t ? `PI timestamp ${U.when(t)} (${U.ago(Date.now() - new Date(t).getTime())})` : null },
      el("td", {}, name), el("td", {}, fmtV(typeof v === "number" ? v : v ?? null), uom ? el("small", {}, ` ${uom}`) : null));
  });
  const scen = values[`${n.tag}.SCEN`];
  const props = Object.entries(n.props).filter(([k]) => !k.startsWith("Location"));
  const kids = it.children;
  $("infoBody").replaceChildren(...[
    el("div", { class: "sec" }, el("h2", {}, n.name), el("div", { class: "meta" }, `${n.desc} · ${n.id}`),
      st.text ? el("span", { class: "pill" }, el("i", { style: `background:${LEVEL_CSS[st.level]}` }), st.own ? st.text : `${it.parent.node.name}: ${st.text}`) : null,
      scen && scen !== "Normal" ? el("div", { class: "meta" }, `Active scenario: ${scen}`) : null),
    rows.length ? el("div", { class: "sec" }, el("h3", {}, "PI values"), el("table", {}, rows)) : null,
    props.length ? el("div", { class: "sec" }, el("h3", {}, "Configuration"), el("table", {}, props.map(([k, v]) => el("tr", {}, el("td", {}, k), el("td", {}, fmtV(v)))))) : null,
    kids.length ? el("div", { class: "sec" }, el("h3", {}, it.depth === 2 && n.template === "Wellfield" ? "Wells" : "Contains"),
      el("div", { class: "kids" }, kids.map(k => el("button", { type: "button", onclick: () => select(k) }, k.node.name)))) : null,
  ].filter(Boolean));
}

export function renderCrumbs(select) {
  const c = $("crumbs"); c.replaceChildren();
  const chain = []; for (let n = ctx.selected || ctx.site.root; n; n = n.parent) chain.unshift(n);
  c.append(el("span", {}, M.company.replace(" S.A.", "")), el("span", {}, "›"));
  chain.forEach((n, i) => { if (i) c.append(el("span", {}, "›")); c.append(el("button", { type: "button", onclick: () => select(n.depth ? n : null) }, n.node.name)); });
  $("h1").textContent = `${SITES[ctx.site.code].name} plant`;
}

export function updatePV() {
  const pv = CFG.piVision || {}, a = $("pv");
  const asset = `\\\\${CFG.piwebapi?.afServer}\\${M.database}\\${(ctx.selected || ctx.site.root).node.path}`;
  const tpl = pv.elementDisplay || pv.siteDisplay;
  const url = tpl ? tpl.replace("{asset}", encodeURIComponent(asset)) : pv.home;
  a.hidden = !url; if (url) a.href = url;
}

// AF tree: areas open, units closed unless they hold the selection
export function renderTree(select) {
  const open = new Set(); for (let n = ctx.selected; n; n = n.parent) open.add(n);
  const li = it => {
    const kids = it.children, isOpen = it.depth < 1 || open.has(it) || (it.depth === 1 && !ctx.selected);
    const node = el("li", { class: kids.length && !isOpen ? "closed" : null });
    const tw = el("button", { type: "button", class: "tw", disabled: !kids.length, "aria-label": kids.length ? `Expand ${it.node.name}` : null, "aria-expanded": kids.length ? String(isOpen) : null,
      onclick: () => { node.classList.toggle("closed"); tw.textContent = node.classList.contains("closed") ? "▶" : "▼"; tw.setAttribute("aria-expanded", String(!node.classList.contains("closed"))); } }, kids.length ? (isOpen ? "▼" : "▶") : "");
    const nm = el("button", { type: "button", class: `nm${it === ctx.selected ? " on" : ""}`, onclick: () => select(it.depth ? it : null), "aria-current": it === ctx.selected ? "true" : null },
      el("i", { "data-dot": it.node.id }), el("span", {}, it.node.name), el("em", {}));
    node.append(el("div", {}, tw, nm));
    if (kids.length) node.append(el("ul", {}, kids.map(li)));
    return node;
  };
  $("treeBody").replaceChildren(el("ul", {}, li(ctx.site.root)));
  renderTreeDots();
  $("treeBody").querySelector(".nm.on")?.scrollIntoView({ block: "nearest" });
}
// status dot on every element with a status; problems also get their status in words
export function renderTreeDots() {
  for (const dot of $("treeBody").querySelectorAll("i[data-dot]")) {
    const it = ctx.site.byId[dot.dataset.dot], a = statusAttr(it), v = a && ctx.values[`${it.node.tag}.${a[1]}`];
    const level = v != null && a ? STATUS_LEVEL[v] || "planned" : null;
    dot.style.background = level ? LEVEL_CSS[level] : "transparent";
    const word = dot.parentElement.querySelector("em");
    word.textContent = level === "warning" || level === "critical" ? v : "";
  }
}

// selection side effects on the panels and the URL; plant.js handles the highlight and the view
export function showSelection(select) {
  const it = ctx.selected;
  renderCrumbs(select); renderTree(select); updatePV();
  const info = $("info");
  if (it) { renderInfo(it, select); info.hidden = false; } else info.hidden = true;
  if (window.innerWidth <= 700 && it) document.body.classList.remove("pane-open");   // phones: show the drawing
  try { history.replaceState(null, "", `#${ctx.site.code}${it ? "/" + it.node.id : ""}`); } catch (_) { /* sandboxed */ }
}

// the part of the drawing area not covered by the details panel, in window coordinates
export function freeArea() {
  const r = $("stage").getBoundingClientRect(), info = $("info");
  let { left, right, top, bottom } = r;
  if (!info.hidden) {
    const p = info.getBoundingClientRect();
    if (window.innerWidth > 700) right = Math.min(right, p.left - 8); else bottom = Math.min(bottom, p.top);
  }
  return { left, right, top, bottom };
}

export function pipeTip(p) {
  return [el("b", {}, PRODUCTS[p.product].label), `${p.from.node.name} → ${p.to.node.name}`, el("br"),
    el("span", {}, p.flow == null ? "—" : `${fmt(p.flow)} ${PRODUCTS[p.product].uom}`)];
}
export function placeTip(tip, e) {
  tip.hidden = false;
  tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 14)}px`; tip.style.top = `${e.clientY + 14}px`;
}

export function legend() {
  const groups = new Map();
  for (const p of Object.values(PRODUCTS)) if (!groups.has(p.group || p.label)) groups.set(p.group || p.label, p.color);
  $("legend").replaceChildren(...[...groups].map(([label, color]) => el("span", {}, el("i", { style: `background:${color}` }), label)));
  $("statusLegend").replaceChildren(...["good", "warning", "critical", "planned"].map(l => el("span", {}, el("b", { style: `background:${LEVEL_HEX[l]}` }), LEVEL_TEXT[l])));
}

// header, panels, keyboard and URL wiring shared by both pages
export function wirePage({ openSite, select, home }) {
  $("site").replaceChildren(...M.sites.map(s => el("option", { value: s.code }, `${s.name}, ${s.country}`)));
  $("site").addEventListener("change", e => openSite(e.target.value));
  $("infoClose").addEventListener("click", () => select(null, { fly: false }));
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (document.body.classList.contains("pane-open") && window.innerWidth <= 700) document.body.classList.remove("pane-open");
    else if (ctx.selected) select(ctx.selected.parent?.depth ? ctx.selected.parent : null);
    else home();
  });
  const fromHash = () => {
    const [code, id] = decodeURIComponent(location.hash.slice(1)).split("/");
    const c = SITES[code] ? code : (ctx.site ? ctx.site.code : M.sites[0].code);
    if (!ctx.site || c !== ctx.site.code) openSite(c, id);
    else { const it = id && ctx.site.byId[id]; if (it !== ctx.selected) select(it || null); }
  };
  window.addEventListener("hashchange", fromHash);
  legend();
  return fromHash;
}

export { U, P, M, SITES, CFG, state, el, fmt };
