// Plant view: one site's AF hierarchy (areas -> units -> equipment) as a flat isometric SVG
// illustration, with the product flows from the wells to the product tanks driven by live PI values.
// No WebGL, so it stays light on machines without a graphics card: the browser only repaints when you
// pan, zoom, hover or new values arrive. Layout, flows, values and panels live in plant-core.js.
import {
  $, U, CFG, fmt, PRODUCTS, TANK_PRODUCT, LEVEL_HEX, GROUND, layoutSite, ctx, statusOf, statusAttr, STATUS_LEVEL,
  updatePipes, tankFraction, fetchValues, initialValues, renderInfo, renderTreeDots, showSelection, freeArea,
  pipeTip, placeTip, asOfText, wirePage,
} from "./plant-core.js?v=2026.11.03";

const svg = $("scene");
// industrial look: galvanised equipment, yellow structural steel, concrete pads (line colours in plant.html)
const COL = { concrete: "#b9b4aa", slab: "#d8d5cd", pad: "#c8c3b8", field: "#cfcab2", body: "#c3c9ce", body2: "#8f99a2", steel: "#e2b007", dark: "#2e343a", cellar: "#6f695e", water: "#76afbb" };

// ------------------------------------------------------------------ projection
// classic isometric: x and z at ±30°, y straight up; depth (x + z) grows towards the viewer
const C30 = Math.cos(Math.PI / 6), S30 = 0.5;
const proj = (x, y, z) => [(x - z) * C30, (x + z) * S30 - y];
const depthOf = (x, z) => x + z;
const P = proj;
const f = n => Math.round(n * 100) / 100;
const pts = list => list.map(([x, y]) => `${f(x)},${f(y)}`).join(" ");

// ------------------------------------------------------------------ colours
function mix(hex, to, t) {
  const a = parseInt(hex.slice(1), 16), b = parseInt(to.slice(1), 16);
  const c = [16, 8, 0].map(s => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t));
  return `#${c.map(v => v.toString(16).padStart(2, "0")).join("")}`;
}
const light = (c, t = 0.18) => mix(c, "#ffffff", t), dark = (c, t = 0.18) => mix(c, "#000000", t);
const grads = new Map();
function grad(color, vertical) {      // shading across a cylinder: lit from the upper left
  const id = `g${vertical ? "v" : "h"}${color.slice(1)}`;
  if (!grads.has(id)) grads.set(id, `<linearGradient id="${id}" x1="0" y1="0" x2="${vertical ? 0 : 1}" y2="${vertical ? 1 : 0}">
    <stop offset="0" stop-color="${light(color, 0.35)}"/><stop offset=".45" stop-color="${color}"/><stop offset="1" stop-color="${dark(color, 0.16)}"/></linearGradient>`);
  return `url(#${id})`;
}

// ------------------------------------------------------------------ primitives
// Everything is painted back to front: each primitive has a depth (x + z); ties keep
// the order they were drawn in, so a band drawn after its column stays on top of it.
let prims = [], seq = 0, cur = null, bounds = null;
const itemBounds = new Map();
function grow(b, x, y) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
function track(list) {
  for (const [x, y] of list) {
    grow(bounds, x, y);
    if (cur) { let b = itemBounds.get(cur); if (!b) itemBounds.set(cur, b = [Infinity, Infinity, -Infinity, -Infinity]); grow(b, x, y); }
  }
}
function push(depth, svgText, attrs = cur ? ` data-id="${cur}"` : "") {
  prims.push({ d: depth, s: seq++, t: `<g${attrs}>${svgText}</g>` });
}

function box(cx, y0, cz, w, h, d, color, cls = "", { top: withTop = true } = {}) {
  const a = cx, b = cz;
  const a0 = a - w / 2, a1 = a + w / 2, b0 = b - d / 2, b1 = b + d / 2, y1 = y0 + h;
  const top = [proj(a0, y1, b0), proj(a1, y1, b0), proj(a1, y1, b1), proj(a0, y1, b1)];
  const right = [proj(a1, y0, b0), proj(a1, y0, b1), proj(a1, y1, b1), proj(a1, y1, b0)];
  const left = [proj(a0, y0, b1), proj(a1, y0, b1), proj(a1, y1, b1), proj(a0, y1, b1)];
  track(top); track(right); track(left);
  const outline = hull(withTop ? top.concat(right, left) : right.concat(left));
  push(a + b, `<polygon class="o ${cls}" points="${pts(left)}" fill="${dark(color, 0.07)}"/><polygon class="o ${cls}" points="${pts(right)}" fill="${dark(color, 0.17)}"/>` +
    (withTop ? `<polygon class="o ${cls}" points="${pts(top)}" fill="${color}"/>` : "") + `<polygon class="sil ${cls}" points="${pts(outline)}" fill="none"/>`);
}
const band = (cx, y0, cz, w, h, d, color) => box(cx, y0, cz, w, h, d, color, "", { top: false });   // painted stripe round a box

