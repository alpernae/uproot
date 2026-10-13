const { listAllApps } = require("../src/main/scan/apps.js");
(async () => {
  const t0 = Date.now();
  const r = await listAllApps();
  console.log("elapsed ms:", Date.now() - t0);
  console.log("counts:", JSON.stringify(r.counts));
  console.log("errors:", JSON.stringify(r.errors));
  console.log("total merged:", r.apps.length);
  const multi = r.apps.filter(a => a.sources.length > 1);
  console.log("multi-source entries:", multi.length);
  console.log("--- sample merged ---");
  for (const a of r.apps.slice(0, 12)) {
    console.log([a.name, a.version, a.sources.join("+"), a.uninstallers.join(","), a.needsAdmin ? "ADMIN" : "user"].join(" | "));
  }
  console.log("--- multi-source examples ---");
  for (const a of multi.slice(0, 12)) console.log([a.name, a.sources.join("+"), a.wingetId, a.scope].join(" | "));
})().catch(e => { console.error("FATAL", e); process.exit(1); });
