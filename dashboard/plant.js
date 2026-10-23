// 3D plant: one site's AF hierarchy (areas -> units -> equipment) as an isometric model,
// with product flows from the wells to the product tanks driven by live PI values.
import * as THREE from "three";
import { OrbitControls } from "./vendor/three/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "./vendor/three/CSS2DRenderer.js";

const U = window.CP_UI, P = window.CP_PLANT, { M, SITES, CFG, state, el, fmt } = U;
const $ = id => document.getElementById(id);

// ------------------------------------------------------------------ look
const COL = {
  bg: 0xe6f5ee, ground: 0xd9efe4, slab: 0xf6f8f8, pad: 0xe6ecee, body: 0xfafbfc, body2: 0xdde4ea, steel: 0xaeb9c3,
  dark: 0x4a5866, ink: 0x1f2d3a, cellar: 0x9aa7b2, flame: 0xff9a3c, sel: 0x1f2d3a, hover: 0x3f9d1c,
};
const LEVEL_COL = { good: 0x7ed957, warning: 0xf5b82e, critical: 0xe5484d, planned: 0xaab4bd };
const LEVEL_CSS = { good: "var(--good)", warning: "var(--warning)", critical: "var(--critical)", planned: "var(--planned)" };
const PRODUCTS = {
  crude: { label: "Crude oil", color: 0x9a6a36, r: 0.34 },
  gasoline: { label: "Naphtha / gasoline", color: 0xf2c230, r: 0.24 },
  jet: { label: "Jet / kerosene", color: 0x48a8dc, r: 0.24 },
  diesel: { label: "Diesel", color: 0xe9743a, r: 0.26 },
  residue: { label: "Residue / fuel oil", color: 0x4b4450, r: 0.3 },
  gas: { label: "Recycle gas", color: 0xa48ad8, r: 0.2 },
  steam: { label: "Steam", color: 0xc9d2d9, r: 0.18 },
  water: { label: "Cooling water", color: 0x52c6d6, r: 0.2 },
};
const TANK_PRODUCT = { "Crude Oil": "crude", "Gasoline": "gasoline", "Jet Kerosene": "jet", "Diesel": "diesel", "Fuel Oil": "residue" };
const STATUS_LEVEL = { ...U.WELL_LEVEL, ...U.UNIT_LEVEL, Running: "good", Stopped: "planned", Tripped: "critical", Maintenance: "warning" };

// process flows between AF elements (element id suffix), the PI attribute that measures them and where
// they leave / enter the equipment (fraction of its height)
const FLOWS = [
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

// ------------------------------------------------------------------ renderer
const canvas = $("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setClearColor(COL.bg);
const labelRenderer = new CSS2DRenderer({ element: $("labels") });
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0xb9cbc2, 2.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.5); sun.position.set(60, 120, 90); scene.add(sun);
const FRUSTUM = 140;
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -2000, 4000);
// standard angle: from the front-left; on portrait screens from the side, so the row runs top to bottom
const viewDir = () => (window.innerWidth / window.innerHeight < 0.8 ? new THREE.Vector3(1.4, 1.1, 0.42) : new THREE.Vector3(1, 1.05, 1.3)).normalize();
const controls = new OrbitControls(camera, canvas);
Object.assign(controls, { enableDamping: true, dampingFactor: 0.12, minZoom: 0.08, maxZoom: 14, maxPolarAngle: 1.4, screenSpacePanning: true, zoomToCursor: true });

function resize() {
  const w = window.innerWidth, h = window.innerHeight, a = w / h;
  renderer.setSize(w, h, false); labelRenderer.setSize(w, h);
  camera.left = -FRUSTUM * a / 2; camera.right = FRUSTUM * a / 2; camera.top = FRUSTUM / 2; camera.bottom = -FRUSTUM / 2;
  camera.updateProjectionMatrix();
  outlineMat.uniforms.res.value.set(w, h);
}

// ------------------------------------------------------------------ materials
const mats = new Map();
function mat(color, opts = {}) {
  const k = `${color}|${JSON.stringify(opts)}`;
  if (!mats.has(k)) mats.set(k, new THREE.MeshLambertMaterial({ color, ...opts }));
  return mats.get(k);
}
const lineMat = new THREE.LineBasicMaterial({ color: COL.ink, transparent: true, opacity: 0.85 });
// silhouette lines: back faces pushed out by a constant number of pixels (illustration look)
const outlineMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  uniforms: { res: { value: new THREE.Vector2(1, 1) }, px: { value: 1.3 }, color: { value: new THREE.Color(COL.ink) } },
  vertexShader: `uniform vec2 res; uniform float px;
    void main() {
      vec4 c = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      vec3 n = normalize(mat3(projectionMatrix) * normalMatrix * normal);
      vec2 d = length(n.xy) > 1e-4 ? normalize(n.xy) : vec2(0.0);
      c.xy += d * px * 2.0 / res * c.w;
      c.z += 0.0004 * c.w;
      gl_Position = c;
    }`,
  fragmentShader: `uniform vec3 color; void main() { gl_FragColor = vec4(color, 1.0); }`,
});

function mesh(geo, material, parent, x = 0, y = 0, z = 0, { edges = true, outline = true } = {}) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  if (outline) m.add(new THREE.Mesh(geo, outlineMat));
  if (edges) m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), lineMat));
  parent.add(m);
  return m;
}
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (r, h, s = 24, r2 = r) => new THREE.CylinderGeometry(r2, r, h, s);

// ------------------------------------------------------------------ equipment builders
// each returns { g, w, d, h, accent: [materials to colour by status], update(values, tags) }
function accentMat() { return new THREE.MeshLambertMaterial({ color: LEVEL_COL.planned }); }