// a flat rectangle on the front (+z) face of a box
function facePatch(cx, cz, halfW, halfD, y0, y1, halfLen, color) {
  const pz = cz + halfD + 0.02;
  const q = [P(cx - halfLen, y0, pz), P(cx + halfLen, y0, pz), P(cx + halfLen, y1, pz), P(cx - halfLen, y1, pz)];
  push(depthOf(cx, cz) + 0.01, `<polygon points="${pts(q)}" fill="${color}"/>`);
}

// vertical cylinder; a circle of radius r in the ground plane shows as an ellipse rx × ry
const RX = Math.SQRT2 * C30, RY = Math.SQRT2 * S30;
function cylV(cx, y0, cz, r, h, color, { dome = false, cap = true } = {}) {
  const [bx, by] = P(cx, y0, cz), [tx, ty] = P(cx, y0 + h, cz), rx = r * RX, ry = r * RY;
  track([[bx - rx, by + ry], [bx + rx, by + ry], [tx - rx, ty - (dome ? r : ry)], [tx + rx, ty - ry]]);
  let s = `<path class="sil" fill="${grad(color, false)}" d="M${f(bx + rx)},${f(by)} L${f(tx + rx)},${f(ty)} L${f(tx - rx)},${f(ty)} L${f(bx - rx)},${f(by)} A${f(rx)},${f(ry)} 0 0 0 ${f(bx + rx)},${f(by)}Z"/>`;
  if (dome) s += `<path class="sil" fill="${grad(color, false)}" d="M${f(tx - rx)},${f(ty)} A${f(rx)},${f(ry)} 0 0 0 ${f(tx + rx)},${f(ty)} A${f(rx)},${f(r * 0.95)} 0 0 0 ${f(tx - rx)},${f(ty)}Z"/>`;
  else if (cap) s += `<ellipse class="o" cx="${f(tx)}" cy="${f(ty)}" rx="${f(rx)}" ry="${f(ry)}" fill="${light(color, 0.12)}"/>`;
  push(depthOf(cx, cz), s);
}

// a platform round a vertical vessel: the front half of the ring and its handrail
function platform(cx, y, cz, R) {
  const [px, py] = P(cx, y, cz), [hx, hy] = P(cx, y + 1, cz), rx = R * RX, ry = R * RY;
  push(depthOf(cx, cz) + 0.02, `<path class="steel" d="M${f(px - rx)},${f(py)} A${f(rx)},${f(ry)} 0 0 0 ${f(px + rx)},${f(py)}" stroke-width="0.28"/>` +
    `<path class="steel" d="M${f(hx - rx)},${f(hy)} A${f(rx)},${f(ry)} 0 0 0 ${f(hx + rx)},${f(hy)}" stroke-width="0.12"/>`);
}
// a straight ladder up the right-hand (+x) side of a vessel
function ladder(cx, y0, y1, cz, r) {
  const x = cx + r + 0.25, [a0, b0] = P(x, y0, cz - 0.25), [a1, b1] = P(x, y1, cz - 0.25), [c0, d0] = P(x, y0, cz + 0.25), [c1, d1] = P(x, y1, cz + 0.25);
  let d = `M${f(a0)},${f(b0)}L${f(a1)},${f(b1)}M${f(c0)},${f(d0)}L${f(c1)},${f(d1)}`;
  for (let y = y0 + 0.5; y < y1; y += 0.9) { const [p, q] = P(x, y, cz - 0.25), [u, v] = P(x, y, cz + 0.25); d += `M${f(p)},${f(q)}L${f(u)},${f(v)}`; }
  push(depthOf(cx, cz) + 0.03, `<path class="steel" d="${d}" stroke-width="0.12"/>`);
}
// a stair winding up the front of a tank, with its handrail
function stair(cx, y0, cz, r, h) {
  const at = (t, lift) => { const a = (120 - 110 * t) * Math.PI / 180; return P(cx + (r + 0.35) * Math.cos(a), y0 + h * t + lift, cz + (r + 0.35) * Math.sin(a)); };
  const line = lift => Array.from({ length: 13 }, (_, i) => at(i / 12, lift)).map(([x, y], i) => `${i ? "L" : "M"}${f(x)},${f(y)}`).join("");
  push(depthOf(cx, cz) + 0.03, `<path class="steel" d="${line(0)}" stroke-width="0.3"/><path class="steel" d="${line(1)}" stroke-width="0.12"/>`);
}

