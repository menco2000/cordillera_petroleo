// Data sources for the dashboard. Both return the same shape:
// { asOf, live, sites: { CODE: { oil, water, gas, thru, producing, crudeInv,
//     wells: { ID: { status, scenario, oil, water, gas, wc, dayOil } },
//     units: { KEY: { status, scenario, metric } } } } }
(function () {
  "use strict";
  const M = window.CP_MODEL;

  // ------------------------------------------------------------------ demo
  function demoSource() {
    const D = window.CP_DEMO;
    return {
      name: "demo",
      async snapshot() { return { asOf: D.asOf, live: false, sites: structuredClone(D.sites) }; },
      // every PI attribute of one site, keyed by PI tag (used by the 3D plant view)
      async tagValues(code) { return { asOf: D.asOf, live: false, values: { ...D.sites[code].tags } }; },
    };
  }

  // ------------------------------------------------------------- PI Web API
  function piSource(cfg) {
    const base = cfg.url.replace(/\/+$/, "");
    const root = `\\\\${cfg.afServer}\\${M.database}\\`;
    const timeout = (cfg.timeoutSeconds || 15) * 1000;
    const ids = new Map();       // AF path -> WebId
    let dbWebId = null;

    async function get(endpoint, params) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params || {})) {
        (Array.isArray(v) ? v : [v]).forEach(x => qs.append(k, x));
      }
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      try {
        const r = await fetch(`${base}/${endpoint}?${qs}`, {
          credentials: "include", headers: { Accept: "application/json" }, signal: ctl.signal,
        });
        if (!r.ok) throw new Error(`${endpoint}: HTTP ${r.status}`);
        return await r.json();
      } finally { clearTimeout(timer); }
    }

    const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
    const attrPath = (elementPath, attr) => `${root}${elementPath}|${attr}`;

    async function resolve(paths) {
      const todo = paths.filter(p => !ids.has(p));
      await Promise.all(chunks(todo, 20).map(async part => {
        const res = await get("attributes/multiple", {
          path: part, selectedFields: "Items.Identifier;Items.Object.WebId",
        });
        (res.Items || []).forEach((it, i) => { if (it.Object) ids.set(part[i], it.Object.WebId); });
      }));
      return paths.map(p => ids.get(p));
    }

    // PI value -> number | string | null (enumerations come back as {Name, Value})
    function val(v) {
      if (v == null) return null;
      if (typeof v === "object") {
        if (v.IsSystem) return null;              // e.g. "Pt Created", "No Data"
        return v.Name !== undefined ? v.Name : null;
      }
      return v;
    }

    async function currentValues(paths) {
      const webIds = await resolve(paths);
      const byId = new Map();
      const valid = webIds.filter(Boolean);
      await Promise.all(chunks(valid, 40).map(async part => {
        const res = await get("streamsets/value", { webId: part, selectedFields: "Items.WebId;Items.Value.Value" });
        (res.Items || []).forEach(it => byId.set(it.WebId, val(it.Value && it.Value.Value)));
      }));
      const out = {};
      paths.forEach((p, i) => { out[p] = webIds[i] ? byId.get(webIds[i]) ?? null : null; });
      return out;
    }

    // ---- layout of the AF paths this dashboard reads -----------------------
    const WELL_ATTRS = { status: "Well Status", scenario: "Sim Scenario", oil: "Oil Rate", water: "Water Rate",
                         gas: "Gas Rate", dayOil: "Oil Volume Today" };
    const plan = [];
    for (const s of M.sites) {
      plan.push([s.code, "thru", attrPath(s.path, "Refinery Throughput")]);
      plan.push([s.code, "producing", attrPath(s.wellfieldPath, "Producing Wells")]);
      plan.push([s.code, "crudeInv", attrPath(s.crudeFarmPath, "Total Inventory")]);
      for (const u of s.units) {
        plan.push([s.code, `u.${u.key}.status`, attrPath(u.path, u.statusAttr)]);
        plan.push([s.code, `u.${u.key}.scenario`, attrPath(u.path, "Sim Scenario")]);
        plan.push([s.code, `u.${u.key}.metric`, attrPath(u.metricPath, u.metricAttr)]);
      }
      for (const w of s.wells) {
        for (const [k, a] of Object.entries(WELL_ATTRS)) plan.push([s.code, `w.${w.id}.${k}`, attrPath(w.path, a)]);
      }
    }

    // all PI Point attributes under one site, from data/plant.js: [tag, AF attribute path]
    function sitePlan(code) {
      const P = window.CP_PLANT, out = [];
      const walk = n => {
        for (const [attr, suffix] of P.templates[n.template] || []) out.push([`${n.tag}.${suffix}`, attrPath(n.path, attr)]);
        n.children.forEach(walk);
      };
      walk(P.sites[code]);
      return out;
    }

    return {
      name: "piwebapi",
      async tagValues(code) {
        const plan = sitePlan(code), vals = await currentValues(plan.map(p => p[1]));
        return { asOf: new Date().toISOString(), live: true, values: Object.fromEntries(plan.map(([tag, path]) => [tag, vals[path]])) };
      },
      async snapshot() {
        if (!dbWebId) {   // one cheap request first, so an unreachable server fails fast
          dbWebId = (await get("assetdatabases", { path: `\\\\${cfg.afServer}\\${M.database}`, selectedFields: "WebId" })).WebId;
        }
        const vals = await currentValues(plan.map(p => p[2]));
        const sites = {};
        for (const s of M.sites) {
          sites[s.code] = { wells: {}, units: {} };
        }
        for (const [code, key, path] of plan) {
          const v = vals[path];
          const site = sites[code];
          const parts = key.split(".");
          if (parts[0] === "u") (site.units[parts[1]] ||= {})[parts[2]] = v;
          else if (parts[0] === "w") (site.wells[parts[1]] ||= {})[parts[2]] = v;
          else site[key] = v;
        }
        for (const s of M.sites) {
          const site = sites[s.code];
          let oil = 0, water = 0, gas = 0, producing = 0;
          for (const w of Object.values(site.wells)) {
            oil += +w.oil || 0; water += +w.water || 0; gas += +w.gas || 0;
            producing += w.status === "Producing";
            w.wc = (+w.oil || 0) + (+w.water || 0) > 1 ? 100 * w.water / (w.oil + w.water) : null;
          }
          Object.assign(site, { oil, water, gas });
          if (site.producing == null) site.producing = producing;
        }
        return { asOf: new Date().toISOString(), live: true, sites };
      },
    };
  }

  window.CP_SOURCES = { demoSource, piSource };
})();
