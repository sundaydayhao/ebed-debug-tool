// Runs the production React page and actual preload/DeviceHub with an in-memory
// serial endpoint. No physical port is enumerated or opened by this test.
const { app, BrowserWindow, ipcMain } = require('electron');
const { EventEmitter } = require('node:events');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { DeviceHub } = require('../electron/device-hub.cjs');
let win, hub, failOpen = false;
class TestPort extends EventEmitter {
  static async list() { return [{ path: 'TEST_SERIAL', manufacturer: 'UI test fixture' }]; }
  constructor(config) { super(); this.path = config.path; this.config = config; this.sent = []; }
  open(cb) { if (failOpen) return cb(new Error('TEST: port busy')); this.isOpen = true; cb(); }
  close(cb) { this.isOpen = false; cb?.(); this.emit('close'); }
  write(bytes, cb) {
    this.sent.push(Buffer.from(bytes)); cb();
    const reply = bytes[0] === 1 ? Buffer.from('010304002a0064da10', 'hex') : Buffer.from('OK\r\n');
    setTimeout(() => this.emit('data', reply.subarray(0, 2)), 5);
    setTimeout(() => this.emit('data', reply.subarray(2)), 15);
  }
  drain(cb) { cb(); }
}
async function evaluate(fn) { return win.webContents.executeJavaScript(`(${fn.toString()})()`); }
app.whenReady().then(async () => {
  try {
    hub = new DeviceHub(TestPort, event => win.webContents.send('probe:event', event));
    ipcMain.handle('probe:list', () => hub.list());
    ipcMain.handle('probe:status', () => hub.snapshot());
    ipcMain.handle('probe:connect', (_e, request) => hub.connect(request));
    ipcMain.handle('probe:disconnect', () => hub.disconnect());
    ipcMain.handle('probe:command', (_e, { command, config }) => hub.command(command, config));
    ipcMain.handle('connection:list', () => []);
    win = new BrowserWindow({ width: 1440, height: 1100, show: false, webPreferences: {
      preload: path.resolve(__dirname, '../electron/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, partition: `serial-test-${process.pid}`,
    } });
    await win.loadFile(path.resolve(__dirname, '../dist/index.html'));
    const opened = await evaluate(async () => {
      const wait = async predicate => { const end = Date.now() + 5000; while (!predicate()) { if (Date.now() > end) throw new Error('UI wait timed out'); await new Promise(r => setTimeout(r, 20)); } };
      const set = (element, value) => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set.call(element, value); element.dispatchEvent(new Event('change', { bubbles: true })); element.dispatchEvent(new Event('input', { bubbles: true })); };
      await wait(() => document.querySelector('.s-hero-actions .s-primary'));
      [...document.querySelectorAll('.s-nav button')].find(b => b.innerText.includes('总线调试')).click();
      await wait(() => document.querySelector('.s-serial-config-summary button'));
      document.querySelector('.s-serial-config-summary button').click();
      await wait(() => document.querySelector('[aria-label="系统串口"]')?.value === 'TEST_SERIAL');
      if (document.querySelector('[aria-label="连接方式"]').value !== 'serial') throw new Error('Serial must be default');
      set(document.querySelector('[aria-label="串口波特率"]'), '9600');
      set(document.querySelectorAll('.s-serial-connect select')[1], 'even');
      await new Promise(r => setTimeout(r, 20));
      document.querySelector('.s-modal-actions .s-primary').click();
      await wait(() => document.querySelector('.s-debug-run') && !document.querySelector('.s-debug-run').disabled);
      return { dialogClosed: !document.querySelector('[role="dialog"]'), ready: document.body.innerText.includes('9600 · 8E1') };
    });
    assert.deepEqual(opened, { dialogClosed: true, ready: true });
    assert.equal(hub.serial.port.config.baudRate, 9600);
    assert.equal(hub.serial.port.config.parity, 'even');
    assert.equal(hub.serial.port.sent.length, 0);
    hub.serial.port.emit('data', Buffer.from('BOOT ready\r\n'));
    const sent = await evaluate(async () => {
      const wait = async predicate => { const end = Date.now() + 5000; while (!predicate()) { if (Date.now() > end) throw new Error('UART UI wait timed out'); await new Promise(r => setTimeout(r, 20)); } };
      const select = document.querySelector('.s-send-options select');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'text');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(() => document.querySelector('.s-payload-label textarea')?.value === 'AT');
      document.querySelector('.s-debug-run').click();
      await wait(() => document.querySelector('.s-result')?.innerText.includes('已发送 4 字节') && document.querySelectorAll('.s-serial-row.rx').length >= 3);
      return { txVisible: document.querySelector('.s-serial-row.tx code').innerText, rows: document.querySelectorAll('.s-serial-row').length };
    });
    assert.equal(sent.txVisible, '41 54 0D 0A');
    assert.equal(hub.serial.port.sent[0].toString('hex'), '41540d0a');
    await fs.mkdir(path.resolve(__dirname, '../artifacts'), { recursive: true });
    await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await fs.writeFile(path.resolve(__dirname, '../artifacts/serial-ui.png'), (await win.webContents.capturePage()).toPNG());
    const result = await evaluate(async () => {
      const wait = async predicate => { const end = Date.now() + 5000; while (!predicate()) { if (Date.now() > end) throw new Error('Modbus UI wait timed out'); await new Promise(r => setTimeout(r, 20)); } };
      document.querySelectorAll('.s-debug-protocols button')[3].click();
      await wait(() => document.querySelector('.s-debug-run').innerText.includes('Modbus'));
      document.querySelector('.s-debug-run').click();
      await wait(() => document.querySelector('.s-result-rx')?.innerText.includes('010304002a0064da10'));
      const response = document.querySelector('.s-result').innerText;
      document.querySelectorAll('.s-debug-protocols button')[1].click();
      await wait(() => document.querySelector('.s-debug-run').disabled);
      document.querySelector('.s-device-mini button').click();
      await wait(() => document.querySelector('[role="dialog"]'));
      [...document.querySelectorAll('.s-modal-actions button')].find(b => b.innerText.includes('断开')).click();
      await wait(() => document.querySelector('.s-modal-actions .s-primary'));
      return response;
    });
    assert.match(result, /CRC OK/);
    assert.equal(hub.snapshot().connected, false);
    failOpen = true;
    assert.equal(await evaluate(async () => {
      document.querySelector('.s-modal-actions .s-primary').click();
      const end = Date.now() + 5000;
      while (!document.querySelector('.s-connect-error')?.innerText.includes('TEST: port busy')) {
        if (Date.now() > end) throw new Error('Connection failure not shown');
        await new Promise(r => setTimeout(r, 20));
      }
      return Boolean(document.querySelector('[role="dialog"]'));
    }), true);
    console.log('PASS: production React + preload + DeviceHub: serial default/settings/no handshake, unsolicited RX, text + CRLF TX, streamed RX, Modbus CRC, SPI gate, disconnect and failed-open dialog.');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