function hull(p) {
  p = p.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.slice().reverse()) { while (hi.length >= 2 && cross(hi.at(-2), hi.at(-1), q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}
// horizontal cylinder along world x or z, centred at (cx, cy, cz)
function cylH(cx, cy, cz, r, len, axis, color, { caps = 0 } = {}) {
  const a = cx, b = cz, along = axis === "x" ? "a" : "b";
  const ring = e => Array.from({ length: 20 }, (_, i) => {
    const t = i / 20 * Math.PI * 2, u = r * Math.cos(t), v = r * Math.sin(t);
    return along === "a" ? proj(a + e, cy + v, b + u) : proj(a + u, cy + v, b + e);
  });
  const near = ring(len / 2), far = ring(-len / 2);
  const body = caps ? hull(near.concat(far, ring(len / 2 + caps), ring(-len / 2 - caps))) : hull(near.concat(far));
  track(body);
  push(a + b, `<polygon class="sil" points="${pts(body)}" fill="${grad(color, true)}"/>` + (caps ? "" : `<polygon class="o" points="${pts(near)}" fill="${light(color, 0.1)}"/>`));
}

// ------------------------------------------------------------------ equipment
// footprint and height of each equipment model, used by the layout
const tankDims = p => ({ r: Math.max(2.6, Math.min(6.2, (p.Diameter || 40) * 0.3048 * 0.3)), h: Math.max(6, (p["Max Fill Height"] || 48) * 0.3048 * 0.55) });
function sizeOf(node) {
  const id = node.id, t = node.template;
  switch (t) {
    case "Tank": { const { r, h } = tankDims(node.props); return { w: 2 * r + 1, d: 2 * r + 1, h }; }
    case "Atmospheric Column": return { w: 4.9, d: 4.9, h: 26.5 };
    case "Vacuum Column": return { w: 5.8, d: 5.8, h: 19.9 };
    case "Fired Heater": return { w: 5.5, d: 4.6, h: 14.5 };
    case "Pump": return { w: 3.8, d: 2, h: 1.9 };
    case "Separator": return id.endsWith("V-301") ? { w: 5.6, d: 2.8, h: 2.7 } : { w: 7.9, d: 3.3, h: 3.2 };
    case "Desalter": return { w: 9.2, d: 3.6, h: 3.5 };
    case "Reactor": return { w: 4.7, d: 4.7, h: 12.6 };
    case "Compressor": return { w: 5.4, d: 3, h: 3.3 };
    case "Vacuum Ejector System": return { w: 3.2, d: 2.4, h: 6.8 };
    case "Boiler": return { w: 7, d: 4, h: 9.8 };
    case "Cooling Tower": return { w: 10.5, d: 5, h: 6.2 };
    case "Pipeline": return { w: 17, d: 2, h: 1.5, ports: { out: { x: 8, y: 0.9, z: 0 }, in: { x: -8, y: 0.9, z: 0 } } };
    default:
      if (t.startsWith("Well")) { const rod = node.props["Lift Method"] === "Rod Pump"; return { w: rod ? 7.5 : 4.5, d: 3.6, h: rod ? 5 : 2.6, ports: { out: { x: 0, y: 0.5, z: 0 } } }; }
      return { w: 3.5, d: 3.5, h: 2.4 };
  }
}

function drawEquipment(it) {
  const n = it.node, t = n.template, x = it.wx, z = it.wz, y = GROUND, v = ctx.values;
  const acc = LEVEL_HEX[statusOf(it).level];
  cur = n.id;
  if (t === "Tank") {
    const { r, h } = tankDims(n.props), prod = PRODUCTS[TANK_PRODUCT[n.props.Product] || "crude"], fr = tankFraction(n), b = y + 0.35;
    cylV(x, y, z, r + 0.5, 0.35, COL.concrete);              // ring foundation
    cylV(x, b, z, r, h, COL.body, { cap: false });
    cylV(x, b, z, r + 0.04, h * fr, prod.color, { cap: fr > 0.97 });
    cylV(x, b + h, z, r + 0.1, 0.5, COL.body2);
    stair(x, b, z, r, h);
  } else if (t === "Atmospheric Column" || t === "Vacuum Column") {
    const vac = t === "Vacuum Column", r = vac ? 1.9 : 1.45, h = vac ? 16 : 23;
    cylV(x, y, z, r * 1.08, 2, COL.body2);
    if (vac) { cylV(x, y + 2, z, r * 0.7, h * 0.45, COL.body, { cap: false }); cylV(x, y + 2 + h * 0.45, z, r, h * 0.55, COL.body, { dome: true }); }
    else cylV(x, y + 2, z, r, h, COL.body, { dome: true });
    cylV(x, y + 2 + h * 0.55, z, r + 0.06, 0.6, acc, { cap: false });
    for (const k of vac ? [0.5, 0.85] : [0.33, 0.66, 0.95]) platform(x, y + 2 + h * k, z, r + 0.7);
    ladder(x, y + 2, y + 2 + h, z, r);
  } else if (t === "Fired Heater") {
    box(x, y, z, 5, 0.6, 4.2, COL.body2);
    box(x, y + 0.6, z, 4.4, 5.5, 3.6, COL.body);
    band(x, y + 0.95, z, 4.45, 0.5, 3.65, acc);
    box(x, y + 6.1, z, 2.4, 1.4, 2.2, COL.body);
    cylV(x, y + 7.5, z, 0.5, 7, COL.body2);
    if (+v[`${n.tag}.QFG`] > 1) facePatch(x, z, 2.2, 1.8, y + 2.1, y + 2.6, 1.5, "#ff9a3c");    // firebox glow
  } else if (t === "Pump") {
    box(x, y, z, 3.8, 0.3, 1.9, COL.concrete);                 // plinth
    box(x, y + 0.3, z, 3.4, 0.3, 1.5, COL.dark);
    cylH(x - 0.7, y + 1.15, z, 0.5, 1.5, "x", acc);
    cylV(x + 0.85, y + 0.6, z, 0.55, 1.1, COL.body);
  } else if (t === "Separator" || t === "Desalter") {
    const small = n.id.endsWith("V-301"), len = t === "Desalter" ? 6 : small ? 3.2 : 5, r = t === "Desalter" ? 1.3 : small ? 0.9 : 1.15, cy = y + r + 0.9;
    for (const dx of [-len * 0.32, len * 0.32]) box(x + dx, y, z, 0.5, r + 0.9, r * 1.5, COL.body2);
    cylH(x, cy, z, r, len, "x", COL.body, { caps: r * 0.9 });
    cylH(x, cy, z, r + 0.05, 0.4, "x", acc);
    if (t === "Desalter") box(x, cy + r - 0.1, z, 1.2, 0.8, 1, COL.dark);
  } else if (t === "Reactor") {
    cylV(x, y, z, 1.4, 2.4, COL.body2);
    cylV(x, y + 2.4, z, 1.35, 8.8, COL.body, { dome: true });
    cylV(x, y + 2.4 + 4.5, z, 1.4, 0.5, acc, { cap: false });
    platform(x, y + 2.4 + 8.8, z, 2.0);
    ladder(x, y + 2.4, y + 2.4 + 8.8, z, 1.35);
  } else if (t === "Compressor") {
    box(x, y, z, 5.4, 0.3, 3, COL.concrete);                   // plinth
    box(x, y + 0.3, z, 5, 0.3, 2.6, COL.dark);
    box(x - 1.2, y + 0.6, z, 2.3, 2.1, 2.1, acc);
    cylH(x + 1.3, y + 1.5, z, 0.85, 2.2, "x", COL.body);
  } else if (t === "Vacuum Ejector System") {
    cylV(x, y, z, 0.65, 3, COL.body);
    for (const dx of [-1, 1]) box(x + dx, y, z, 0.25, 5, 1.8, COL.steel);
    box(x, y + 5, z, 2.5, 0.15, 2, COL.steel);
    cylH(x, y + 5.6, z, 0.32, 2.6, "x", COL.body);
    cylH(x, y + 6.4, z, 0.26, 2.6, "x", acc);
  } else if (t === "Boiler") {
    box(x, y, z, 6.5, 3.8, 3.6, COL.body);
    band(x, y + 0.35, z, 6.55, 0.5, 3.65, acc);
    cylH(x, y + 4.5, z, 0.7, 4.2, "x", COL.body2, { caps: 0.6 });
    cylV(x + 2.6, y + 3.8, z - 1, 0.42, 6, COL.body2);
  } else if (t === "Cooling Tower") {
    box(x, y, z, 10, 0.6, 4.6, COL.water);
    box(x, y + 0.6, z, 9.4, 4, 4, COL.body);
    for (const dx of [-3.1, 0, 3.1]) cylV(x + dx, y + 4.6, z, 1.35, 1.2, acc);
  } else if (t === "Pipeline") {
    for (let dx = -7; dx <= 7; dx += 2.5) box(x + dx, y, z, 0.3, 0.5, 1.2, COL.dark);
    cylH(x, y + 0.9, z, 0.4, 16, "x", COL.body2);
  } else if (t.startsWith("Well")) {
    const lift = n.props["Lift Method"];
    box(x, y, z, 3.2, 0.25, 3.2, COL.cellar);
    cylV(x, y + 0.25, z, 0.32, 1.8, COL.body2);
    cylV(x, y + 1.85, z, 0.42, 0.35, acc);
    if (lift === "Rod Pump") {
      const bx = x - 2.6;
      box(bx + 1.2, y, z, 5.5, 0.35, 1.3, COL.dark);
      box(bx - 1.7, y + 0.35, z, 1.3, 0.9, 1.1, COL.body2);
      box(bx + 1.6, y + 0.35, z, 0.25, 3.4, 1.0, COL.dark);
      box(bx + 2.1, y + 3.75, z, 5.2, 0.38, 0.38, acc);
      box(bx + 4.75, y + 2.9, z, 0.5, 1.3, 0.5, COL.body2);
    } else if (lift === "ESP") box(x - 2.2, y + 0.25, z, 0.9, 1.8, 0.5, COL.body);
    else if (lift === "PCP") box(x + 0.4, y + 2.2, z, 1.2, 0.7, 0.7, acc);
    else if (lift === "Gas Lift") box(x - 2.2, y + 0.25, z, 0.7, 0.9, 0.6, COL.body);
  } else {
    box(x, y, z, 3, 2.4, 3, COL.body);
    band(x, y + 0.3, z, 3.05, 0.4, 3.05, acc);
  }
  cur = null;
}

// pipes are cut into short pieces so each piece sorts correctly against the equipment around it.
// Flow direction is shown with arrowheads along the line (none when there is no flow); the ends are
// flanged where they meet the equipment; runs along the ground sit on sleepers.
const luminance = hex => { const n = parseInt(hex.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };
function drawPipe(p, i) {
  const pr = PRODUCTS[p.product], still = !p.speed, fill = still ? mix(pr.color, "#b8c0c6", 0.6) : pr.color;
  const w = 2 * pr.r, arrow = luminance(pr.color) < 0.5 ? "#ffffff" : "#0f1b2d";
  let piece = 0;
  for (let k = 1; k < p.pts.length; k++) {
    const A = p.pts[k - 1], B = p.pts[k], len = Math.hypot(B.x - A.x, B.y - A.y, B.z - A.z);
    const pieces = Math.max(1, Math.ceil(len / 5));
    for (let j = 0; j < pieces; j++) {
      const t0 = j / pieces, t1 = (j + 1) / pieces;
      const a = [A.x + (B.x - A.x) * t0, A.y + (B.y - A.y) * t0, A.z + (B.z - A.z) * t0];
      const b = [A.x + (B.x - A.x) * t1, A.y + (B.y - A.y) * t1, A.z + (B.z - A.z) * t1];
      const s = P(...a), e = P(...b), d = `M${f(s[0])},${f(s[1])}L${f(e[0])},${f(e[1])}`;
      track([s, e]);
      let head = "";
      const sx = e[0] - s[0], sy = e[1] - s[1], sl = Math.hypot(sx, sy);
      if (!still && piece++ % 2 === 0 && sl > 2.2) {            // an arrowhead on every other piece
        const ux = sx / sl, uy = sy / sl, mx = (s[0] + e[0]) / 2, my = (s[1] + e[1]) / 2, hl = w * 0.95, hw = w * 0.36;
        head = `<polygon points="${f(mx + ux * hl / 2)},${f(my + uy * hl / 2)} ${f(mx - ux * hl / 2 - uy * hw)},${f(my - uy * hl / 2 + ux * hw)} ${f(mx - ux * hl / 2 + uy * hw)},${f(my - uy * hl / 2 - ux * hw)}" fill="${arrow}"/>`;
      }
      push(depthOf((a[0] + b[0]) / 2, (a[2] + b[2]) / 2) + 0.001,
        `<path class="po" d="${d}" stroke-width="${f(w + 0.32)}"/><path d="${d}" stroke="${fill}" stroke-width="${f(w)}"/>${head}`, ` data-pipe="${i}"`);
    }
    // sleepers under runs along the ground
    if (A.y < 1.6 && Math.abs(A.y - B.y) < 1e-6 && len > 3) {
      const along = Math.abs(B.x - A.x) > Math.abs(B.z - A.z);
      for (let t = 2; t < len - 1; t += 4) {
        const sx2 = A.x + (B.x - A.x) * t / len, sz2 = A.z + (B.z - A.z) * t / len;
        box(sx2, GROUND, sz2, along ? 0.35 : 1.1, Math.max(0.15, A.y - pr.r - GROUND), along ? 1.1 : 0.35, COL.concrete);
      }
    }
    if (k < p.pts.length - 1) {
      const [jx, jy] = P(B.x, B.y, B.z);
      push(depthOf(B.x, B.z) + 0.002, `<circle class="o" cx="${f(jx)}" cy="${f(jy)}" r="${f(pr.r)}" fill="${fill}"/>`, ` data-pipe="${i}"`);
    }
  }
  for (const E of [p.pts[0], p.pts.at(-1)]) {                // flanges at the nozzles
    const [fx, fy] = P(E.x, E.y, E.z);
    push(depthOf(E.x, E.z) + 0.003, `<circle class="o" cx="${f(fx)}" cy="${f(fy)}" r="${f(pr.r * 1.45)}" fill="${dark(fill, 0.25)}"/>`, ` data-pipe="${i}"`);
  }
}

// ------------------------------------------------------------------ scene
let site = null;
const labelsOf = [];
function draw() {
  prims = []; seq = 0; bounds = [Infinity, Infinity, -Infinity, -Infinity]; itemBounds.clear();
  const ground = [], labels = [];
  // slabs first: areas, then unit pads on top of them
  const slab = (it, h, y0, color) => {
    cur = it.node.id;
    const before = prims.length;
    box(it.wx, y0, it.wz, it.w, h, it.d, color, "slab");
    ground.push(...prims.splice(before));
    cur = null;
  };
  for (const a of site.areas) slab(a, 0.5, 0, COL.slab);
  for (const a of site.areas) for (const u of a.children) slab(u, 0.3, 0.5, u.node.template === "Wellfield" ? COL.field : COL.pad);
  ground.sort((p, q) => p.d - q.d || p.s - q.s);
  for (const it of site.items) if (it.depth >= 3) drawEquipment(it);
  site.pipes.forEach(drawPipe);
  // pipe racks: bents (two posts and cross beams under the pipes and on top) joined by longitudinal beams
  for (const rk of site.racks) for (let rx = rk.x0; rx <= rk.x1; rx += 8) {
    for (const z of [rk.z + 2.2, rk.z - 5.6]) {
      box(rx, 0, z, 0.35, 11, 0.35, COL.steel);
      if (rx + 8 <= rk.x1) box(rx + 4, 10.5, z, 7.65, 0.3, 0.3, COL.steel);
    }
    for (const y of [6.3, 10.5]) box(rx, y, rk.z - 1.7, 0.3, 0.3, 8.2, COL.steel);
  }
  const cn = site.connector;                     // cross rack between the two rows
  if (cn) for (let rz = cn.z0 + 4; rz <= cn.z1 - 4; rz += 8) {
    for (const x of [cn.x - 1, cn.x + 6]) {
      box(x, 0, rz, 0.35, 11, 0.35, COL.steel);
      if (rz + 8 <= cn.z1 - 4) box(x, 10.5, rz + 4, 0.3, 0.3, 7.65, COL.steel);
    }
    for (const y of [6.3, 10.5]) box(cn.x + 2.5, y, rz, 8.2, 0.3, 0.3, COL.steel);
  }
  prims.sort((p, q) => p.d - q.d || p.s - q.s);
  // labels on top of everything
  for (const it of site.items) {
    if (it.depth === 0) continue;
    const kind = it.depth === 1 ? "area" : it.depth === 2 ? "wc" : "eq";
    const [lx, ly] = kind === "eq" ? P(it.wx, GROUND + it.part.h + 1.2, it.wz) : P(it.wx, 1, it.wz + it.d / 2 - (kind === "wc" ? 0.6 : 0));
    labels.push(`<text class="lab ${kind}" data-lab="${it.node.id}" x="${f(lx)}" y="${f(ly)}">${esc(it.node.name)}</text>`);
  }
  svg.innerHTML = `<defs>${[...grads.values()].join("")}</defs><g class="ground">${ground.map(p => p.t).join("")}</g><g class="things">${prims.map(p => p.t).join("")}</g><g class="labels">${labels.join("")}</g>`;
  // areas and units cover their children too
  for (const it of site.items) if (it.depth > 0 && it.depth < 3) {
    const b = itemBounds.get(it.node.id) || [Infinity, Infinity, -Infinity, -Infinity];
    const add = n => { const c = itemBounds.get(n.node.id); if (c) { grow(b, c[0], c[1]); grow(b, c[2], c[3]); } n.children.forEach(add); };
    it.children.forEach(add);
    itemBounds.set(it.node.id, b);
  }
  mark("sel", ctx.selected); mark("hov", hovered);
  if (site) markPipes();
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ------------------------------------------------------------------ view box: pan, zoom, fit
// While you pan or zoom, the drawing already on screen is just moved and scaled as one layer (no
// repaint); the real view box is set, and the SVG redrawn sharp, once the gesture stops.
let vb = { x: 0, y: 0, w: 100, h: 100 }, drawn = vb, fit0 = 1, anim = null, lastScale = 1, settle = null;
const scale = () => svg.clientWidth / vb.w;              // screen px per unit
function setVB(v, { now = false } = {}) {
  vb = v; lastScale = scale();
  clearTimeout(settle);
  if (now) return commitVB();
  const k = drawn.w / vb.w, s1 = lastScale;
  svg.style.transform = `translate(${f((drawn.x - vb.x) * s1)}px, ${f((drawn.y - vb.y) * s1)}px) scale(${k.toFixed(5)})`;
  settle = setTimeout(commitVB, 140);
}
function commitVB() {
  drawn = vb;
  svg.setAttribute("viewBox", `${f(vb.x)} ${f(vb.y)} ${f(vb.w)} ${f(vb.h)}`);
  svg.style.transform = "";
  const k = 1 / scale(), z = scale() / fit0 * Math.min(1, window.innerWidth / 1100);
  svg.style.setProperty("--k", k.toFixed(4));
  svg.dataset.tier = z > 3.6 ? 2 : z > 1.7 ? 1 : 0;
}
function fitTo(b, fill, { instant = false } = {}) {
  const W = svg.clientWidth, H = svg.clientHeight, o = svg.getBoundingClientRect(), fa = freeArea();
  const left = fa.left - o.left, right = fa.right - o.left, top = fa.top - o.top, bottom = fa.bottom - o.top;
  const bw = Math.max(1, b[2] - b[0]), bh = Math.max(1, b[3] - b[1]);
  const s = Math.min((right - left) / bw, (bottom - top) / bh) * fill;
  const target = { w: W / s, h: H / s, x: (b[0] + b[2]) / 2 - ((left + right) / 2) / s, y: (b[1] + b[3]) / 2 - ((top + bottom) / 2) / s };
  if (instant || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { cancelAnimationFrame(anim); setVB(target, { now: true }); return; }
  const from = { ...vb }, t0 = performance.now();
  cancelAnimationFrame(anim);
  const step = now => {
    const p = Math.min(1, (now - t0) / 380), e = 1 - Math.pow(1 - p, 3);
    setVB({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, w: from.w + (target.w - from.w) * e, h: from.h + (target.h - from.h) * e });
    if (p < 1) anim = requestAnimationFrame(step);
  };
  anim = requestAnimationFrame(step);
}
function zoomAt(px, py, factor) {
  const s = scale(), ns = Math.max(fit0 * 0.4, Math.min(fit0 * 40, s * factor)), k = s / ns;
  const ux = vb.x + px / s, uy = vb.y + py / s;
  setVB({ w: vb.w * k, h: vb.h * k, x: ux - (ux - vb.x) * k, y: uy - (uy - vb.y) * k });
}
const siteBounds = () => bounds;
function home(instant) {
  fitTo(siteBounds(), 0.94, { instant });
  if (instant) { fit0 = scale(); setVB(vb, { now: true }); }      // label tiers are relative to the whole-site view
}
const boundsOf = it => itemBounds.get(it.node.id) || siteBounds();
const pad = (b, p) => [b[0] - p, b[1] - p, b[2] + p, b[3] + p];

// ------------------------------------------------------------------ selection, hover
let hovered = null;
function mark(cls, it) {
  for (const e of svg.querySelectorAll(`.${cls}`)) e.classList.remove(cls);
  if (!it) return;
  for (const e of svg.querySelectorAll(`[data-id="${CSS.escape(it.node.id)}"], [data-lab="${CSS.escape(it.node.id)}"]`)) e.classList.add(cls);
}
function select(it, { fly = true } = {}) {
  ctx.selected = it && it.depth > 0 ? it : null;
  mark("sel", ctx.selected);
  showSelection(select);
  markPipes(); summary();
  if (fly) ctx.selected ? fitTo(pad(boundsOf(ctx.selected), 3), ctx.selected.depth >= 3 ? 0.5 : 0.85) : home(false);
}

// ------------------------------------------------------------------ pointer: pan, pinch, click, hover
const tip = $("tip"), ptrs = new Map();
let downAt = null, moved = false;
svg.addEventListener("pointerdown", e => {
  svg.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, [e.clientX, e.clientY]);
  if (ptrs.size === 1) { downAt = [e.clientX, e.clientY]; moved = false; }
  cancelAnimationFrame(anim); tip.hidden = true;
});
svg.addEventListener("pointermove", e => {
  const prev = ptrs.get(e.pointerId);
  if (!prev) { onHover(e); return; }
  if (ptrs.size === 1) {
    const s = scale();
    if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) moved = true;
    if (moved) setVB({ ...vb, x: vb.x - (e.clientX - prev[0]) / s, y: vb.y - (e.clientY - prev[1]) / s });
  } else if (ptrs.size === 2) {
    moved = true;
    const [o] = [...ptrs.entries()].filter(([id]) => id !== e.pointerId).map(([, p]) => p);
    const d0 = Math.hypot(prev[0] - o[0], prev[1] - o[1]), d1 = Math.hypot(e.clientX - o[0], e.clientY - o[1]);
    const r = svg.getBoundingClientRect();
    zoomAt((e.clientX + o[0]) / 2 - r.left, (e.clientY + o[1]) / 2 - r.top, d1 / (d0 || 1));
    const s = scale();
    setVB({ ...vb, x: vb.x - (e.clientX - prev[0]) / 2 / s, y: vb.y - (e.clientY - prev[1]) / 2 / s });
  }
  ptrs.set(e.pointerId, [e.clientX, e.clientY]);
});
const endPtr = e => {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  if (ptrs.size || moved || e.type === "pointercancel") return;
  const t = document.elementFromPoint(e.clientX, e.clientY), g = t && t.closest("[data-id], [data-pipe]");
  if (g?.dataset.id) select(site.byId[g.dataset.id]);
  else if (g?.dataset.pipe) select(site.pipes[+g.dataset.pipe].from);
  else if (ctx.selected) select(null, { fly: false });
};
svg.addEventListener("pointerup", endPtr);
svg.addEventListener("pointercancel", endPtr);
svg.addEventListener("wheel", e => {
  e.preventDefault();
  const r = svg.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0015)));
}, { passive: false });
function onHover(e) {
  if (e.pointerType !== "mouse") return;
  const g = e.target.closest && e.target.closest("[data-id], [data-pipe]");
  const it = g?.dataset.id ? site.byId[g.dataset.id] : null;
  if (it !== hovered) { hovered = it; mark("hov", it && it !== ctx.selected ? it : null); }
  svg.style.cursor = g ? "pointer" : "";
  if (g?.dataset.pipe) { tip.replaceChildren(...pipeTip(site.pipes[+g.dataset.pipe])); placeTip(tip, e); } else tip.hidden = true;
}
svg.addEventListener("pointerleave", () => { tip.hidden = true; hovered = null; mark("hov", null); });
// keyboard: arrows pan, +/- zoom
svg.addEventListener("keydown", e => {
  const s = scale(), step = 60 / s;
  const k = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (k) { e.preventDefault(); setVB({ ...vb, x: vb.x + k[0], y: vb.y + k[1] }); }
  else if (e.key === "+" || e.key === "=") zoomAt(svg.clientWidth / 2, svg.clientHeight / 2, 1.25);
  else if (e.key === "-") zoomAt(svg.clientWidth / 2, svg.clientHeight / 2, 0.8);
});