function tank(node) {
  const g = new THREE.Group(), p = node.props;
  const r = Math.max(2.6, Math.min(6.2, (p.Diameter || 40) * 0.3048 * 0.3));
  const h = Math.max(6, (p["Max Fill Height"] || 48) * 0.3048 * 0.55);
  const prod = PRODUCTS[TANK_PRODUCT[p.Product] || "crude"];
  mesh(cyl(r, h, 40), mat(COL.body), g, 0, h / 2, 0);
  const fill = mesh(cyl(r + 0.04, 1, 40), mat(prod.color), g, 0, 0, 0, { outline: false });
  mesh(cyl(r + 0.1, 0.9, 40, r * 0.12), mat(COL.body2), g, 0, h + 0.45, 0);
  for (let i = 0; i < 10; i++) {                                 // stair up the side
    const a = -0.6 + i * 0.13;
    mesh(box(0.7, 0.08, 0.3), mat(COL.steel), g, Math.sin(a) * (r + 0.4), 0.6 + i * (h - 1) / 10, Math.cos(a) * (r + 0.4), { outline: false });
  }
  return {
    g, w: 2 * r + 1, d: 2 * r + 1, h, accent: [],
    update(v) {
      const lvl = +v[`${node.tag}.LVL`], frac = Math.max(0.01, Math.min(1, (lvl || 0) / (p["Max Fill Height"] || 48)));
      fill.scale.y = h * frac; fill.position.y = h * frac / 2;
    },
  };
}

