const {
  KIND,
  encodeFrame,
  FrameParser,
  validateCapabilities,
  validateEvent,
} = require("./probe-protocol.cjs");
class ProbeManager {
  constructor(SerialPort, emit) {
    this.SerialPort = SerialPort;
    this.emit = emit;
    this.port = null;
    this.caps = null;
    this.pending = new Map();
    this.sequence = 0;
    this.active = null;
    this.busy = false;
    this.connecting = false;
    this.queue = [];
    this.hostDropped = 0;
    this.lastHeartbeat = 0;
    this.pinging = false;
    this.timer = setInterval(() => {
      this.flush();
      if (
        this.caps &&
        !this.busy &&
        !this.pinging &&
        Date.now() - this.lastHeartbeat > 1000
      ) {
        this.pinging = true;
        this.lastHeartbeat = Date.now();
        const pingPort = this.port;
        this.request("heartbeat", {})
          .catch((e) => {
            if (this.port === pingPort) this.fail(e.message);
          })
          .finally(() => {
            this.pinging = false;
          });
      }
    }, 50);
    this.timer.unref?.();
  }
  flush() {
    if (this.queue.length) {
      this.emit({
        type: "batch",
        events: this.queue,
        hostDropped: this.hostDropped,
      });
      this.queue = [];
    }
  }
  async list() {
    if (!this.SerialPort)
      throw new Error("内置 USB 串口组件加载失败，请重新解压完整程序。");
    const ports = await this.SerialPort.list();
    return ports.map((p) => ({
      path: p.path,
      serialNumber: p.serialNumber || "",
      label: p.friendlyName || p.manufacturer || p.path,
      recognized: /EBED Probe/i.test(
        `${p.friendlyName || ""} ${p.manufacturer || ""}`,
      ),
    }));
  }
  snapshot() {
    return {
      connected: !!this.caps,
      kind: 'probe',
      capabilities: this.caps,
      path: this.port?.path || "",
      active: this.active,
    };
  }
  async connect(path) {
    if (this.connecting) throw new Error("设备正在连接");
    if (this.port) throw new Error("请先断开当前设备");
    this.connecting = true;
    try {
      if (!(await this.list()).some((p) => p.path === path))
        throw new Error("设备已拔出，请重新选择");
      const port = new this.SerialPort({
        path,
        baudRate: 115200,
        autoOpen: false,
        rtscts: false,
      });
      this.port = port;
      this.hostDropped = 0;
      const parser = new FrameParser(
        (frame) => this.onFrame(frame),
        (message) => this.emit({ type: "warning", message }),
      );
      port.on("data", (data) => {
        if (this.port === port) parser.push(data);
      });
      port.on("error", (error) => {
        if (this.port === port) this.fail(error.message);
      });
      port.on("close", () => {
        if (this.port === port) this.fail("USB 设备已断开");
      });
      try {
        await new Promise((resolve, reject) =>
          port.open((e) => (e ? reject(e) : resolve())),
        );
        if (this.port !== port) throw new Error("设备连接已中断");
        const reply = await this.request("hello", { protocol: 1 });
        this.caps = validateCapabilities(reply.capabilities);
        this.emit({ type: "connection", ...this.snapshot() });
        return this.snapshot();
      } catch (e) {
        this.fail(e.message);
        throw e;
      }
    } finally {
      this.connecting = false;
    }
  }
  fail(message) {
    const port = this.port;
    this.port = null;
    this.caps = null;
    this.active = null;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(message));
    }
    this.pending.clear();
    this.flush();
    if (port?.isOpen) port.close(() => {});
    this.emit({ type: "connection", ...this.snapshot(), message });
  }
  async disconnect() {
    if (this.active) {
      try {
        await this.request("capture.stop", {});
      } catch {
        /* watchdog also stops output */
      }
    }
    this.fail("设备已断开");
    return this.snapshot();
  }
  request(command, config) {
    if (!this.port?.isOpen) return Promise.reject(new Error("USB 设备未连接"));
    const sequence = ++this.sequence >>> 0;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(sequence);
        reject(new Error(`${command} 响应超时；请检查固件与 USB 连接`));
      }, 4000);
      this.pending.set(sequence, { resolve, reject, timer });
      this.port.write(
        encodeFrame(KIND.REQUEST, sequence, { command, config }),
        (error) => {
          if (!error) return;
          clearTimeout(timer);
          this.pending.delete(sequence);
          reject(error);
        },
      );
    });
  }
  onFrame({ kind, sequence, value }) {
    if (kind === KIND.REPLY) {
      const item = this.pending.get(sequence);
      if (!item) return;
      clearTimeout(item.timer);
      this.pending.delete(sequence);
      if (value.ok === true) item.resolve(value);
      else item.reject(new Error(String(value.error || "设备拒绝了命令")));
    } else if (kind === KIND.EVENT && this.caps) {
      try {
        validateEvent(value);
        const feature =
          value.type === "packet"
            ? value.protocol
            : value.type === "logic"
              ? "logic"
              : null;
        if (feature && !this.caps.features.includes(feature))
          throw new Error("设备发送了未声明能力的数据");
        if (
          value.type === "logic" &&
          (value.channels > this.caps.logicChannels ||
            value.samples.length > this.caps.maxSamples ||
            !this.caps.sampleRates.includes(value.sampleRate))
        )
          throw new Error("逻辑采样超出设备声明的能力");
        if (value.type === "logic") {
          this.active = null;
          this.emit({ type: "connection", ...this.snapshot() });
        }
        if (this.queue.length >= 512) this.hostDropped++;
        else this.queue.push(value);
      } catch (e) {
        this.emit({ type: "warning", message: e.message });
      }
    }
  }
  async command(command, config = {}) {
    if (!this.caps) throw new Error("请先连接 dongle");
    if (this.busy) throw new Error("上一条命令尚未完成");
    const feature = {
      "wifi.start": "wifi",
      "ble.start": "ble",
      "logic.start": "logic",
      "uart.transfer": "uart",
      "spi.transfer": "spi",
      "i2c.transfer": "i2c",
      "modbus.transfer": "modbus",
    }[command];
    if (!feature && command !== "capture.stop")
      throw new Error("不支持的设备命令");
    if (feature && !this.caps.features.includes(feature))
      throw new Error("当前固件未提供此能力");
    if (this.active && command !== "capture.stop")
      throw new Error("请先停止当前采集；首版采集与总线操作互斥");
    const integer = (key, min, max) => {
      if (
        !Number.isInteger(config[key]) ||
        config[key] < min ||
        config[key] > max
      )
        throw new Error(`无效参数：${key}`);
    };
    if (feature === "wifi" && !this.caps.wifiChannels.includes(config.channel))
      throw new Error("当前设备不支持此信道");
    if (feature === "logic") {
      if (!this.caps.sampleRates.includes(config.sampleRate))
        throw new Error("采样率超出设备能力");
      integer("sampleCount", 16, this.caps.maxSamples);
      integer("triggerChannel", 0, this.caps.logicChannels - 1);
      if (!["immediate", "rising", "falling"].includes(config.trigger))
        throw new Error("无效触发方式");
    }
    if (command.endsWith(".transfer")) {
      if (
        typeof config.hex !== "string" ||
        !/^(?:[0-9a-fA-F]{2})*$/.test(config.hex) ||
        config.hex.length > 2048
      )
        throw new Error("发送内容必须为完整 HEX 字节，最多 1024 字节");
      integer("timeoutMs", 100, 3000);
      integer("readLength", 0, 1024);
      if (feature === "i2c") integer("address", 8, 119);
      if (feature === "spi") {
        integer("mode", 0, 3);
        integer("frequency", 1000, 10000000);
      }
      if (feature === "spi" && config.readLength !== config.hex.length / 2)
        throw new Error(
          "SPI 为全双工操作，接收字节数应等于发送字节数；请补齐时钟用的 00 字节",
        );
      if (feature === "i2c") integer("frequency", 10000, 400000);
      if (feature === "uart" || feature === "modbus")
        integer("baudRate", 300, 2000000);
    }
    this.busy = true;
    if (command.endsWith(".start")) this.active = feature;
    try {
      const result = await this.request(command, config);
      if (command === "capture.stop") this.active = null;
      this.emit({ type: "connection", ...this.snapshot() });
      return result;
    } catch (e) {
      // A lost ACK leaves hardware state unknown. Drop USB; firmware watchdog must disarm.
      if (/响应超时/.test(e.message)) this.fail(e.message);
      else if (command.endsWith(".start")) this.active = null;
      throw e;
    } finally {
      this.busy = false;
    }
  }
  dispose() {
    clearInterval(this.timer);
    this.fail("程序已关闭");
  }
}
module.exports = { ProbeManager };