// ------------------------------------------------------------------ data + page
function applyValues() {
  updatePipes();
  draw();
  $("asof").textContent = asOfText();
  const fr = U.freshness(ctx.asOf, ctx.live), pe = $("pierr");
  const why = !ctx.live && U.state.piError ? `Why not live: ${U.state.piError}` : (ctx.asOf || ctx.live ? fr.stale : null);
  pe.hidden = !why; pe.textContent = why || "";
  renderTreeDots(); summary();
  if (ctx.selected) renderInfo(ctx.selected, select);
}
async function refresh() {
  try { await fetchValues(); applyValues(); } catch (e) { $("asof").textContent = `Could not read PI values: ${e.message}`; }
}

function openSite(code, elementId) {
  site = ctx.site = layoutSite(code, sizeOf);
  ctx.selected = null;
  $("site").value = code;
  $("mapBtn").href = `topo.html#${code}`;
  initialValues(code);
  updatePipes(); draw();
  home(true);
  $("asof").textContent = asOfText();
  const it = elementId && site.byId[elementId];
  select(it || null, { fly: !!it });
  refresh();
}

// Signal's "one highlight, grey the rest": with something selected, only its own pipes keep full colour
function markPipes() {
  const sel = ctx.selected, inside = new Set();
  const add = it => { inside.add(it); it.children.forEach(add); };
  if (sel) add(sel);
  const on = new Set(site.pipes.map((p, i) => inside.has(p.from) || inside.has(p.to) ? i : -1).filter(i => i >= 0));
  svg.classList.toggle("focus", on.size > 0);
  for (const g of svg.querySelectorAll("[data-pipe]")) g.classList.toggle("on", on.has(+g.dataset.pipe));
}