function column(node, vacuum) {
  const g = new THREE.Group(), a = accentMat();
  const r = vacuum ? 1.9 : 1.45, h = vacuum ? 16 : 23;
  mesh(cyl(r * 1.08, 2, 24), mat(COL.body2), g, 0, 1, 0);
  if (vacuum) {
    mesh(cyl(r * 0.7, h * 0.35, 24), mat(COL.body), g, 0, 2 + h * 0.175, 0);
    mesh(cyl(r * 0.7, h * 0.2, 24, r), mat(COL.body), g, 0, 2 + h * 0.45, 0);
    mesh(cyl(r, h * 0.45, 24), mat(COL.body), g, 0, 2 + h * 0.775, 0);
  } else mesh(cyl(r, h, 24), mat(COL.body), g, 0, 2 + h / 2, 0);
  const top = new THREE.SphereGeometry(r, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  mesh(top, mat(COL.body), g, 0, 2 + h, 0);
  mesh(cyl(r + 0.06, 0.6, 24), a, g, 0, 2 + h * 0.55, 0, { outline: false });
  for (let y = 5; y < h; y += 5) mesh(cyl(r + 0.7, 0.12, 24), mat(COL.steel), g, 0, 2 + y, 0, { outline: false });
  mesh(box(0.35, h, 0.35), mat(COL.steel), g, r + 0.5, 2 + h / 2, 0, { outline: false });
  return { g, w: 2 * r + 2, d: 2 * r + 2, h: h + 2 + r, accent: [a] };
}

function heater(node) {
  const g = new THREE.Group(), a = accentMat();
  mesh(box(5, 0.6, 4.2), mat(COL.body2), g, 0, 0.3, 0);
  mesh(box(4.4, 5.5, 3.6), mat(COL.body), g, 0, 3.35, 0);
  mesh(box(4.45, 0.5, 3.65), a, g, 0, 1.2, 0, { outline: false });
  mesh(box(2.4, 1.4, 2.2), mat(COL.body), g, 0, 6.8, 0);
  mesh(cyl(0.55, 7, 16, 0.42), mat(COL.body2), g, 0, 11, 0);
  const flame = new THREE.MeshLambertMaterial({ color: 0x5b6670, emissive: 0x000000 });
  for (const x of [-1.2, 0, 1.2]) mesh(box(0.6, 0.5, 0.05), flame, g, x, 2.3, 1.82, { outline: false, edges: false });
  return {
    g, w: 5.5, d: 4.6, h: 14.5, accent: [a],
    update(v) { const on = +v[`${node.tag}.QFG`] > 1; flame.color.set(on ? COL.flame : 0x5b6670); flame.emissive.set(on ? 0x8a3a00 : 0); },
  };
}

function pump(node) {
  const g = new THREE.Group(), a = accentMat();
  mesh(box(3.4, 0.35, 1.5), mat(COL.dark), g, 0, 0.18, 0);
  const motor = mesh(cyl(0.5, 1.5, 20), a, g, -0.7, 0.95, 0); motor.rotation.z = Math.PI / 2;
  const casing = mesh(cyl(0.62, 0.55, 20), mat(COL.body), g, 0.85, 0.95, 0); casing.rotation.x = Math.PI / 2;
  mesh(cyl(0.18, 1.2, 12), mat(COL.steel), g, 0.85, 1.6, 0);
  return { g, w: 3.8, d: 2, h: 1.9, accent: [a] };
}

function hvessel(node, len, r, extra) {
  const g = new THREE.Group(), a = accentMat(), y = r + 0.9;
  const v = mesh(new THREE.CapsuleGeometry(r, len, 8, 24), mat(COL.body), g, 0, y, 0); v.rotation.z = Math.PI / 2;
  const band = mesh(cyl(r + 0.05, 0.4, 24), a, g, 0, y, 0, { outline: false }); band.rotation.z = Math.PI / 2;
  for (const x of [-len * 0.32, len * 0.32]) mesh(box(0.5, y, r * 1.5), mat(COL.body2), g, x, y / 2, 0);
  if (extra) extra(g, y, r);
  return { g, w: len + 2 * r + 0.6, d: 2 * r + 1, h: y + r, accent: [a] };
}

function reactor(node) {
  const g = new THREE.Group(), a = accentMat(), r = 1.35, h = 7.5;
  mesh(cyl(r * 1.05, 2.4, 24), mat(COL.body2), g, 0, 1.2, 0);
  mesh(new THREE.CapsuleGeometry(r, h, 8, 24), mat(COL.body), g, 0, 2.4 + r + h / 2, 0);
  mesh(cyl(r + 0.05, 0.5, 24), a, g, 0, 2.4 + h * 0.6, 0, { outline: false });
  mesh(cyl(r + 0.7, 0.12, 24), mat(COL.steel), g, 0, 2.4 + h + r, 0, { outline: false });
  return { g, w: 2 * r + 2, d: 2 * r + 2, h: 2.4 + h + 2 * r, accent: [a] };
}

function compressor(node) {
  const g = new THREE.Group(), a = accentMat();
  mesh(box(5, 0.4, 2.6), mat(COL.dark), g, 0, 0.2, 0);
  mesh(box(2.3, 2.1, 2.1), a, g, -1.2, 1.45, 0);
  const c = mesh(cyl(0.85, 2.2, 20), mat(COL.body), g, 1.3, 1.3, 0); c.rotation.z = Math.PI / 2;
  mesh(cyl(0.3, 1.4, 12), mat(COL.steel), g, 1.3, 2.6, 0);
  return { g, w: 5.4, d: 3, h: 3.3, accent: [a] };
}

function ejector(node) {
  const g = new THREE.Group(), a = accentMat();
  for (const x of [-1, 1]) mesh(box(0.25, 5, 0.25), mat(COL.steel), g, x, 2.5, 0.8, { outline: false });
  for (const x of [-1, 1]) mesh(box(0.25, 5, 0.25), mat(COL.steel), g, x, 2.5, -0.8, { outline: false });
  mesh(box(2.5, 0.15, 2), mat(COL.steel), g, 0, 5, 0, { outline: false });
  for (const [y, r] of [[5.6, 0.32], [6.4, 0.26]]) { const e = mesh(cyl(r, 2.6, 16), mat(COL.body), g, 0, y, 0); e.rotation.z = Math.PI / 2; }
  mesh(cyl(0.65, 3, 20), mat(COL.body), g, 0, 1.6, 0);
  mesh(cyl(0.7, 0.4, 20), a, g, 0, 2.6, 0, { outline: false });
  return { g, w: 3.2, d: 2.4, h: 6.8, accent: [a] };
}

function boiler(node) {
  const g = new THREE.Group(), a = accentMat();
  mesh(box(6.5, 3.8, 3.6), mat(COL.body), g, 0, 1.9, 0);
  mesh(box(6.55, 0.5, 3.65), a, g, 0, 0.6, 0, { outline: false });
  const drum = mesh(new THREE.CapsuleGeometry(0.7, 4.2, 6, 20), mat(COL.body2), g, 0, 4.5, 0); drum.rotation.z = Math.PI / 2;
  mesh(cyl(0.45, 6, 16, 0.35), mat(COL.body2), g, 2.6, 6.8, -1);
  return { g, w: 7, d: 4, h: 9.8, accent: [a] };
}

function coolingTower(node) {
  const g = new THREE.Group(), a = accentMat(), fans = [];
  mesh(box(10, 0.6, 4.6), mat(0x9fd8e0), g, 0, 0.3, 0);
  mesh(box(9.4, 4, 4), mat(COL.body), g, 0, 2.6, 0);
  for (let y = 1.2; y < 4.4; y += 0.7) mesh(box(9.45, 0.12, 4.05), mat(COL.body2), g, 0, y, 0, { outline: false, edges: false });
  for (const x of [-3.1, 0, 3.1]) {
    mesh(cyl(1.35, 1.2, 28), a, g, x, 5.2, 0);
    const f = new THREE.Group(); f.position.set(x, 5.85, 0);
    for (let i = 0; i < 4; i++) { const b = mesh(box(2.2, 0.06, 0.35), mat(COL.dark), f, 0, 0, 0, { outline: false }); b.rotation.y = i * Math.PI / 4; }
    g.add(f); fans.push(f);
  }
  let on = false;
  return {
    g, w: 10.5, d: 5, h: 6.2, accent: [a],
    update(v) { on = v[`${node.tag}.STATUS`] === "Running"; },
    tick(dt) { if (on) fans.forEach(f => { f.rotation.y += dt * 4; }); },
  };
}

function pipeline(node) {
  const g = new THREE.Group(), a = accentMat(), len = 16;
  const pp = mesh(cyl(0.4, len, 16), mat(COL.body2), g, 0, 0.9, 0); pp.rotation.z = Math.PI / 2;
  for (let x = -len / 2 + 1; x <= len / 2 - 1; x += 2.5) mesh(box(0.3, 0.5, 1.2), mat(COL.dark), g, x, 0.25, 0, { outline: false });
  for (const x of [-len / 2, len / 2]) { const f = mesh(cyl(0.55, 0.3, 16), a, g, x, 0.9, 0); f.rotation.z = Math.PI / 2; }
  return { g, w: len + 1, d: 2, h: 1.5, accent: [a], ports: { out: new THREE.Vector3(len / 2, 0.9, 0), in: new THREE.Vector3(-len / 2, 0.9, 0) } };
}

function well(node) {
  const g = new THREE.Group(), a = accentMat(), lift = node.props["Lift Method"];
  mesh(box(3.2, 0.25, 3.2), mat(COL.cellar), g, 0, 0.12, 0, { outline: false });
  // wellhead ("christmas tree")
  mesh(cyl(0.32, 1.8, 14), mat(COL.body2), g, 0, 1.15, 0);
  mesh(cyl(0.4, 0.35, 14), a, g, 0, 2.0, 0, { outline: false });
  const arm = mesh(cyl(0.16, 1.6, 10), mat(COL.body2), g, 0, 1.4, 0); arm.rotation.z = Math.PI / 2;
  for (const x of [-0.8, 0.8]) { const w = mesh(new THREE.TorusGeometry(0.22, 0.05, 6, 14), mat(0xd04a3a), g, x, 1.4, 0.2, { outline: false }); w.rotation.y = 0; }
  let tick = null, spm = 0, phase = Math.random() * 6;
  if (lift === "Rod Pump") {
    const base = -2.6;
    mesh(box(5.5, 0.35, 1.3), mat(COL.dark), g, base + 1.2, 0.3, 0);
    for (const z of [-0.45, 0.45]) { const l = mesh(box(0.22, 3.6, 0.22), mat(COL.dark), g, base + 1.6, 2.2, z, { outline: false }); l.rotation.x = z > 0 ? -0.12 : 0.12; }
    const beam = new THREE.Group(); beam.position.set(base + 1.6, 3.9, 0); g.add(beam);
    mesh(box(5.2, 0.38, 0.38), a, beam, 0.6, 0, 0);
    mesh(box(0.5, 1.3, 0.5), mat(COL.body2), beam, 3.25, -0.35, 0);           // horsehead over the well
    mesh(box(0.9, 0.6, 0.6), mat(COL.dark), beam, -2, -0.1, 0);
    const crank = new THREE.Group(); crank.position.set(base - 0.6, 1.5, 0); g.add(crank);
    for (const z of [-0.55, 0.55]) mesh(box(1.6, 0.5, 0.18), mat(COL.dark), crank, 0.5, 0, z, { outline: false });
    mesh(box(1.3, 0.9, 1.1), mat(COL.body2), g, base - 1.7, 0.75, 0);         // gearbox + motor
    tick = dt => { if (spm > 0) phase += dt * spm / 60 * Math.PI * 2; beam.rotation.z = Math.sin(phase) * 0.22; crank.rotation.z = -phase; };
  } else if (lift === "ESP") {
    mesh(box(0.9, 1.8, 0.5), mat(COL.body), g, -2.2, 0.9 + 0.25, 0);
    mesh(box(0.92, 0.3, 0.52), a, g, -2.2, 1.7, 0, { outline: false });
  } else if (lift === "PCP") {
    mesh(cyl(0.45, 1.1, 16), mat(COL.dark), g, 0, 2.75, 0);
    const mtr = mesh(cyl(0.38, 1.2, 16), a, g, 0.55, 3.0, 0); mtr.rotation.z = Math.PI / 2;
  } else if (lift === "Gas Lift") {
    const inj = mesh(cyl(0.12, 2.5, 8), mat(PRODUCTS.gas.color), g, -1.4, 0.5, 0); inj.rotation.z = Math.PI / 2;
    mesh(box(0.7, 0.9, 0.6), mat(COL.body), g, -2.4, 0.7, 0);
  }
  return {
    g, w: lift === "Rod Pump" ? 7.5 : 4.5, d: 3.6, h: lift === "Rod Pump" ? 5 : 2.6, accent: [a],
    ports: { out: new THREE.Vector3(0, 0.5, 0) },
    update(v) { spm = v[`${node.tag}.STATUS`] === "Producing" ? (+v[`${node.tag}.SPM`] || 6) : 0; },
    tick: tick && (dt => tick(dt)),
  };
}

function generic(node) {
  const g = new THREE.Group(), a = accentMat();
  mesh(box(3, 2.4, 3), mat(COL.body), g, 0, 1.2, 0);
  mesh(box(3.05, 0.4, 3.05), a, g, 0, 0.5, 0, { outline: false });
  return { g, w: 3.5, d: 3.5, h: 2.4, accent: [a] };
}

function build(node) {
  switch (node.template) {
    case "Tank": return tank(node);
    case "Atmospheric Column": return column(node, false);
    case "Vacuum Column": return column(node, true);
    case "Fired Heater": return heater(node);
    case "Pump": return pump(node);
    case "Separator": return node.id.endsWith("V-301") ? hvessel(node, 3.2, 0.9) : hvessel(node, 5, 1.15);
    case "Desalter": return hvessel(node, 6, 1.3, (g, y, r) => mesh(box(1.2, 0.8, 1), mat(COL.dark), g, 0, y + r + 0.4, 0));
    case "Reactor": return reactor(node);
    case "Compressor": return compressor(node);
    case "Vacuum Ejector System": return ejector(node);
    case "Boiler": return boiler(node);
    case "Cooling Tower": return coolingTower(node);
    case "Pipeline": return pipeline(node);
    default: return node.template.startsWith("Well") ? well(node) : generic(node);
  }
}

// ------------------------------------------------------------------ layout from the AF tree
// Process areas sit in a row in AF order (which is the flow order); a pipe rack runs behind them and
// the utilities sit behind the rack. Units are pads inside their area, equipment sits on its unit pad.
const GAP = 2.6, PAD = 2.6, AREA_GAP = 9, RACK_GAP = 5;

let site = null;               // current site: { code, root, byId, items, pipes, ... }

function slab(w, d, h, color, parent, x, z, y = 0) {
  return mesh(box(w, h, d), mat(color), parent, x, y + h / 2, z, { outline: false });
}

function layoutWellfield(wc) {
  const wells = wc.children, n = wells.length;
  const lats = wells.map(w => w.node.props["Location|Latitude"]), lons = wells.map(w => w.node.props["Location|Longitude"]);
  const la0 = Math.min(...lats), la1 = Math.max(...lats), lo0 = Math.min(...lons), lo1 = Math.max(...lons);
  const S = Math.max(26, Math.min(40, Math.sqrt(n) * 12));
  const span = Math.max(la1 - la0, (lo1 - lo0) * Math.cos(la0 * Math.PI / 180)) || 1;
  // real relative positions, squeezed into a square, then pushed apart so the models don't touch
  let pts = wells.map((w, i) => [((lons[i] - (lo0 + lo1) / 2) * Math.cos(la0 * Math.PI / 180)) / span * S, -((lats[i] - (la0 + la1) / 2)) / span * S]);
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

function buildSite(code) {
  const root = P.sites[code], byId = {}, items = [], ticks = [];
  const group = new THREE.Group();
  // tree of layout nodes mirroring AF
  const wrap = (node, depth, parent) => {
    const it = { node, depth, parent, children: [], x: 0, z: 0, w: 0, d: 0 };
    byId[node.id] = it; items.push(it);
    if (depth >= 3) { it.part = build(node); }
    it.children = node.children.map(c => wrap(c, depth + 1, it));
    return it;
  };
  const top = wrap(root, 0, null);
  const areas = top.children, utilities = areas.filter(a => a.node.name === "Utilities"), process = areas.filter(a => !utilities.includes(a));
  areas.forEach(layoutArea);
  const rowW = process.reduce((a, c) => a + c.w, 0) + AREA_GAP * (process.length - 1);
  const rowD = Math.max(...process.map(a => a.d));
  let x = -rowW / 2;
  for (const a of process) { a.x = x + a.w / 2; a.z = (rowD - a.d) / 2 * 0; x += a.w + AREA_GAP; }
  const rackZ = -rowD / 2 - RACK_GAP;
  const utilW = utilities.reduce((a, c) => a + c.w, 0);
  // utilities behind the rack, centred on the distillation area (their main consumer)
  const cd = process.find(a => a.node.name === "Crude Distillation") || process[0];
  x = cd.x - utilW / 2;
  for (const a of utilities) { a.x = x + a.w / 2; a.z = rackZ - RACK_GAP - 6 - a.d / 2; x += a.w + AREA_GAP; }

  // place meshes; world position = area + unit + equipment offsets
  for (const a of areas) {
    a.wx = a.x; a.wz = a.z;
    a.mesh = slab(a.w, a.d, 0.5, COL.slab, group, a.wx, a.wz);
    for (const u of a.children) {
      u.wx = a.wx + u.x; u.wz = a.wz + u.z - 1.2;
      u.mesh = slab(u.w, u.d, 0.3, u.node.template === "Wellfield" ? 0xe2ecd9 : COL.pad, group, u.wx, u.wz, 0.5);
      for (const e of u.children) {
        e.wx = u.wx + e.x; e.wz = u.wz + e.z;
        e.part.g.position.set(e.wx, 0.8, e.wz);
        group.add(e.part.g);
        if (e.part.tick) ticks.push(e.part.tick);
      }
    }
  }
  // pickable meshes point back to their layout node
  for (const it of items) {
    const obj = it.part ? it.part.g : it.mesh;
    if (obj) obj.traverse(o => { if (o.isMesh && o.material !== outlineMat) o.userData.item = it; });
  }

  // ---------------------------------------------------------------- pipes
  const pipes = [], pipeGroup = new THREE.Group(); group.add(pipeGroup);
  const S = id => byId[`${code}-${id}`];
  const portOf = (it, frac, toward) => {
    const pt = it.part, base = new THREE.Vector3(it.wx, 0.8, it.wz);
    if (pt.ports) return base.add((toward === "in" ? pt.ports.in : pt.ports.out) || pt.ports.out);
    const y = Math.max(0.9, pt.h * frac);
    const face = it.wz > rackZ ? -1 : 1;                // the side facing the pipe rack
    return base.add(new THREE.Vector3(0, y, face * pt.d / 2 * 0.9));
  };
  let lane = 0;
  const addPipe = (pts, product, flowTag, from, to) => {
    const curve = new THREE.CurvePath();
    for (let i = 1; i < pts.length; i++) if (pts[i].distanceTo(pts[i - 1]) > 1e-3) curve.add(new THREE.LineCurve3(pts[i - 1], pts[i]));
    const len = curve.getLength(), pr = PRODUCTS[product];
    const tex = flowTexture(pr.color);
    tex.repeat.set(Math.max(1, len / 2.2), 1);
    const m = new THREE.MeshLambertMaterial({ map: tex });
    const tube = mesh(new THREE.TubeGeometry(curve, Math.max(8, Math.ceil(len * 3)), pr.r, 8, false), m, pipeGroup, 0, 0, 0, { edges: false });
    for (let i = 1; i < pts.length - 1; i++) mesh(new THREE.SphereGeometry(pr.r * 1.02, 10, 8), mat(pr.color), pipeGroup, pts[i].x, pts[i].y, pts[i].z, { edges: false });
    const pipe = { product, flowTag, tex, mat: m, from, to, speed: 0, flow: null };
    tube.userData.pipe = pipe;
    pipes.push(pipe);
  };
  // flowlines from each well to the production separator, along the ground
  const sep = S("SEP-001"), wf = byId[`${code}-WF`];
  // a header along the front of the wellfield, into the west end of the separator
  if (sep && wf) for (const w of wf.children) {
    const l = lane++, a = portOf(w, 0, "out"), y = 1.1;
    const b = new THREE.Vector3(sep.wx - sep.part.w / 2 + 0.4, 0.8 + 1.6, sep.wz);
    const zf = wf.wz + wf.d / 2 - 1.2 - (l % 4) * 0.35, xw = b.x - 1.2 - (l % 4) * 0.35;
    addPipe([a, new THREE.Vector3(a.x, y, a.z), new THREE.Vector3(a.x, y, zf), new THREE.Vector3(xw, y, zf), new THREE.Vector3(xw, b.y, b.z), b], "crude", `${w.node.tag}.QO`, w, sep);
  }
  // everything else over the pipe rack
  lane = 0;
  for (const [f, t, product, [fid, attr], ff = 0.5, tf = 0.5] of FLOWS) {
    const A = S(f), B = S(t), src = S(fid);
    if (!A || !B || !src) continue;
    const a = portOf(A, ff, "out"), b = portOf(B, tf, "in"), l = lane++;
    const zr = rackZ + 1.4 - (l % 7) * 0.75;
    const H = 7 + (l % 5) * 0.8;
    addPipe([a, new THREE.Vector3(a.x, a.y, zr), new THREE.Vector3(a.x, H, zr), new THREE.Vector3(b.x, H, zr), new THREE.Vector3(b.x, b.y, zr), b], product, `${src.node.tag}.${attr}`, A, B);
  }
  // the rack itself
  const x0 = process[0].x - process[0].w / 2 + 6, x1 = process.at(-1).x + process.at(-1).w / 2 - 4;
  for (let rx = x0; rx <= x1; rx += 8) {
    for (const z of [rackZ + 2.2, rackZ - 5.6]) mesh(box(0.35, 11, 0.35), mat(COL.steel), group, rx, 5.5, z, { outline: false });
    for (const y of [6.6, 10.5]) mesh(box(0.3, 0.3, 8.2), mat(COL.steel), group, rx, y, rackZ - 1.7, { outline: false });
  }

  // ---------------------------------------------------------------- labels
  for (const it of items) {
    if (it.depth === 0) continue;
    const kind = it.depth === 1 ? "area" : it.depth === 2 ? "wc" : "eq";
    const div = el("div", { class: `lab ${kind}` }, it.node.name);
    const lab = new CSS2DObject(div);
    if (kind === "area") lab.position.set(it.wx, 1, it.wz + it.d / 2);
    else if (kind === "wc") lab.position.set(it.wx, 1, it.wz + it.d / 2 - 0.6);
    else lab.position.set(it.wx, 0.8 + it.part.h + 1.2, it.wz);
    if (kind === "area") lab.center.set(0.5, 0);
    group.add(lab); it.label = lab; it.labelDiv = div;
  }

  scene.add(group);
  const bbox = new THREE.Box3().setFromObject(group);
  return { code, root: top, byId, items, pipes, group, ticks, bbox, rackZ };
}

function flowTexture(color) {
  const c = document.createElement("canvas"); c.width = 64; c.height = 4;
  const g = c.getContext("2d"), col = new THREE.Color(color);
  g.fillStyle = `#${col.getHexString()}`; g.fillRect(0, 0, 64, 4);
  g.fillStyle = `#${col.clone().lerp(new THREE.Color(0xffffff), 0.55).getHexString()}`; g.fillRect(0, 0, 18, 4);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function disposeSite() {
  if (!site) return;
  site.group.traverse(o => {
    if (o.isCSS2DObject) o.element.remove();
    if (o.geometry) o.geometry.dispose();
    if (o.material && o.material.map) o.material.map.dispose();
  });
  scene.remove(site.group);
  site = null;
}

// ------------------------------------------------------------------ live values
let values = {}, asOf = null, live = false;
const statusAttr = it => (P.templates[it.node.template] || []).find(a => /Status$/.test(a[0]));
function statusOf(it) {
  for (let n = it; n; n = n.parent) {
    const a = statusAttr(n);
    if (a) { const v = values[`${n.node.tag}.${a[1]}`]; return { text: v, level: STATUS_LEVEL[v] || "planned", own: n === it }; }
  }
  return { text: null, level: "planned", own: false };
}

function applyValues() {
  if (!site) return;
  for (const it of site.items) {
    if (!it.part) continue;
    const st = statusOf(it);
    it.part.accent.forEach(m => m.color.set(LEVEL_COL[st.level]));
    it.part.update && it.part.update(values);
  }
  for (const p of site.pipes) {
    const f = +values[p.flowTag];
    p.flow = Number.isFinite(f) ? f : null;
    const ref = p.product === "crude" || p.product === "residue" ? SITES[site.code].capacity * 0.6
      : ["gasoline", "jet", "diesel"].includes(p.product) ? SITES[site.code].capacity * 0.2 : null;
    p.speed = !(f > 0.5) ? 0 : ref ? 0.25 + 1.6 * Math.min(1, f / ref) : 0.7;
    p.mat.color.set(p.speed ? 0xffffff : 0xb8c0c6);
  }
  $("asof").textContent = asOf ? `${live ? "Live" : "Demo data"} · ${new Date(asOf).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}` : "";
  renderTreeDots();
  if (selected) renderInfo(selected);
}

async function refresh() {
  try {
    const r = await state.source.tagValues(site.code);
    values = r.values; asOf = r.asOf; live = r.live;
    applyValues();
  } catch (e) { $("asof").textContent = `Could not read PI values: ${e.message}`; }
}

// ------------------------------------------------------------------ camera
let fly = null;
function fitBox(b, fill = 0.82) {
  // extent of the box as seen by the camera -> zoom; ignore what the panels cover
  const pts = [], m = camera.matrixWorldInverse;
  for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) pts.push(new THREE.Vector3(x, y, z).applyMatrix4(m));
  const w = Math.max(...pts.map(p => p.x)) - Math.min(...pts.map(p => p.x)), h = Math.max(...pts.map(p => p.y)) - Math.min(...pts.map(p => p.y));
  const vw = camera.right - camera.left, vh = camera.top - camera.bottom;
  const { left, right, top, bottom } = freeArea();
  const fw = (right - left) / window.innerWidth, fh = (bottom - top) / window.innerHeight;
  return Math.max(controls.minZoom, Math.min(controls.maxZoom, Math.min(vw * fw / w, vh * fh / h) * fill));
}
function freeArea() {
  const hdr = document.querySelector("header.top").getBoundingClientRect(), ftr = document.querySelector("footer.bottom").getBoundingClientRect();
  let left = 0, right = window.innerWidth;
  const tree = $("tree"), info = $("info");
  if (window.innerWidth > 900) {
    if (getComputedStyle(tree).display !== "none") left = tree.getBoundingClientRect().right;   // fixed: no offsetParent
    if (!info.hidden) right = info.getBoundingClientRect().left;
  }
  let bottom = ftr.top;
  if (window.innerWidth <= 900 && !info.hidden) bottom = Math.min(bottom, info.getBoundingClientRect().top);
  return { left, right, top: hdr.bottom, bottom };
}
function flyTo(b, { instant = false, fill, dir } = {}) {
  if (dir) { camera.position.copy(controls.target).addScaledVector(dir, 600); camera.lookAt(controls.target); camera.updateMatrixWorld(); }
  const center = b.getCenter(new THREE.Vector3());
  center.y = Math.min(center.y, 3);
  const zoom = fitBox(b, fill);
  // shift the target so the box sits in the middle of the free area, not under a panel
  const { left, right, top, bottom } = freeArea();
  const dx = ((left + right) / 2 - window.innerWidth / 2) / window.innerWidth * (camera.right - camera.left) / zoom;
  const dy = ((top + bottom) / 2 - window.innerHeight / 2) / window.innerHeight * (camera.top - camera.bottom) / zoom;
  const rightV = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0), upV = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  const target = center.clone().addScaledVector(rightV, -dx).addScaledVector(upV, dy);
  const offset = camera.position.clone().sub(controls.target);
  const from = fly ? fly.offNow : null;
  if (instant || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    controls.target.copy(target); camera.position.copy(target).add(offset); camera.zoom = zoom; camera.updateProjectionMatrix(); return;
  }
  fly = { t0: performance.now(), from: controls.target.clone(), to: target, z0: camera.zoom, z1: zoom, offset, off0: dir ? turnFrom : offset, offNow: offset.clone() };
}
function stepFly(now) {
  if (!fly) return;
  const p = Math.min(1, (now - fly.t0) / 650), e = p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  controls.target.lerpVectors(fly.from, fly.to, e);
  fly.offNow.copy(fly.off0).lerp(fly.offset, e).setLength(600);
  camera.position.copy(controls.target).add(fly.offNow);
  camera.zoom = Math.exp(Math.log(fly.z0) + (Math.log(fly.z1) - Math.log(fly.z0)) * e);
  camera.updateProjectionMatrix();
  if (p >= 1) fly = null;
}
let turnFrom = null;
function homeView(instant) {
  if (instant) {
    controls.target.set(0, 0, 0); camera.position.copy(viewDir()).multiplyScalar(600); camera.zoom = 1;
    camera.lookAt(controls.target); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    flyTo(site.bbox, { instant: true, fill: 0.88 });
    return;
  }
  turnFrom = camera.position.clone().sub(controls.target);       // animate back to the standard angle too
  flyTo(site.bbox, { fill: 0.88, dir: viewDir() });
}
function itemBox(it) {
  const obj = it.part ? it.part.g : null;
  if (obj) return new THREE.Box3().setFromObject(obj).expandByScalar(4);
  const b = new THREE.Box3();
  const add = n => { if (n.part) b.union(new THREE.Box3().setFromObject(n.part.g)); else if (n.mesh) b.union(new THREE.Box3().setFromObject(n.mesh)); n.children.forEach(add); };
  add(it);
  return b.isEmpty() ? site.bbox : b.expandByScalar(2);
}

// ------------------------------------------------------------------ selection + panels
let selected = null, hovered = null;
const selRing = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: COL.sel }));
const hovRing = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: COL.hover }));
scene.add(selRing, hovRing);
function ring(line, it) {
  if (!it || it.depth === 0) { line.visible = false; return; }
  const b = itemBox(it), y = it.depth >= 3 ? 0.85 : it.depth === 2 ? 0.84 : 0.55, m = it.depth >= 3 ? 0.5 : 0.2;
  if (it.depth < 3) { b.min.set(it.wx - it.w / 2, 0, it.wz - it.d / 2); b.max.set(it.wx + it.w / 2, 0, it.wz + it.d / 2); }
  const p = [[b.min.x + m, b.min.z + m], [b.max.x - m, b.min.z + m], [b.max.x - m, b.max.z - m], [b.min.x + m, b.max.z - m]];
  line.geometry.setFromPoints(p.map(([x, z]) => new THREE.Vector3(x, y, z)));
  line.visible = true;
}

