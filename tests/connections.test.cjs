const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const dgram = require("node:dgram");
const { EventEmitter, once } = require("node:events");
const mqtt = require("mqtt");
const packet = require("mqtt-packet");
const {
  ConnectionManager,
  payloadBuffer,
} = require("../electron/connection-manager.cjs");
const { DeviceHub } = require("../electron/device-hub.cjs");
async function until(fn) {
  const end = Date.now() + 2000;
  while (!fn()) {
    if (Date.now() > end) throw new Error("condition timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
function manager(options = {}) {
  const events = [];
  const m = new ConnectionManager({
    mqtt,
    emit: (event) =>
      events.push(...(event.type === "batch" ? event.events : [event])),
    ...options,
  });
  return { m, events };
}
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}
test("TCP real loopback: readiness, binary integrity, strict validation, close and reconnect with same id", async () => {
  const sockets = new Set(),
    received = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (bytes) => {
      received.push(bytes);
      socket.write(bytes);
    });
  });
  const port = await listen(server),
    { m, events } = manager();
  try {
    const opened = await m.open({
      id: "tcp-test",
      kind: "tcp",
      config: { host: "127.0.0.1", port },
    });
    assert.equal(opened.phase, "open");
    assert.deepEqual(
      events.filter((e) => e.type === "status").map((e) => e.phase),
      ["connecting", "open"],
    );
    await assert.rejects(
      m.open({
        id: "tcp-test",
        kind: "tcp",
        config: { host: "127.0.0.1", port },
      }),
      /先断开/,
    );
    await assert.rejects(
      m.send({ id: "tcp-test", payload: "01 ZZ", format: "hex" }),
      /HEX/,
    );
    assert.equal(received.length, 0);
    await m.send({
      id: "tcp-test",
      payload: "00 FF E4 B8 AD 0D 0A",
      format: "hex",
    });
    await until(() => m.list()[0]?.rxBytes === 7);
    m.flush();
    assert.equal(Buffer.concat(received).toString("hex"), "00ffe4b8ad0d0a");
    assert.ok(
      events.some(
        (e) => e.direction === "rx" && e.payload === "00ffe4b8ad0d0a",
      ),
    );
    for (const socket of sockets) socket.destroy();
    await until(() => !m.list().length);
    assert.equal(events.at(-1).phase, "closed");
    await m.open({
      id: "tcp-test",
      kind: "tcp",
      config: { host: "127.0.0.1", port },
    });
    await m.close("tcp-test");
    await assert.rejects(
      m.send({ id: "tcp-test", payload: "x", format: "text" }),
      /未就绪/,
    );
  } finally {
    m.dispose();
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => server.close(r));
  }
});
test("UDP real loopback: assigned local port, datagram boundaries, sender metadata and bind conflicts", async () => {
  const echo = dgram.createSocket("udp4");
  echo.on("message", (data, remote) =>
    echo.send(data, remote.port, remote.address),
  );
  echo.bind(0, "127.0.0.1");
  await once(echo, "listening");
  const { m, events } = manager();
  try {
    const opened = await m.open({
      id: "udp-test",
      kind: "udp",
      config: {
        localPort: 0,
        bindHost: "127.0.0.1",
        remoteHost: "127.0.0.1",
        remotePort: echo.address().port,
      },
    });
    assert.match(opened.localAddress, /^127\.0\.0\.1:\d+$/);
    await m.send({ id: "udp-test", payload: "first", format: "text" });
    await m.send({ id: "udp-test", payload: "00 01 FF", format: "hex" });
    await until(() => m.list()[0].rxBytes === 8);
    m.flush();
    assert.deepEqual(
      events.filter((e) => e.direction === "rx").map((e) => e.payload),
      ["6669727374", "0001ff"],
    );
    assert.ok(
      events
        .find((e) => e.direction === "rx")
        .meta.endsWith(String(echo.address().port)),
    );
    await assert.rejects(
      m.open({
        id: "udp-conflict",
        kind: "udp",
        config: {
          localPort: +opened.localAddress.split(":")[1],
          bindHost: "127.0.0.1",
          remoteHost: "127.0.0.1",
          remotePort: echo.address().port,
        },
      }),
      /EADDRINUSE|address already/i,
    );
    assert.equal(m.list().length, 1);
  } finally {
    m.dispose();
    echo.close();
  }
});
test("MQTT real socket: subscribe acknowledgement, QoS1 binary publish and credentials excluded from snapshots", async () => {
  const sockets = new Set(),
    incoming = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const parser = packet.parser();
    socket.on("data", (data) => parser.parse(data));
    parser.on("packet", (p) => {
      incoming.push(p);
      if (p.cmd === "connect")
        socket.write(
          packet.generate({
            cmd: "connack",
            returnCode: 0,
            sessionPresent: false,
          }),
        );
      if (p.cmd === "subscribe")
        socket.write(
          packet.generate({
            cmd: "suback",
            messageId: p.messageId,
            granted: [1],
          }),
        );
      if (p.cmd === "publish") {
        if (p.qos === 1)
          socket.write(
            packet.generate({ cmd: "puback", messageId: p.messageId }),
          );
        socket.write(
          packet.generate({
            cmd: "publish",
            topic: "test/rx",
            qos: 0,
            retain: false,
            payload: p.payload,
          }),
        );
      }
    });
  });
  const port = await listen(server),
    { m, events } = manager();
  try {
    const opened = await m.open({
      id: "mqtt-test",
      kind: "mqtt",
      config: {
        url: `mqtt://127.0.0.1:${port}`,
        username: "engineer",
        password: "not-in-profile",
        subscribeTopic: "test/#",
        publishTopic: "test/tx",
        qos: 1,
      },
    });
    assert.equal(opened.phase, "open");
    assert.equal(incoming.at(-1).cmd, "subscribe");
    assert.equal(opened.config.password, undefined);
    assert.ok(!JSON.stringify(events).includes("not-in-profile"));
    await m.send({ id: "mqtt-test", payload: "00 FE FF", format: "hex" });
    await until(() => m.list()[0].rxBytes === 3);
    m.flush();
    assert.equal(
      incoming.find((p) => p.cmd === "publish").payload.toString("hex"),
      "00feff",
    );
    assert.ok(
      events.some(
        (e) =>
          e.direction === "rx" &&
          e.meta === "test/rx" &&
          e.payload === "00feff",
      ),
    );
    await assert.rejects(
      m.send({
        id: "mqtt-test",
        payload: "x",
        format: "text",
        meta: { topic: "test/#" },
      }),
      /通配符/,
    );
  } finally {
    m.dispose();
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => server.close(r));
  }
});
test("unacknowledged MQTT open can time out or be cancelled without leaving live sessions", async () => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const port = await listen(server),
    { m } = manager();
  try {
    await assert.rejects(
      m.open({
        id: "timeout",
        kind: "mqtt",
        config: { url: `mqtt://127.0.0.1:${port}`, timeoutMs: 100 },
      }),
      /超时|timeout/i,
    );
    assert.equal(m.list().length, 0);
    const opening = m.open({
      id: "cancel",
      kind: "mqtt",
      config: { url: `mqtt://127.0.0.1:${port}`, timeoutMs: 1000 },
    });
    const rejected = assert.rejects(opening, /关闭/);
    await m.close("cancel");
    await rejected;
    assert.equal(m.list().length, 0);
    await assert.rejects(
      m.open({
        id: "bad",
        kind: "mqtt",
        config: { url: "mqtt://user:secret@localhost:1883" },
      }),
      /独立字段/,
    );
  } finally {
    m.dispose();
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => server.close(r));
  }
});
class TestSerial extends EventEmitter {
  static async list() {
    return [{ path: "TEST_UART" }];
  }
  constructor(config) {
    super();
    this.config = config;
    this.path = config.path;
    this.sent = [];
  }
  open(cb) {
    this.isOpen = true;
    cb();
  }
  close(cb) {
    setTimeout(() => {
      this.isOpen = false;
      cb?.();
      this.emit("close");
    }, 20);
  }
  write(bytes, cb) {
    this.sent.push(bytes);
    cb();
  }
  drain(cb) {
    cb();
  }
}
test("serial ownership covers probe, workspace, toolbox and in-progress close; open never sends bytes", async () => {
  let hub;
  const { m } = manager({
    SerialPort: TestSerial,
    isPortUsed: (path) => hub?.uses(path),
  });
  hub = new DeviceHub(
    TestSerial,
    () => {},
    (path) => m.uses(path),
  );
  try {
    await m.open({
      id: "serial-test",
      kind: "serial",
      config: { path: "TEST_UART", baudRate: 9600, parity: "even" },
    });
    assert.equal(m.items.get("serial-test").client.sent.length, 0);
    await assert.rejects(
      hub.connect({ kind: "serial", path: "TEST_UART" }),
      /工具箱/,
    );
    const closing = m.close("serial-test");
    await assert.rejects(
      m.open({
        id: "during-close",
        kind: "serial",
        config: { path: "TEST_UART" },
      }),
      /占用/,
    );
    await closing;
    assert.equal(m.uses("TEST_UART"), false);
    await hub.connect({ kind: "serial", path: "TEST_UART" });
    await assert.rejects(
      m.open({ id: "blocked", kind: "serial", config: { path: "TEST_UART" } }),
      /占用/,
    );
  } finally {
    m.dispose();
    hub.dispose();
  }
});
test("IPC queues bound memory and report discarded bytes without corrupting wire counters", async () => {
  const { m, events } = manager({ SerialPort: TestSerial });
  try {
    await m.open({ id: "bulk", kind: "serial", config: { path: "TEST_UART" } });
    const item = m.items.get("bulk");
    for (let i = 0; i < 40; i++) item.client.emit("data", Buffer.alloc(65536));
    assert.ok(m.queueBytes <= 1048576);
    m.flush();
    assert.equal(events.filter((e) => e.type === "data").length, 16);
    assert.equal(
      events.find((e) => e.type === "overflow").droppedBytes,
      24 * 65536,
    );
    assert.equal(m.list()[0].rxBytes, 40 * 65536);
  } finally {
    m.dispose();
  }
});
test("payload validation preserves UTF-8/JSON and rejects malformed, odd and oversized HEX", () => {
  assert.equal(payloadBuffer("0x00 0xFF", "hex").toString("hex"), "00ff");
  assert.equal(payloadBuffer("中文\r\n", "text").toString(), "中文\r\n");
  assert.throws(() => payloadBuffer("00GG", "hex"));
  assert.throws(() => payloadBuffer("abc", "hex"));
  assert.throws(() => payloadBuffer("ff".repeat(65537), "hex"));
  assert.throws(() => payloadBuffer("{invalid}", "json"));
});