// top bar, second line: the AF path of the selection, or the site in one sentence
function summary() {
  const sum = $("summary"), crumbs = $("crumbs"), v = ctx.values;
  crumbs.hidden = !ctx.selected; sum.hidden = !!ctx.selected;
  if (ctx.selected) return;
  const thru = +v[`${site.root.node.tag}.CDU100.THRU`];
  const wells = site.items.filter(it => it.node.template.startsWith("Well - "));
  const producing = wells.filter(it => v[`${it.node.tag}.STATUS`] === "Producing").length;
  const problems = site.items.filter(it => {
    const a = it.depth >= 2 && statusAttr(it), st = a && STATUS_LEVEL[v[`${it.node.tag}.${a[1]}`]];
    return st === "warning" || st === "critical";
  });
  sum.replaceChildren(
    Number.isFinite(thru) ? `${fmt(thru)} bbl/d into the crude unit · ` : "",
    `${producing} of ${wells.length} wells producing · `,
    problems.length ? Object.assign(document.createElement("b"), { textContent: `${problems.length} ${problems.length > 1 ? "items need" : "item needs"} attention` }) : "all equipment normal");
  const fr = U.freshness(ctx.asOf, ctx.live);
  if (fr.short) sum.append(" · ", Object.assign(document.createElement("b"), { textContent: fr.short, title: fr.stale }));
}