function select(it, { fly: doFly = true } = {}) {
  selected = it && it.depth > 0 ? it : null;
  ring(selRing, selected);
  for (const x of site.items) x.labelDiv && x.labelDiv.classList.toggle("on", x === selected && x.depth >= 3);
  renderCrumbs(); renderTree(); updatePV();
  const info = $("info");
  if (selected) { renderInfo(selected); info.hidden = false; } else info.hidden = true;
  if (window.innerWidth <= 900 && selected) $("tree").classList.remove("open");
  try { history.replaceState(null, "", `#${site.code}${selected ? "/" + selected.node.id : ""}`); } catch (_) { /* sandboxed */ }
  if (doFly) flyTo(selected ? itemBox(selected) : site.bbox, { fill: selected ? (selected.depth >= 3 ? 0.55 : 0.85) : 0.95 });
  updateLabels(true);
}

const fmtV = v => typeof v === "number" ? fmt(v, Math.abs(v) < 10 && v !== 0 ? 1 : 0) : v ?? "—";
function renderInfo(it) {
  const n = it.node, st = statusOf(it), attrs = P.templates[n.template] || [];
  const kind = ["Site", "Area", "Unit", "Equipment"][Math.min(3, it.depth)];
  $("infoKind").textContent = kind === n.template ? kind : `${kind} · ${n.template}`;
  const rows = attrs.filter(a => !/Status$|Scenario$/.test(a[0])).map(([name, suffix, uom]) => {
    const v = values[`${n.tag}.${suffix}`];
    return el("tr", {}, el("td", {}, name), el("td", {}, fmtV(typeof v === "number" ? v : v ?? null), uom ? el("small", {}, ` ${uom}`) : null));
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
    el("div", { class: "sec" }, el("h3", {}, "AF path"), el("div", { class: "meta" }, `\\\\${CFG.piwebapi?.afServer}\\${M.database}\\${n.path}`)),
  ].filter(Boolean));
}

