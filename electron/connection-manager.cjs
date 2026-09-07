const net = require("node:net");
const dgram = require("node:dgram");
const { serialSettings } = require("./serial-manager.cjs");
const number = (value, min, max, label) => {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${label}应为 ${min}–${max} 的整数`);
  return value;
};
const host = (value) => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 253 ||
    /[\s/\x00-\x1f]/.test(value)
  )
    throw new Error("主机地址无效");
  return value;
};
function topic(value, subscribe = false) {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value) > 65535 ||
    value.includes("\0")
  )
    throw new Error("MQTT topic 无效");
  if (!subscribe && /[+#]/.test(value))
    throw new Error("发布 topic 不能包含通配符");
  if (
    subscribe &&
    value
      .split("/")
      .some(
        (part, i, all) =>
          (part.includes("+") && part !== "+") ||
          (part.includes("#") && (part !== "#" || i !== all.length - 1)),
      )
  )
    throw new Error("订阅通配符无效");
  return value;
}
function validateConfig(kind, c = {}) {
  const timeoutMs = number(c.timeoutMs ?? 5000, 100, 30000, "超时");
  if (kind === "serial") {
    if (
      typeof c.path !== "string" ||
      !c.path ||
      c.path.length > 256 ||
      /[\x00-\x1f]/.test(c.path)
    )
      throw new Error("串口路径无效");
    return { path: c.path, ...serialSettings(c), timeoutMs };
  }
  if (kind === "tcp")
    return {
      host: host(c.host),
      port: number(c.port, 1, 65535, "端口"),
      timeoutMs,
    };
  if (kind === "udp")
    return {
      bindHost: host(c.bindHost || "0.0.0.0"),
      localPort: number(c.localPort ?? 0, 0, 65535, "本地端口"),
      remoteHost: host(c.remoteHost),
      remotePort: number(c.remotePort, 1, 65535, "目标端口"),
      timeoutMs,
    };
  if (kind === "mqtt") {
    const url = new URL(c.url);
    if (
      !["mqtt:", "mqtts:", "ws:", "wss:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new Error(
        "Broker URL 应为 mqtt(s):// 或 ws(s)://，用户名与密码请使用独立字段",
      );
    if (
      ["mqtt:", "mqtts:"].includes(url.protocol) &&
      url.pathname &&
      url.pathname !== "/"
    )
      throw new Error("MQTT TCP URL 不支持路径");
    for (const key of ["clientId", "username", "password"])
      if (
        c[key] != null &&
        (typeof c[key] !== "string" ||
          c[key].length > 1024 ||
          c[key].includes("\0"))
      )
        throw new Error(`无效参数：${key}`);
    return {
      url: c.url,
      clientId: c.clientId || "",
      username: c.username || "",
      password: c.password || "",
      subscribeTopic: c.subscribeTopic ? topic(c.subscribeTopic, true) : "",
      publishTopic: topic(c.publishTopic || "debug/tx"),
      qos: number(c.qos ?? 0, 0, 2, "QoS"),
      timeoutMs,
    };
  }
  throw new Error("不支持的连接类型");
}
function payloadBuffer(payload, format) {
  if (typeof payload !== "string" || payload.length > 262144)
    throw new Error("发送内容过长或类型无效");
  let buffer;
  if (format === "hex") {
    const parts = payload.trim().split(/\s+/);
    if (!parts.every((part) => /^(?:0x)?(?:[\da-f]{2})+$/i.test(part)))
      throw new Error("HEX 必须为完整字节，例如 41 54 0D 0A");
    buffer = Buffer.from(
      parts.map((part) => part.replace(/^0x/i, "")).join(""),
      "hex",
    );
  } else if (format === "text" || format === "json") {
    if (format === "json") JSON.parse(payload);
    buffer = Buffer.from(payload, "utf8");
  } else throw new Error("不支持的发送格式");
  if (buffer.length > 65536) throw new Error("每次发送最多 64 KB");
  return buffer;
}
class ConnectionManager {
  constructor({ SerialPort, mqtt, emit, isPortUsed = () => false }) {
    Object.assign(this, { SerialPort, mqtt, emit, isPortUsed });
    this.items = new Map();
    this.closingPorts = new Map();
    this.queue = [];
    this.queueBytes = 0;
    this.overflow = new Map();
    this.timer = setInterval(() => this.flush(), 50);
    this.timer.unref?.();
  }
  uses(path) {
    return (
      this.closingPorts.has(path) ||
      [...this.items.values()].some(
        (item) => item.kind === "serial" && item.config.path === path,
      )
    );
  }
  snapshot(item) {
    const { password, ...config } = item.config;
    return {
      id: item.id,
      kind: item.kind,
      config,
      phase: item.phase,
      message: item.message,
      rxBytes: item.rxBytes,
      txBytes: item.txBytes,
      localAddress: item.localAddress || "",
    };
  }
  list() {
    return [...this.items.values()].map((item) => this.snapshot(item));
  }
  status(item, phase, message) {
    item.phase = phase;
    item.message = message;
    this.emit({
      ...this.snapshot(item),
      type: "status",
      level: phase === "open" ? "ok" : phase === "error" ? "error" : "warn",
      at: new Date().toISOString(),
    });
  }
  record(item, direction, bytes, meta = "") {
    item[direction === "rx" ? "rxBytes" : "txBytes"] += bytes.length;
    // Preserve datagram/MQTT boundaries, bound each displayed message to 64 KiB.
    const shown = bytes.subarray(0, 65536);
    if (this.queue.length >= 512 || this.queueBytes + shown.length > 1048576) {
      const old = this.overflow.get(item.id);
      this.overflow.set(item.id, {
        item,
        bytes: (old?.bytes || 0) + bytes.length,
      });
      return;
    }
    this.queueBytes += shown.length;
    this.queue.push({
      id: item.id,
      kind: item.kind,
      type: "data",
      direction,
      payload: shown.toString("hex"),
      format: "hex",
      meta,
      bytes: bytes.length,
      truncated: bytes.length > shown.length,
      rxBytes: item.rxBytes,
      txBytes: item.txBytes,
      at: new Date().toISOString(),
    });
  }
  flush() {
    if (!this.queue.length && !this.overflow.size) return;
    const events = this.queue;
    for (const { item, bytes } of this.overflow.values())
      events.push({
        id: item.id,
        kind: item.kind,
        type: "overflow",
        droppedBytes: bytes,
        rxBytes: item.rxBytes,
        txBytes: item.txBytes,
        at: new Date().toISOString(),
      });
    this.queue = [];
    this.queueBytes = 0;
    this.overflow.clear();
    this.emit({ type: "batch", events });
  }
  shutdown(item) {
    if (item.kind === "serial") {
      if (!item.closePromise) {
        item.closePromise = new Promise((resolve) => {
          item.resolveClose = resolve;
        });
        this.closingPorts.set(item.config.path, item.closePromise);
      }
      const released = () => {
        if (this.closingPorts.get(item.config.path) === item.closePromise)
          this.closingPorts.delete(item.config.path);
        item.resolveClose();
      };
      if (item.opening) return item.closePromise;
      if (!item.client?.isOpen) released();
      else if (!item.closing) {
        item.closing = true;
        try {
          item.client.close(released);
        } catch {
          released();
        }
      }
      return item.closePromise;
    }
    try {
      if (item.kind === "tcp") item.client?.destroy();
      if (item.kind === "udp") item.client?.close();
      if (item.kind === "mqtt") item.client?.end(true);
    } catch {
      /* Opening failures may leave no handle to close. */
    }
  }
  finish(item, phase, message) {
    if (this.items.get(item.id) !== item) return;
    this.items.delete(item.id);
    clearTimeout(item.openTimer);
    item.rejectOpen?.(new Error(message));
    item.rejectOpen = null;
    for (const cancel of [...item.pending]) cancel(new Error(message));
    this.flush();
    this.status(item, phase, message);
    return this.shutdown(item);
  }
  async close(id) {
    const item = this.items.get(id);
    if (item) await this.finish(item, "closed", "连接已关闭");
    return { ok: true };
  }
  async open({ id, kind, config }) {
    if (typeof id !== "string" || !/^[\w-]{1,80}$/.test(id))
      throw new Error("连接标识无效");
    if (this.items.has(id)) throw new Error("该连接正在使用，请先断开");
    if (this.items.size >= 16) throw new Error("最多同时打开 16 个连接");
    const settings = validateConfig(kind, config);
    if (
      kind === "serial" &&
      (!this.SerialPort ||
        this.uses(settings.path) ||
        this.isPortUsed(settings.path))
    )
      throw new Error(
        this.SerialPort ? "串口已被其他工作区占用，请先断开" : "串口组件不可用",
      );
    if (kind === "mqtt" && !this.mqtt) throw new Error("MQTT 组件不可用");
    const item = {
      id,
      kind,
      config: settings,
      phase: "connecting",
      rxBytes: 0,
      txBytes: 0,
      pending: new Set(),
    };
    this.items.set(id, item);
    this.status(item, "connecting", "正在连接…");
    return new Promise((resolve, reject) => {
      item.rejectOpen = reject;
      const current = () => this.items.get(id) === item;
      const fail = (error) =>
        this.finish(item, "error", error.message || String(error));
      const ready = () => {
        if (!current()) return this.shutdown(item);
        clearTimeout(item.openTimer);
        item.rejectOpen = null;
        this.status(
          item,
          "open",
          kind === "udp" ? `已监听 ${item.localAddress}` : "连接已就绪",
        );
        resolve({ ok: true, ...this.snapshot(item) });
      };
      item.openTimer = setTimeout(
        () => fail(new Error("连接超时，请检查地址、端口与目标状态")),
        settings.timeoutMs,
      );
      try {
        if (kind === "tcp") {
          item.client = new net.Socket();
          item.client.on("error", fail);
          item.client.on("close", () => {
            if (current()) this.finish(item, "closed", "远端已断开");
          });
          item.client.on("data", (data) => {
            if (current()) this.record(item, "rx", data);
          });
          item.client.once("connect", ready);
          item.client.setNoDelay(true);
          item.client.connect(settings.port, settings.host);
        } else if (kind === "udp") {
          item.client = dgram.createSocket("udp4");
          item.client.on("error", fail);
          item.client.on("close", () => {
            if (current()) this.finish(item, "closed", "UDP 监听已关闭");
          });
          item.client.on("message", (data, remote) => {
            if (current())
              this.record(item, "rx", data, `${remote.address}:${remote.port}`);
          });
          item.client.bind(settings.localPort, settings.bindHost, () => {
            if (!current()) return this.shutdown(item);
            const a = item.client.address();
            item.localAddress = `${a.address}:${a.port}`;
            ready();
          });
        } else if (kind === "serial") {
          item.client = new this.SerialPort({
            path: settings.path,
            ...serialSettings(settings),
            autoOpen: false,
          });
          item.client.on("error", fail);
          item.client.on("close", () => {
            if (current()) this.finish(item, "closed", "串口已断开");
          });
          item.client.on("data", (data) => {
            if (current()) this.record(item, "rx", data);
          });
          item.opening = true;
          item.client.open((error) => {
            item.opening = false;
            if (!current()) return this.shutdown(item);
            if (error) fail(error);
            else ready();
          });
        } else {
          item.client = this.mqtt.connect(settings.url, {
            clientId: settings.clientId || `ebed-${id}-${Date.now()}`,
            username: settings.username || undefined,
            password: settings.password || undefined,
            reconnectPeriod: 0,
            connectTimeout: settings.timeoutMs,
            clean: true,
          });
          item.client.on("error", fail);
          item.client.on("close", () => {
            if (current()) this.finish(item, "closed", "Broker 已断开");
          });
          item.client.on("message", (name, data) => {
            if (current()) this.record(item, "rx", data, name);
          });
          item.client.once("connect", () => {
            if (!current()) return this.shutdown(item);
            if (!settings.subscribeTopic) return ready();
            item.client.subscribe(
              settings.subscribeTopic,
              { qos: settings.qos },
              (error, granted) => {
                if (error) fail(error);
                else if (!granted?.length || granted.some((g) => g.qos > 2))
                  fail(new Error("Broker 拒绝了订阅"));
                else ready();
              },
            );
          });
        }
      } catch (error) {
        fail(error);
      }
    });
  }
  async send({ id, payload, format, meta }) {
    const item = this.items.get(id);
    if (!item || item.phase !== "open") throw new Error("连接尚未就绪");
    if (item.pending.size) throw new Error("上次发送尚未完成");
    const bytes = payloadBuffer(payload, format);
    if (!bytes.length && item.kind !== "mqtt")
      throw new Error("发送内容不能为空");
    if (item.kind === "udp" && bytes.length > 65507)
      throw new Error("UDP 数据报最多 65507 字节");
    const name =
      item.kind === "mqtt"
        ? topic(meta?.topic || item.config.publishTopic)
        : "";
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        item.pending.delete(finish);
        if (error) reject(error);
        else {
          this.record(
            item,
            "tx",
            bytes,
            name ||
              (item.kind === "udp"
                ? `${item.config.remoteHost}:${item.config.remotePort}`
                : ""),
          );
          resolve({ ok: true, bytes: bytes.length });
        }
      };
      const timer = setTimeout(() => {
        finish(new Error("发送超时，连接已关闭"));
        this.finish(item, "error", "发送超时，请检查流控、网络与目标状态");
      }, item.config.timeoutMs);
      item.pending.add(finish);
      try {
        if (item.kind === "mqtt")
          item.client.publish(
            name,
            bytes,
            { qos: item.config.qos, retain: false },
            finish,
          );
        else if (item.kind === "udp")
          item.client.send(
            bytes,
            item.config.remotePort,
            item.config.remoteHost,
            finish,
          );
        else
          item.client.write(bytes, (error) => {
            if (done) return;
            if (!error && item.kind === "serial") item.client.drain(finish);
            else finish(error);
          });
      } catch (error) {
        finish(error);
      }
    });
  }
  dispose() {
    clearInterval(this.timer);
    for (const id of [...this.items.keys()]) this.close(id);
    this.flush();
  }
}
module.exports = { ConnectionManager, validateConfig, payloadBuffer };
