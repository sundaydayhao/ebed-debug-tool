const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { SerialManager } = require("../electron/serial-manager.cjs");
const { DeviceHub } = require("../electron/device-hub.cjs");
class RawPort extends EventEmitter {
  static async list() {
    return [{ path: "COM_TEST", manufacturer: "Generic USB UART" }];
  }
  constructor(config) {
    super();
    this.config = config;
    this.path = config.path;
    this.isOpen = false;
    this.sent = [];
  }
  open(cb) {
    this.isOpen = true;
    cb();
  }
  close(cb) {
    this.isOpen = false;
    cb?.();
    this.emit("close");
  }
  write(bytes, cb) {
    this.sent.push(Buffer.from(bytes));
    cb();
  }
  drain(cb) {
    if (!this.holdDrain) cb();
  }
}
const request = { hex: "010300000002c40b", timeoutMs: 1000 };
test("ordinary serial opens with selected settings, never probes, receives unsolicited data and sends exact bytes", async () => {
  const events = [],
    m = new SerialManager(RawPort, (e) => events.push(e));
  try {
    const status = await m.connect("COM_TEST", {
      baudRate: 9600,
      parity: "even",
      stopBits: 2,
    });
    assert.equal(status.kind, "serial");
    assert.equal(status.capabilities.protocol, null);
    assert.deepEqual(status.capabilities.features, ["uart", "modbus"]);
    assert.equal(m.port.config.parity, "even");
    assert.equal(m.port.config.baudRate, 9600);
    assert.equal(m.port.config.stopBits, 2);
    assert.deepEqual(m.port.sent, []);
    m.port.emit("data", Buffer.from("BOOT\r\n"));
    const reply = await m.command("uart.send", { hex: "41540d0a" });
    assert.equal(reply.ok, true);
    assert.equal(reply.hex, "");
    assert.equal(m.port.sent[0].toString("hex"), "41540d0a");
    m.flush();
    const stream = events.find((e) => e.type === "serial").entries;
    assert.equal(stream[0].hex, Buffer.from("BOOT\r\n").toString("hex"));
    assert.deepEqual(
      stream.map((e) => e.direction),
      ["rx", "tx"],
    );
    await assert.rejects(m.command("wifi.start"), /专用硬件/);
    await assert.rejects(m.command("spi.transfer"), /专用硬件/);
    await assert.rejects(m.command("uart.send", { hex: "a?" }), /HEX/);
    assert.equal(m.port.sent.length, 1);
  } finally {
    m.dispose();
  }
});
test("Modbus combines split responses and validates CRC and transaction identity", async () => {
  const m = new SerialManager(RawPort, () => {});
  try {
    await m.connect("COM_TEST");
    const pending = m.command("modbus.transfer", request);
    await assert.rejects(m.command("uart.send", { hex: "00" }), /上一条/);
    for (const byte of Buffer.from("010304002a0064da10", "hex"))
      m.port.emit("data", Buffer.from([byte]));
    assert.equal((await pending).hex, "010304002a0064da10");
    const corrupt = m.command("modbus.transfer", request);
    m.port.emit("data", Buffer.from("010304002a0064da11", "hex"));
    await assert.rejects(corrupt, /CRC/);
    const mismatch = m.command("modbus.transfer", request);
    m.port.emit("data", Buffer.from("0203", "hex"));
    await assert.rejects(mismatch, /不匹配/);
    assert.equal(m.snapshot().connected, true);
  } finally {
    m.dispose();
  }
});
test("Modbus exception completes promptly; invalid requests never reach the wire", async () => {
  const m = new SerialManager(RawPort, () => {});
  try {
    await m.connect("COM_TEST");
    await assert.rejects(
      m.command("modbus.transfer", { hex: "010300000002c400" }),
      /有效/,
    );
    assert.equal(m.port.sent.length, 0);
    const pending = m.command("modbus.transfer", request);
    m.port.emit("data", Buffer.from("018302c0f1", "hex"));
    await assert.rejects(pending, /异常码 0x02/);
  } finally {
    m.dispose();
  }
});
test("response timeout preserves partial stream and allows recovery; unplug rejects pending operation", async () => {
  const events = [],
    m = new SerialManager(RawPort, (e) => events.push(e));
  try {
    await m.connect("COM_TEST");
    const pending = m.command("modbus.transfer", {
      ...request,
      timeoutMs: 100,
    });
    m.port.emit("data", Buffer.from("010304", "hex"));
    await assert.rejects(pending, /超时.*3 字节/);
    assert.equal(m.snapshot().connected, true);
    m.flush();
    assert.ok(
      events.some(
        (e) => e.type === "serial" && e.entries.some((r) => r.hex === "010304"),
      ),
    );
    const next = m.command("modbus.transfer", request);
    const port = m.port;
    port.close();
    await assert.rejects(next, /断开/);
    assert.equal(m.snapshot().connected, false);
    port.emit("data", Buffer.from("ignored"));
    await assert.rejects(m.command("uart.send", { hex: "00" }), /连接/);
  } finally {
    m.dispose();
  }
});
test("stalled hardware flow control closes port on transmit timeout", async () => {
  const m = new SerialManager(RawPort, () => {});
  try {
    await m.connect("COM_TEST", { rtscts: true });
    m.port.holdDrain = true;
    await assert.rejects(
      m.command("uart.send", { hex: "41", timeoutMs: 100 }),
      /发送超时/,
    );
    assert.equal(m.snapshot().connected, false);
  } finally {
    m.dispose();
  }
});
test("serial IPC buffering stays bounded and accounts for discarded bytes", async () => {
  const events = [],
    m = new SerialManager(RawPort, (e) => events.push(e));
  try {
    await m.connect("COM_TEST");
    m.port.emit("data", Buffer.alloc(2048 * 514));
    m.flush();
    const batch = events.find((e) => e.type === "serial");
    assert.equal(batch.entries.length, 512);
    assert.equal(batch.dropped, 4096);
  } finally {
    m.dispose();
  }
});
test("device hub reserves port during discovery, excludes toolbox and defaults to no open device", async () => {
  const hub = new DeviceHub(RawPort, () => {});
  try {
    assert.equal(hub.snapshot().connected, false);
    const pending = hub.connect({ kind: "serial", path: "COM_TEST" });
    assert.equal(hub.uses("COM_TEST"), true);
    await assert.rejects(
      hub.connect({ kind: "probe", path: "COM_TEST" }),
      /等待/,
    );
    await pending;
    assert.deepEqual(hub.serial.port.sent, []);
    await hub.disconnect();
    hub.isPortUsed = () => true;
    await assert.rejects(
      hub.connect({ kind: "serial", path: "COM_TEST" }),
      /工具箱/,
    );
    hub.isPortUsed = () => false;
    await assert.rejects(
      hub.connect({ kind: "serial", path: "MISSING" }),
      /移除/,
    );
    await assert.rejects(
      hub.connect({
        kind: "serial",
        path: "COM_TEST",
        serialConfig: { baudRate: NaN },
      }),
      /参数/,
    );
    assert.equal(hub.uses("COM_TEST"), false);
    await hub.connect({ kind: "serial", path: "COM_TEST" });
    assert.equal(hub.snapshot().kind, "serial");
  } finally {
    hub.dispose();
  }
});
