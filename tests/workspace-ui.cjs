const { app, BrowserWindow, ipcMain } = require('electron');
const { EventEmitter, once } = require('node:events');
const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { DeviceHub } = require('../electron/device-hub.cjs');
const { ConnectionManager } = require('../electron/connection-manager.cjs');
let win, hub, manager, server;
const sockets = new Set(), writes = [], saved = [];
class TestPort extends EventEmitter {
  static async list() { return [{ path: 'WORKSPACE_UART', manufacturer: 'Test fixture' }]; }
  constructor(config) { super(); this.path = config.path; this.config = config; this.sent = []; }
  open(cb) { this.isOpen = true; cb(); }
  close(cb) { this.isOpen = false; cb?.(); this.emit('close'); }
  write(bytes, cb) { this.sent.push(Buffer.from(bytes)); cb(); setTimeout(() => this.emit('data', Buffer.from('OK\r\n')), 5); }
  drain(cb) { cb(); }
}
function evaluate(fn) {
  return win.webContents.executeJavaScript(`(async () => {
    const wait = async fn => { const end = Date.now()+5000; while (!fn()) { if(Date.now()>end) throw new Error('UI condition timed out: '+fn.toString()); await new Promise(r=>setTimeout(r,20)); } };
    const set = (el, value) => { if(!el) throw new Error('Missing input'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,value); el.dispatchEvent(new Event('change',{bubbles:true})); el.dispatchEvent(new Event('input',{bubbles:true})); };
    const click = (selector, text) => { const el = [...document.querySelectorAll(selector)].find(el=>el.innerText.includes(text)); if(!el) throw new Error('Missing button '+text); el.click(); };
    return await (${fn.toString()})();
  })()`);
}
app.whenReady().then(async () => {
  try {
    server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('data', bytes => { writes.push(Buffer.from(bytes)); socket.write(Buffer.concat([Buffer.from('RX:'), bytes])); }); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    hub = new DeviceHub(TestPort, event => win.webContents.send('probe:event', event), devicePath => manager.uses(devicePath));
    manager = new ConnectionManager({ SerialPort: TestPort, mqtt: require('mqtt'), isPortUsed: devicePath => hub.uses(devicePath), emit: event => win.webContents.send(event.type === 'batch' ? 'native:batch' : 'native:event', event) });
    ipcMain.handle('probe:list', () => hub.list()); ipcMain.handle('probe:status', () => hub.snapshot());
    ipcMain.handle('probe:connect', (_e, r) => hub.connect(r)); ipcMain.handle('probe:disconnect', () => hub.disconnect()); ipcMain.handle('probe:command', (_e, r) => hub.command(r.command, r.config));
    ipcMain.handle('connection:list', () => manager.list()); ipcMain.handle('connection:open', (_e, r) => manager.open(r)); ipcMain.handle('connection:send', (_e, r) => manager.send(r)); ipcMain.handle('connection:close', (_e, id) => manager.close(id));
    ipcMain.handle('file:save', (_e, request) => { saved.push(request); return { ok: true }; });
    win = new BrowserWindow({ width: 1440, height: 1200, show: false, webPreferences: { preload: path.resolve(__dirname, '../electron/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true, partition: `workspace-test-${process.pid}` } });
    await win.loadFile(path.resolve(__dirname, '../dist/index.html'));
    await evaluate(async () => {
      await wait(() => document.querySelector('.s-hero-actions .s-primary')); document.querySelector('.s-hero-actions .s-primary').click();
      await wait(() => document.querySelector('[aria-label="工作区串口"]')?.value === 'WORKSPACE_UART');
      set(document.querySelector('[aria-label="连接名称"]'), '开发板日志'); set(document.querySelector('[aria-label="波特率"]'), '57600');
      await new Promise(r=>setTimeout(r,30)); document.querySelector('.c-connect').click(); await wait(()=>document.querySelector('.c-state.open'));
      set(document.querySelector('[aria-label="工作区发送内容"]'), 'STATUS'); set(document.querySelector('[aria-label="快捷命令名称"]'), '状态查询');
      await new Promise(r=>setTimeout(r,30)); click('.c-send-actions button','保存命令'); await wait(()=>document.querySelector('.c-commands')?.innerText.includes('状态查询'));
      const inputs = document.querySelectorAll('.c-send-options input'); set(inputs[0], '3'); set(inputs[1], '200');
      await new Promise(r=>setTimeout(r,30)); document.querySelector('.c-send').click();
      await wait(()=>document.querySelector('.c-log-row.tx')); click('.c-send-actions button','停止');
      await wait(()=>document.querySelector('.c-send'));
    });
    const serial = [...manager.items.values()].find(item=>item.kind==='serial');
    assert.equal(serial.config.baudRate, 57600);
    await new Promise(r=>setTimeout(r,300));
    assert.equal(serial.client.sent.length, 1); assert.equal(serial.client.sent[0].toString(), 'STATUS\r\n');
    await evaluate(async () => { document.querySelector('[title="新建 TCP 连接"]').click(); await wait(()=>document.querySelector('[aria-label="目标端口"]')); });
    await win.webContents.executeJavaScript(`(() => { const el=document.querySelector('[aria-label="目标端口"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(String(server.address().port))}); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await evaluate(async () => {
      set(document.querySelector('[aria-label="连接名称"]'), '本机回环'); await new Promise(r=>setTimeout(r,30)); document.querySelector('.c-connect').click(); await wait(()=>document.querySelector('.c-state.open'));
      if(document.querySelector('[aria-label="工作区发送内容"]').value !== '') throw new Error('Send drafts leaked across connections');
      set(document.querySelector('[aria-label="工作区发送格式"]'), 'hex'); set(document.querySelector('[aria-label="工作区发送内容"]'), '00 FF 41');
      await new Promise(r=>setTimeout(r,30)); document.querySelector('.c-send').click(); await wait(()=>document.querySelector('.c-log-row.rx code')?.innerText.includes('52 58 3A 00 FF 41'));
      click('.c-log-foot button','JSON');
      click('.s-nav button','工作台'); await wait(()=>document.querySelector('.s-hero'));
    });
    assert.equal(manager.list().length, 2); assert.equal(Buffer.concat(writes).toString('hex'), '00ff41');
    for (const socket of sockets) socket.write(Buffer.from('background'));
    await evaluate(async () => {
      click('.s-nav button','连接工作区'); await wait(()=>document.querySelector('.c-log-row.rx') && document.querySelector('.c-log').innerText.includes('62 61 63 6B 67 72 6F 75 6E 64'));
      set(document.querySelector('[aria-label="搜索收发记录"]'), 'background'); await wait(()=>document.querySelectorAll('.c-log-row').length===1);
      set(document.querySelector('[aria-label="搜索收发记录"]'), '');
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    });
    assert.ok(JSON.parse(saved[0].content).entries.some(e=>e.direction==='rx' && e.payload==='52583a00ff41'));
    await fs.mkdir(path.resolve(__dirname,'../artifacts'),{recursive:true});
    await fs.writeFile(path.resolve(__dirname,'../artifacts/workspace-ui.png'),(await win.webContents.capturePage()).toPNG());
    await evaluate(async () => {
      document.querySelector('[title="新建 MQTT 连接"]').click(); await wait(()=>document.querySelector('input[type="password"]'));
      set(document.querySelector('input[type="password"]'), 'session-only-secret'); await new Promise(r=>setTimeout(r,50));
      click('.c-profile-actions button','导出配置');
    });
    const exported = saved.find(entry=>entry.defaultPath==='ebed-connections.json');
    assert.ok(exported); assert.ok(!exported.content.includes('session-only-secret')); assert.equal(JSON.parse(exported.content).profiles.length,3);
    for(const c of manager.list()) await manager.close(c.id);
    await win.reload(); await new Promise(r=>win.webContents.once('did-finish-load',r));
    await evaluate(async () => {
      await wait(()=>document.querySelector('.s-hero-actions .s-primary')); document.querySelector('.s-hero-actions .s-primary').click(); await wait(()=>document.querySelectorAll('.c-profile-list > button').length===3);
      if(document.querySelector('[aria-label="连接名称"]').value!=='开发板日志') throw new Error('Name not restored');
      if(document.querySelector('[aria-label="波特率"]').value!=='57600') throw new Error('Settings not restored');
      if(!document.querySelector('.c-commands')?.innerText.includes('状态查询')) throw new Error('Command not restored');
      if(document.querySelector('.c-state.open')) throw new Error('Unexpected automatic connection');
      click('.c-profile-list button','MQTT'); await wait(()=>document.querySelector('input[type="password"]')); if(document.querySelector('input[type="password"]').value) throw new Error('Password persisted');
    });
    assert.equal(manager.list().length, 0);
    console.log('PASS: workspace UI, serial/TCP simultaneous sessions, binary loopback, cancellation, background RX, log filtering/export, per-connection drafts, saved settings/commands, credential exclusion and no automatic reopen.');
    manager.dispose(); hub.dispose(); for(const socket of sockets) socket.destroy(); server.close(); app.exit(0);
  } catch(error) { console.error(error); manager?.dispose(); hub?.dispose(); for(const socket of sockets) socket.destroy(); server?.close(); app.exit(1); }
});
