const { readImports } = require("../src/main/util/pe.js");
const targets = [
  "C:\\Windows\\System32\\notepad.exe",
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  require("node:path").join(__dirname, "..", "node_modules", "electron", "dist", "electron.exe"),
  "C:\\Program Files\\Git\\cmd\\git.exe",
];
for (const t of targets) {
  const r = readImports(t);
  if (!r.ok) { console.log(t, "-> ERROR:", r.error); continue; }
  console.log(`${t}\n  machine=${r.machine} dotnet=${r.isDotNet} imports(${r.imports.length})=${r.imports.slice(0,10).join(", ")}`);
}
