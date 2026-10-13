const fs = require("node:fs");
const { parseListTable } = require("../src/main/scan/winget.js");
const txt = fs.readFileSync(require("node:path").join(__dirname, "..", "fixtures", "winget-list2.txt"), "utf8");
const rows = parseListTable(txt);
console.log("ROWS:", rows.length);
for (const r of rows) console.log(JSON.stringify(r));