// left pane: a rail when collapsed, expanded on demand; on phones a drawer
function setPane(open) {
  const keep = lastScale;
  document.body.classList.toggle("pane-open", open);
  try { localStorage.setItem("cp.plant.pane", open ? "open" : "closed"); } catch (_) { /* no storage */ }
  if (window.innerWidth > 700) setVB({ ...vb, w: svg.clientWidth / keep, h: svg.clientHeight / keep }, { now: true });
  if (open) $("treeBody").querySelector(".nm.on, .nm")?.focus({ preventScroll: true });
}

async function main() {
  try { await U.load(); } catch (e) { $("err").hidden = false; $("err").textContent = `Could not load data: ${e.message}`; return; }
  const fromHash = wirePage({ openSite, select, home: () => home(false) });
  for (const b of document.querySelectorAll("[data-open]")) b.addEventListener("click", () => setPane(true));
  $("paneClose").addEventListener("click", () => setPane(false));
  $("paneBtn").addEventListener("click", () => setPane(!document.body.classList.contains("pane-open")));
  // double-click on empty ground: back to the whole site
  svg.addEventListener("dblclick", e => { if (!e.target.closest("[data-id], [data-pipe]")) { select(null, { fly: false }); home(false); } });
  let paneOpen = null;
  try { paneOpen = localStorage.getItem("cp.plant.pane"); } catch (_) { /* no storage */ }
  if (window.innerWidth > 700 && paneOpen !== "closed") document.body.classList.add("pane-open");
  let t;
  window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => setVB({ ...vb, w: svg.clientWidth / lastScale, h: svg.clientHeight / lastScale }, { now: true }), 100); });
  fromHash();
  setInterval(refresh, (CFG.refreshSeconds || 60) * 1000);
}
main();
