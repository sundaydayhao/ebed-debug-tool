// EBP/1: magic(4), version(1), kind(1), reserved(2), sequence(4), length(4), JSON, CRC32(4).
const MAGIC = Buffer.from("EBP1");
const MAX_PAYLOAD = 262144;
const KIND = { REQUEST: 1, REPLY: 2, EVENT: 3 };
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function encodeFrame(kind, sequence, value) {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length > MAX_PAYLOAD) throw new Error("EBP payload too large");
  const frame = Buffer.alloc(20 + payload.length);
  MAGIC.copy(frame);
  frame[4] = 1;
  frame[5] = kind;
  frame.writeUInt32LE(sequence >>> 0, 8);
  frame.writeUInt32LE(payload.length, 12);
  payload.copy(frame, 16);
  frame.writeUInt32LE(crc32(frame.subarray(0, -4)), frame.length - 4);
  return frame;
}
class FrameParser {
  constructor(onFrame, onError = () => {}) {
    this.buffer = Buffer.alloc(0);
    this.onFrame = onFrame;
    this.onError = onError;
  }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const start = this.buffer.indexOf(MAGIC);
      if (start < 0) {
        this.buffer = this.buffer.subarray(-3);
        return;
      }
      if (start) this.buffer = this.buffer.subarray(start);
      if (this.buffer.length < 16) return;
      const length = this.buffer.readUInt32LE(12);
      if (
        this.buffer[4] !== 1 ||
        ![1, 2, 3].includes(this.buffer[5]) ||
        this.buffer.readUInt16LE(6) !== 0 ||
        length > MAX_PAYLOAD
      ) {
        this.onError("无效的 EBP 帧头");
        this.buffer = this.buffer.subarray(4);
        continue;
      }
      if (this.buffer.length < 20 + length) return;
      const frame = this.buffer.subarray(0, 20 + length);
      if (
        crc32(frame.subarray(0, -4)) !== frame.readUInt32LE(frame.length - 4)
      ) {
        this.onError("USB 帧 CRC32 校验失败");
        this.buffer = this.buffer.subarray(4);
        continue;
      }
      this.buffer = this.buffer.subarray(frame.length);
      try {
        const value = JSON.parse(frame.subarray(16, -4).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("object required");
        this.onFrame({
          kind: frame[5],
          sequence: frame.readUInt32LE(8),
          value,
        });
      } catch (e) {
        this.onError(`无效的 EBP 消息：${e.message}`);
      }
    }
  }
}
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
function validateCapabilities(c) {
  if (
    !c ||
    c.protocol !== 1 ||
    typeof c.model !== "string" ||
    typeof c.serial !== "string" ||
    typeof c.firmware !== "string"
  )
    throw new Error("设备未返回有效的 EBP/1 身份");
  if (
    !Array.isArray(c.features) ||
    c.features.some(
      (f) =>
        !["wifi", "ble", "logic", "uart", "spi", "i2c", "modbus"].includes(f),
    )
  )
    throw new Error("无效的能力列表");
  if (
    !Array.isArray(c.wifiChannels) ||
    c.wifiChannels.some((n) => !int(n, 1, 14))
  )
    throw new Error("无效的地区信道列表");
  if (c.features.includes("wifi") && !c.wifiChannels.length)
    throw new Error("缺少 Wi-Fi 信道");
  if (
    !int(c.logicChannels, 0, 8) ||
    !Array.isArray(c.sampleRates) ||
    c.sampleRates.some((n) => !int(n, 1, 200000000)) ||
    !int(c.maxSamples, 0, 32768)
  )
    throw new Error("无效的采样能力");
  if (
    c.features.includes("logic") &&
    (!c.logicChannels || !c.sampleRates.length || !c.maxSamples)
  )
    throw new Error("缺少逻辑采样能力");
  if (!c.pinout || typeof c.pinout !== "object")
    throw new Error("缺少接线定义");
  for (const [key, value] of Object.entries(c.pinout))
    if (typeof key !== "string" || typeof value !== "string")
      throw new Error("无效接线定义");
  return c;
}
function validateEvent(e) {
  if (!e || !["packet", "logic", "stats", "log"].includes(e.type))
    throw new Error("未知设备事件");
  if (e.type === "packet") {
    if (
      !["wifi", "ble"].includes(e.protocol) ||
      !Number.isSafeInteger(e.timestampUs) ||
      e.timestampUs < 0 ||
      !int(e.rssi, -128, 20) ||
      !int(e.channel, 0, 40) ||
      typeof e.data !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        e.data,
      ) ||
      e.data.length > 12000
    )
      throw new Error("无效无线数据");
    if (e.protocol === "wifi" && !int(e.channel, 1, 14))
      throw new Error("无效 Wi-Fi 信道");
    if (!int(e.originalLength, Buffer.from(e.data, "base64").length, 65535))
      throw new Error("无效原始帧长度");
    if (
      e.protocol === "ble" &&
      (typeof e.address !== "string" || typeof e.name !== "string")
    )
      throw new Error("无效 BLE 广播报告");
  }
  if (
    e.type === "logic" &&
    (!Number.isSafeInteger(e.timestampUs) ||
      e.timestampUs < 0 ||
      !int(e.sampleRate, 1, 200000000) ||
      !int(e.channels, 1, 8) ||
      !Array.isArray(e.samples) ||
      !e.samples.length ||
      e.samples.length > 32768 ||
      e.samples.some((n) => !int(n, 0, (1 << e.channels) - 1)))
  )
    throw new Error("无效逻辑样本");
  if (
    e.type === "stats" &&
    (!int(e.dropped, 0, Number.MAX_SAFE_INTEGER) ||
      !int(e.received, 0, Number.MAX_SAFE_INTEGER))
  )
    throw new Error("无效采集统计");
  if (
    e.type === "log" &&
    (typeof e.message !== "string" || e.message.length > 8192)
  )
    throw new Error("无效设备日志");
  return e;
}
module.exports = {
  KIND,
  MAX_PAYLOAD,
  crc32,
  encodeFrame,
  FrameParser,
  validateCapabilities,
  validateEvent,
};
