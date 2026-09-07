const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  FrameParser,
  encodeFrame,
  crc32,
  KIND,
  MAX_PAYLOAD,
  validateCapabilities,
  validateEvent,
} = require("../electron/probe-protocol.cjs");
const { ProbeManager } = require("../electron/probe-manager.cjs");
const capabilities = {
  protocol: 1,
  model: "Test Probe",
  firmware: "test",
  serial: "TEST",
  features: ["wifi", "logic", "uart"],
  wifiChannels: [1, 6, 11],
  logicChannels: 8,
  sampleRates: [1000000],
  maxSamples: 32768,
  pinout: { UART: "D0 RX, D1 TX" },
};
test("CRC32 matches IEEE golden vector", () =>
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926));
test("parser handles byte splits, coalesced messages and unrelated console noise", () => {
  const out = [],
    parser = new FrameParser((f) => out.push(f));
  const bytes = Buffer.concat([
    Buffer.from("boot log\r\n"),
    encodeFrame(1, 1, { command: "hello" }),
    encodeFrame(2, 1, { ok: true }),
  ]);
  for (const b of bytes) parser.push(Buffer.from([b]));
  assert.deepEqual(
    out.map((f) => f.value),
    [{ command: "hello" }, { ok: true }],
  );
  assert.equal(parser.buffer.length, 0);
});
test("parser resynchronizes after corruption and oversized headers; allocations are bounded", () => {
  const out = [],
    errors = [],
    parser = new FrameParser(
      (f) => out.push(f),
      (e) => errors.push(e),
    );
  const bad = encodeFrame(3, 0, { type: "packet" });
  bad[16] ^= 1;
  const large = encodeFrame(1, 1, {});
  large.writeUInt32LE(MAX_PAYLOAD + 1, 12);
  parser.push(Buffer.concat([bad, large, encodeFrame(2, 9, { ok: true })]));
  assert.equal(out.length, 1);
  assert.equal(out[0].sequence, 9);
  assert.equal(errors.length, 2);
  parser.push(Buffer.alloc(1000000));
  assert.ok(parser.buffer.length <= 3);
});
test("capability and packet validation reject impossible hardware claims and malformed bytes", () => {
  assert.equal(validateCapabilities(capabilities), capabilities);
  assert.throws(() => validateCapabilities({ ...capabilities, protocol: 2 }));
  assert.throws(() =>
    validateCapabilities({ ...capabilities, features: ["classic-bt"] }),
  );
  assert.throws(() => validateCapabilities({ ...capabilities, maxSamples: 0 }));
  assert.throws(() =>
    validateEvent({ type: "packet", protocol: "wifi", data: "??" }),
  );
  assert.throws(() =>
    validateEvent({
      type: "logic",
      timestampUs: 0,
      channels: 2,
      sampleRate: 1000,
      samples: [255],
    }),
  );
});
class FakePort extends EventEmitter {
  static async list() {
    return [
      { path: "TEST0", manufacturer: "EBED Probe" },
      { path: "TEST1", manufacturer: "Espressif" },
    ];
  }
  constructor(options) {
    super();
    this.path = options.path;
    this.isOpen = false;
    this.sent = [];
    this.hold = false;
    this.parser = new FrameParser((f) => this.answer(f));
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
    this.parser.push(bytes);
    cb?.();
  }
  answer(frame) {
    this.sent.push(frame.value);
    if (this.hold) return;
    const value =
      frame.value.command === "hello"
        ? { ok: true, capabilities }
        : { ok: true, hex: "48 69" };
    queueMicrotask(() => {
      const b = encodeFrame(KIND.REPLY, frame.sequence, value);
      this.emit("data", b.subarray(0, 7));
      this.emit("data", b.subarray(7));
    });
  }
}
test("USB transport handshake, ACK correlation, capability gates, conflicts and stop", async () => {
  const events = [],
    m = new ProbeManager(FakePort, (e) => events.push(e));
  try {
    assert.equal((await m.list())[1].recognized, false);
    await m.connect("TEST0");
    assert.equal(m.snapshot().connected, true);
    assert.equal(m.port.sent[0].command, "hello");
    await assert.rejects(m.command("ble.start"), /未提供/);
    await assert.rejects(m.command("wifi.start", { channel: 13 }), /信道/);
    await m.command("wifi.start", { channel: 6 });
    assert.equal(m.snapshot().active, "wifi");
    await assert.rejects(m.command("logic.start"), /停止/);
    const packet = {
      type: "packet",
      protocol: "wifi",
      timestampUs: 1000,
      rssi: -42,
      channel: 6,
      data: "gAAA",
      originalLength: 3,
    };
    m.port.emit("data", encodeFrame(KIND.EVENT, 0, packet));
    m.flush();
    assert.equal(events.find((e) => e.type === "batch").events[0].data, "gAAA");
    await m.command("capture.stop");
    assert.equal(m.active, null);
    await assert.rejects(m.command("uart.transfer", { hex: "1" }), /HEX/);
    assert.equal(
      (
        await m.command("uart.transfer", {
          hex: "41",
          timeoutMs: 1000,
          readLength: 2,
          baudRate: 115200,
        })
      ).hex,
      "48 69",
    );
  } finally {
    m.dispose();
  }
});
test("unplug rejects inflight command, drops capability state and prevents further sends", async () => {
  const m = new ProbeManager(FakePort, () => {});
  try {
    await m.connect("TEST0");
    m.port.hold = true;
    const pending = m.command("wifi.start", { channel: 6 });
    m.port.emit("close");
    await assert.rejects(pending, /断开/);
    assert.equal(m.pending.size, 0);
    assert.equal(m.caps, null);
    await assert.rejects(m.command("wifi.start", { channel: 6 }), /连接/);
  } finally {
    m.dispose();
  }
});
test("command timeout disconnects unknown capture state instead of reporting idle", async () => {
  const m = new ProbeManager(FakePort, () => {});
  try {
    await m.connect("TEST0");
    m.request = () => Promise.reject(new Error("wifi.start 响应超时"));
    await assert.rejects(m.command("wifi.start", { channel: 6 }), /超时/);
    assert.equal(m.snapshot().connected, false);
    assert.equal(m.port, null);
  } finally {
    m.dispose();
  }
});
test("duplicate connections are rejected while discovery is pending", async () => {
  const m = new ProbeManager(FakePort, () => {});
  try {
    const pending = m.connect("TEST0");
    await assert.rejects(m.connect("TEST1"), /正在连接/);
    await pending;
  } finally {
    m.dispose();
  }
});
