const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const portable = process.argv.includes('--portable');
const version = require('../package.json').version;
const exe = portable ? path.join(root, 'release', `EBED-Studio-${version}-Windows-x64.exe`) : path.join(root, "release", "win-unpacked", "EBED Studio.exe");
const report = path.join(root, "artifacts", portable ? 'portable-smoke.json' : "desktop-smoke.json");
const startedAt = Date.now();
fs.mkdirSync(path.dirname(report), { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(exe, [`--ebed-smoke-test=${report}`], {
  cwd: root,
  env,
  windowsHide: true,
  stdio: "inherit",
});
const timer = setTimeout(() => {
  child.kill();
  console.error("Desktop smoke test timed out");
  process.exitCode = 1;
}, 60000);
child.on("error", (error) => {
  clearTimeout(timer);
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  clearTimeout(timer);
  if (code !== 0 || !fs.existsSync(report) || fs.statSync(report).mtimeMs < startedAt) {
    console.error("Desktop smoke test failed", code);
    process.exitCode = 1;
    return;
  }
  const data = JSON.parse(fs.readFileSync(report, "utf8"));
  console.log(JSON.stringify(data, null, 2));
  if (!data.ok) process.exitCode = 1;
});