function renderCrumbs() {
  const c = $("crumbs"); c.replaceChildren();
  const chain = []; for (let n = selected || site.root; n; n = n.parent) chain.unshift(n);
  c.append(el("span", {}, M.company.replace(" S.A.", "")), el("span", {}, "›"));
  chain.forEach((n, i) => { if (i) c.append(el("span", {}, "›")); c.append(el("button", { type: "button", onclick: () => select(n.depth ? n : null) }, n.node.name)); });
  $("h1").textContent = `${SITES[site.code].name} plant`;
}

function updatePV() {
  const pv = CFG.piVision || {}, a = $("pv");
  const path = (selected || site.root).node.path;
  const asset = `\\\\${CFG.piwebapi?.afServer}\\${M.database}\\${path}`;
  const tpl = pv.elementDisplay || pv.siteDisplay;
  const url = tpl ? tpl.replace("{asset}", encodeURIComponent(asset)) : pv.home;
  a.hidden = !url; if (url) a.href = url;
}

// AF tree: areas open, units closed unless they hold the selection
function renderTree() {
  const open = new Set(); for (let n = selected; n; n = n.parent) open.add(n);
  const li = it => {
    const kids = it.children, isOpen = it.depth < 1 || open.has(it) || (it.depth === 1 && !selected);
    const node = el("li", { class: kids.length && !isOpen ? "closed" : null });
    const tw = el("button", { type: "button", class: "tw", disabled: !kids.length, "aria-label": kids.length ? `Expand ${it.node.name}` : null, "aria-expanded": kids.length ? String(isOpen) : null,
      onclick: () => { node.classList.toggle("closed"); tw.textContent = node.classList.contains("closed") ? "▶" : "▼"; tw.setAttribute("aria-expanded", String(!node.classList.contains("closed"))); } }, kids.length ? (isOpen ? "▼" : "▶") : "");
    const nm = el("button", { type: "button", class: `nm${it === selected ? " on" : ""}`, onclick: () => select(it.depth ? it : null), "aria-current": it === selected ? "true" : null },
      el("i", { "data-dot": it.node.id }), el("span", {}, it.node.name));
    node.append(el("div", {}, tw, nm));
    if (kids.length) node.append(el("ul", {}, kids.map(li)));
    return node;
  };
  $("treeBody").replaceChildren(el("ul", {}, li(site.root)));
  renderTreeDots();
  $("treeBody").querySelector(".nm.on")?.scrollIntoView({ block: "nearest" });
}
function renderTreeDots() {
  for (const dot of $("treeBody").querySelectorAll("i[data-dot]")) {
    const it = site.byId[dot.dataset.dot], a = statusAttr(it);
    dot.style.background = a && values[`${it.node.tag}.${a[1]}`] != null ? LEVEL_CSS[STATUS_LEVEL[values[`${it.node.tag}.${a[1]}`]] || "planned"] : "transparent";
  }
}

