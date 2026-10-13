const { execFile } = require("node:child_process");
execFile("winget", ["list","--accept-source-agreements","--disable-interactivity"], { windowsHide: true, maxBuffer: 32*1024*1024, encoding: "utf8" },
  (err, stdout, stderr) => {
    console.log("ERR:", err ? err.code : "none");
    console.log("STDOUT_LEN:", stdout.length);
    console.log("STDERR_LEN:", stderr.length);
    const lines = stdout.split(/\r?\n/);
    console.log("LINES:", lines.length);
    console.log(lines.slice(0, 8).map(l => "|" + l + "|").join("\n"));
  });
