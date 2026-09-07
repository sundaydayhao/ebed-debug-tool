// Ordinary serial transport. Opening a port never writes discovery/handshake bytes.
const defaults = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  rtscts: false,
};
function serialSettings(input = {}) {
  const config = { ...defaults, ...input };
  if (
    !Number.isInteger(config.baudRate) ||
    config.baudRate < 300 ||
    config.baudRate > 2000000 ||
    ![5, 6, 7, 8].includes(config.dataBits) ||
    ![1, 2].includes(config.stopBits) ||
    !["none", "even", "odd"].includes(config.parity) ||
    typeof config.rtscts !== "boolean"
  )
    throw new Error("串口参数无效");
  return Object.fromEntries(
    Object.keys(defaults).map((key) => [key, config[key]]),
  );
}
function crc16(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}
class SerialManager {
  constructor(SerialPort, emit) {
    this.SerialPort = SerialPort;
    this.emit = emit;
    this.port = null;
    this.connected = false;
    this.pending = null;
    this.busy = false;
    this.queue = [];
    this.dropped = 0;
    this.timer = setInterval(() => this.flush(), 50);
    this.timer.unref?.();
  }
  snapshot() {
    return {
      connected: this.connected,
      kind: "serial",
      path: this.port?.path || "",
      active: null,
      serialConfig: this.config,
      capabilities: this.connected
        ? {
            protocol: null,
            model: "普通串口",
            serial: this.port.path,
            firmware: "无需专用固件",
            features: ["uart", "modbus"],
            wifiChannels: [],
            logicChannels: 0,
            sampleRates: [],
            maxSamples: 0,
            pinout: {},
          }
        : null,
    };
  }
  async connect(path, config) {
    if (this.port) throw new Error("请先断开当前串口");
    this.config = serialSettings(config);
    const port = new this.SerialPort({ ...this.config, path, autoOpen: false });
    this.port = port;
    this.dropped = 0;
    port.on("data", (bytes) => {
      if (this.port !== port) return;
      this.record("rx", bytes);
      this.pending?.receive(bytes);
    });
    port.on("error", (error) => {
      if (this.port === port) this.fail(error.message);
    });
    port.on("close", () => {
      if (this.port === port) this.fail("串口已断开，请重新连接");
    });
    try {
      await new Promise((resolve, reject) =>
        port.open((error) => {
          if (error) return reject(error);
          if (this.port !== port) {
            port.close(() => {});
            return reject(new Error("串口连接已取消"));
          }
          resolve();
        }),
      );
      this.connected = true;
      this.emit({ type: "connection", ...this.snapshot() });
      return this.snapshot();
    } catch (error) {
      this.fail(error.message);
      throw error;
    }
  }
  record(direction, bytes) {
    for (let offset = 0; offset < bytes.length; offset += 2048) {
      const chunk = bytes.subarray(offset, offset + 2048);
      if (this.queue.length >= 512) this.dropped += chunk.length;
      else
        this.queue.push({
          at: new Date().toISOString(),
          direction,
          hex: chunk.toString("hex"),
        });
    }
  }
  flush() {
    if (!this.queue.length) return;
    this.emit({ type: "serial", entries: this.queue, dropped: this.dropped });
    this.queue = [];
  }
  fail(message) {
    const port = this.port;
    this.port = null;
    this.connected = false;
    this.pending?.finish(new Error(message));
    this.flush();
    if (port?.isOpen) port.close(() => {});
    this.emit({ type: "connection", ...this.snapshot(), message });
  }
  async disconnect() {
    this.fail("串口已断开");
    return this.snapshot();
  }
  async command(command, config = {}) {
    if (!this.connected || !this.port?.isOpen) throw new Error("请先连接串口");
    if (this.busy) throw new Error("上一条串口操作尚未完成");
    if (!["uart.send", "modbus.transfer"].includes(command))
      throw new Error("普通串口支持 UART 和 Modbus；此功能需要专用硬件");
    if (
      typeof config.hex !== "string" ||
      !/^(?:[a-fA-F0-9]{2}){1,1024}$/.test(config.hex)
    )
      throw new Error("发送内容必须为 1–1024 个完整 HEX 字节");
    const bytes = Buffer.from(config.hex, "hex");
    const modbus = command === "modbus.transfer";
    if (
      modbus &&
      (this.config.dataBits !== 8 ||
        bytes.length !== 8 ||
        bytes[0] < 1 ||
        bytes[0] > 247 ||
        bytes[1] !== 3 ||
        bytes.readUInt16BE(4) < 1 ||
        bytes.readUInt16BE(4) > 125 ||
        bytes.readUInt16BE(2) + bytes.readUInt16BE(4) > 65536 ||
        crc16(bytes.subarray(0, 6)) !== bytes.readUInt16LE(6))
    )
      throw new Error("Modbus 需要 8 数据位与有效的 FC03 请求帧");
    const timeout = config.timeoutMs ?? 1000;
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 3000)
      throw new Error("超时应为 100–3000 ms");
    this.busy = true;
    const port = this.port;
    try {
      return await new Promise((resolve, reject) => {
        let response = Buffer.alloc(0),
          written = false,
          complete = false;
        const finish = (error, result) => {
          if (complete) return;
          complete = true;
          clearTimeout(timer);
          this.pending = null;
          error ? reject(error) : resolve(result);
        };
        const check = () => {
          if (!written || !modbus || response.length < 2) return;
          if (response[0] !== bytes[0] || ![3, 0x83].includes(response[1]))
            return finish(
              new Error(
                "响应地址或功能码不匹配；请查看串口数据，检查本地回显或其他设备输出",
              ),
            );
          if (response.length < 3) return;
          const length = response[1] === 0x83 ? 5 : 5 + response[2];
          if (response.length < length) return;
          if (
            response.length !== length ||
            crc16(response.subarray(0, -2)) !==
              response.readUInt16LE(response.length - 2)
          )
            return finish(
              new Error("Modbus 响应长度或 CRC 错误；原始数据已保留在串口窗口"),
            );
          if (response[1] === 0x83)
            return finish(
              new Error(
                `Modbus 异常响应，异常码 0x${response[2].toString(16).padStart(2, "0")}`,
              ),
            );
          if (response[2] !== bytes.readUInt16BE(4) * 2)
            return finish(new Error("Modbus 返回的寄存器数量与请求不一致"));
          finish(null, {
            ok: true,
            hex: response.toString("hex"),
            message: "Modbus 响应地址、功能码、长度与 CRC 校验通过",
          });
        };
        const timer = setTimeout(() => {
          const message = !written
            ? "串口发送超时，连接已关闭；请检查流控设置与连接"
            : `Modbus 响应超时（已收到 ${response.length} 字节）；请检查串口参数、接线与从站地址`;
          finish(new Error(message));
          if (!written) this.fail(message);
        }, timeout);
        this.pending = {
          finish,
          receive: (chunk) => {
            if (!modbus || complete) return;
            if (response.length + chunk.length > 1024)
              return finish(new Error("响应超过 1024 字节；请检查目标输出"));
            response = Buffer.concat([response, chunk]);
            check();
          },
        };
        port.write(bytes, (error) => {
          if (complete) return;
          if (error) return finish(error);
          this.record("tx", bytes);
          port.drain((error) => {
            if (complete) return;
            if (error) return finish(error);
            written = true;
            if (modbus) check();
            else
              finish(null, {
                ok: true,
                hex: "",
                message: `已发送 ${bytes.length} 字节；实时接收见下方串口数据`,
              });
          });
        });
      });
    } finally {
      this.busy = false;
    }
  }
  dispose() {
    clearInterval(this.timer);
    this.fail("程序已关闭");
  }
}
module.exports = { SerialManager, serialSettings };
