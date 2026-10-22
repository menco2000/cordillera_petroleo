// Data sources for the dashboard. Both return the same shape:
// { asOf, live, sites: { CODE: { oil, water, gas, thru, producing, crudeInv,
//     wells: { ID: { status, scenario, oil, water, gas, wc, dayOil, uptime7d, spark[] } },
//     units: { KEY: { status, scenario, metric } }, events: [ { well, start, end, oil, reason } ],
//     trend: { days[], oil[], thru[] } } } }
(function () {
  "use strict";
  const M = window.CP_MODEL;

  // ------------------------------------------------------------------ demo
  function demoSource() {
    const D = window.CP_DEMO;
    return {
      name: "demo",
      async snapshot() { return { asOf: D.asOf, live: false, sites: structuredClone(D.sites) }; },
      async trend() { return null; },        // already inside snapshot
      async siteDetail() { return null; },   // already inside snapshot
      async events() { return null; },
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

    async function dailyAverages(paths, days) {
      const webIds = await resolve(paths);
      const out = {};
      const end = new Date(); end.setHours(0, 0, 0, 0);
      const start = new Date(end.getTime() - days * 86400000);
      const valid = webIds.filter(Boolean);
      const byId = new Map();
      await Promise.all(chunks(valid, 20).map(async part => {
        const res = await get("streamsets/summary", {
          webId: part, startTime: start.toISOString(), endTime: end.toISOString(),
          summaryType: "Average", summaryDuration: "1d", calculationBasis: "TimeWeighted",
          selectedFields: "Items.WebId;Items.Items.Value.Timestamp;Items.Items.Value.Value",
        });
        (res.Items || []).forEach(it => byId.set(it.WebId, (it.Items || []).map(x => ({
          t: x.Value.Timestamp, v: typeof x.Value.Value === "number" ? x.Value.Value : null,
        }))));
      }));
      paths.forEach((p, i) => { out[p] = byId.get(webIds[i]) || []; });
      return out;
    }

    async function uptime(paths) {
      const webIds = await resolve(paths);
      const out = {};
      await Promise.all(chunks(webIds.filter(Boolean), 20).map(async part => {
        const res = await get("streamsets/interpolated", {
          webId: part, startTime: "*-7d", endTime: "*", interval: "15m",
          selectedFields: "Items.WebId;Items.Items.Value",
        });
        (res.Items || []).forEach(it => {
          const v = (it.Items || []).map(x => val(x.Value));
          out[it.WebId] = v.length ? 100 * v.filter(x => x === "Producing").length / v.length : null;
        });
      }));
      return paths.map((p, i) => out[webIds[i]] ?? null);
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

    return {
      name: "piwebapi",
      async snapshot() {
        if (!dbWebId) {   // one cheap request first, so an unreachable server fails fast
          dbWebId = (await get("assetdatabases", { path: `\\\\${cfg.afServer}\\${M.database}`, selectedFields: "WebId" })).WebId;
        }
        const vals = await currentValues(plan.map(p => p[2]));
        const sites = {};
        for (const s of M.sites) {
          sites[s.code] = { wells: {}, units: {}, events: null, trend: null };
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
      async trend() {
        const paths = M.sites.flatMap(s => [attrPath(s.path, "Field Oil Rate"), attrPath(s.path, "Refinery Throughput")]);
        const res = await dailyAverages(paths, 30);
        const out = {};
        for (const s of M.sites) {
          const oil = res[attrPath(s.path, "Field Oil Rate")], thru = res[attrPath(s.path, "Refinery Throughput")];
          out[s.code] = { days: oil.map(x => x.t.slice(0, 10)), oil: oil.map(x => x.v), thru: thru.map(x => x.v) };
        }
        return out;
      },
      async siteDetail(code) {
        const s = M.sites.find(x => x.code === code);
        const oilPaths = s.wells.map(w => attrPath(w.path, "Oil Rate"));
        const statusPaths = s.wells.map(w => attrPath(w.path, "Well Status"));
        const [spark, up] = await Promise.all([dailyAverages(oilPaths, 7), uptime(statusPaths)]);
        const out = {};
        s.wells.forEach((w, i) => { out[w.id] = { spark: spark[oilPaths[i]].map(x => x.v), uptime7d: up[i] }; });
        return out;
      },
      async events() {
        if (!dbWebId) dbWebId = (await get("assetdatabases", { path: `\\\\${cfg.afServer}\\${M.database}`, selectedFields: "WebId" })).WebId;
        const res = await get(`assetdatabases/${dbWebId}/eventframes`, {
          templateName: "Extraction Run", startTime: "*-7d", endTime: "*", searchMode: "Overlapped",
          maxCount: 1000, selectedFields: "Items.WebId;Items.Name;Items.StartTime;Items.EndTime",
        });
        const done = (res.Items || []).filter(e => !e.EndTime.startsWith("9999"))
          .sort((a, b) => b.EndTime.localeCompare(a.EndTime));
        const byWell = new Map(M.sites.flatMap(s => s.wells.map(w => [w.name, s.code])));
        const out = Object.fromEntries(M.sites.map(s => [s.code, []]));
        const details = done.slice(0, 120);
        await Promise.all(details.map(async e => {
          const well = e.Name.split(" ")[0];
          const code = byWell.get(well);
          if (!code) return;
          const ev = { well, start: e.StartTime, end: e.EndTime, oil: null, reason: null };
          try {
            const a = await get(`streamsets/${e.WebId}/value`, { selectedFields: "Items.Name;Items.Value.Value" });
            for (const it of a.Items || []) {
              if (it.Name === "Total Oil Produced") ev.oil = val(it.Value.Value);
              if (it.Name === "Stop Reason") ev.reason = val(it.Value.Value);
            }
          } catch (_) { /* keep the event without details */ }
          out[code].push(ev);
        }));
        for (const k of Object.keys(out)) out[k].sort((a, b) => b.end.localeCompare(a.end));
        return out;
      },
    };
  }

  window.CP_SOURCES = { demoSource, piSource };
})();