// labels: areas always, units and equipment once zoomed in, the hovered / selected one always
let lastZoom = 0;
function updateLabels(force) {
  if (!site || (!force && Math.abs(camera.zoom - lastZoom) < 0.01)) return;
  lastZoom = camera.zoom;
  const z = camera.zoom * Math.min(1, window.innerWidth / 1100);
  for (const it of site.items) {
    if (!it.labelDiv) continue;
    const show = it === selected || it === hovered || (it.depth === 1 && z < 3.2) || (it.depth === 2 && z > 1.4) || (it.depth >= 3 && z > 2.6);
    it.labelDiv.classList.toggle("dim", !show);
  }
}

// ------------------------------------------------------------------ picking
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
function pick(e) {
  const r = canvas.getBoundingClientRect();
  ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  for (const h of ray.intersectObject(site.group, true)) {
    if (h.object.material === outlineMat || h.object.isLineSegments || h.object.isLine) continue;
    if (h.object.userData.pipe) return { pipe: h.object.userData.pipe };
    let o = h.object; while (o && !o.userData.item) o = o.parent;
    if (o) return { item: o.userData.item };
  }
  return null;
}
const tip = $("tip");
function onMove(e) {
  if (!site || e.pointerType !== "mouse" || e.buttons) { tip.hidden = true; return; }
  const h = pick(e), it = h?.item || null;
  if (it !== hovered) { hovered = it; ring(hovRing, it !== selected ? it : null); updateLabels(true); }
  canvas.style.cursor = h ? "pointer" : "";
  if (h?.pipe) {
    const p = h.pipe;
    tip.replaceChildren(el("b", {}, PRODUCTS[p.product].label), `${p.from.node.name} → ${p.to.node.name}`, el("br"),
      el("span", {}, p.flow == null ? "—" : `${fmt(p.flow)} ${p.product === "steam" ? "lb/h" : p.product === "water" ? "gpm" : p.product === "gas" ? "Mscf/d" : "bbl/d"}`));
    tip.hidden = false;
    tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 14)}px`; tip.style.top = `${e.clientY + 14}px`;
  } else tip.hidden = true;
}
let down = null;
canvas.addEventListener("pointerdown", e => { down = [e.clientX, e.clientY]; fly = null; });
canvas.addEventListener("pointerup", e => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return;
  const h = pick(e);
  if (h?.item) select(h.item.depth === 0 ? null : h.item);
  else if (h?.pipe) select(h.pipe.from);
  else if (selected) select(null, { fly: false });
});
canvas.addEventListener("pointermove", onMove);
canvas.addEventListener("pointerleave", () => { tip.hidden = true; hovered = null; ring(hovRing, null); });

// ------------------------------------------------------------------ page
function legend() {
  $("legend").replaceChildren(...Object.values(PRODUCTS).map(p => el("span", {}, el("i", { style: `background:#${new THREE.Color(p.color).getHexString()}` }), p.label)));
}

