const { spawn } = require('node:child_process');
const path = require('node:path');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const entry = process.argv.includes('--workspace') ? '../tests/workspace-ui.cjs' : '../tests/serial-ui.cjs';
const child = spawn(require('electron'), [path.resolve(__dirname, entry)], { env, windowsHide: true, stdio: 'inherit' });
const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 30000);
child.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
child.on('exit', code => { clearTimeout(timer); process.exitCode = code === 0 ? 0 : 1; });