function openSite(code, elementId) {
  disposeSite();
  site = buildSite(code);
  $("site").value = code;
  $("back").href = `topo.html#${code}`;
  selected = null; values = state.source.name === "demo" ? { ...(state.data.sites[code].tags || {}) } : {};
  homeView(true);
  applyValues();
  const it = elementId && site.byId[elementId];
  if (it) select(it, { fly: true }); else select(null, { fly: false });
  refresh();
}

let clock = performance.now();
function loop(now) {
  const dt = Math.min(0.1, (now - clock) / 1000); clock = now;
  stepFly(now);
  controls.update();
  if (site) {
    for (const p of site.pipes) if (p.speed) p.tex.offset.x -= dt * p.speed;
    for (const t of site.ticks) t(dt);
    updateLabels();
  }
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  requestAnimationFrame(loop);
}

async function main() {
  try { await U.load(); } catch (e) { $("err").hidden = false; $("err").textContent = `Could not load data: ${e.message}`; return; }
  $("site").replaceChildren(...M.sites.map(s => el("option", { value: s.code }, `${s.name}, ${s.country}`)));
  $("site").addEventListener("change", e => openSite(e.target.value));
  $("reset").addEventListener("click", () => { select(null, { fly: false }); homeView(false); });
  $("infoClose").addEventListener("click", () => select(null, { fly: false }));
  $("treeBtn").addEventListener("click", () => $("tree").classList.toggle("open"));
  $("treeClose").addEventListener("click", () => $("tree").classList.remove("open"));
  document.addEventListener("keydown", e => { if (e.key === "Escape") { if ($("tree").classList.contains("open")) $("tree").classList.remove("open"); else if (selected) select(selected.parent?.depth ? selected.parent : null); } });
  window.addEventListener("resize", () => { resize(); updateLabels(true); });
  window.addEventListener("hashchange", () => fromHash(false));
  legend(); resize();
  fromHash(true);
  setInterval(refresh, (CFG.refreshSeconds || 60) * 1000);
  requestAnimationFrame(loop);
}
function fromHash(first) {
  const [code, id] = decodeURIComponent(location.hash.slice(1)).split("/");
  const c = SITES[code] ? code : (site ? site.code : M.sites[0].code);
  if (!site || c !== site.code) openSite(c, id);
  else if (!first) { const it = id && site.byId[id]; if (it !== selected) select(it || null); }
}
main();
