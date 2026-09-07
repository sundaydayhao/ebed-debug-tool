import type { LogicCapture, Packet, ProbeCapabilities } from "./types";
import { toBase64 } from "./analysis";
export const demoCapabilities: ProbeCapabilities = {
  protocol: 1,
  model: "EBED Probe S3 · 演示设备",
  serial: "DEMO-0001",
  firmware: "EBP/1 simulator",
  features: ["wifi", "ble", "logic", "uart", "spi", "i2c", "modbus"],
  wifiChannels: Array.from({ length: 13 }, (_, i) => i + 1),
  logicChannels: 8,
  sampleRates: [1000000, 2000000],
  maxSamples: 32768,
  pinout: {
    UART: "D0 → RX / D1 → TX",
    I2C: "D1 → SCL / D2 → SDA",
    SPI: "D3 → SCLK / D4 → MOSI / D5 → MISO / D6 → CS",
    Modbus: "RS485 扩展口 A / B",
    Logic: "D0–D7 · 共地 · 3.3 V",
  },
};
export function demoPacket(
  index: number,
  protocol: "wifi" | "ble",
  channel: number,
): Packet {
  const base = {
    type: "packet" as const,
    protocol,
    timestampUs: Date.now() * 1000,
    channel: protocol === "ble" ? 0 : channel,
    rssi: -42 - ((index * 7) % 39),
  };
  if (protocol === "ble") {
    const data = [2, 1, 6, 9, 9, ...new TextEncoder().encode("Sensor-A")];
    return {
      ...base,
      data: toBase64(data),
      originalLength: data.length,
      name: ["Sensor-A", "Env Monitor", "EBED Tag"][index % 3],
      address: `d4:32:18:ab:09:${((index % 3) + 16).toString(16)}`,
    };
  }
  const beacon = index % 3 !== 0;
  const raw = [
    beacon ? 0x80 : 0x08,
    beacon ? 0 : 0x41,
    0,
    0,
    255,
    255,
    255,
    255,
    255,
    255,
    0x24,
    0x6f,
    0x28,
    0x12,
    0x34,
    0x50 + (index % 4),
    0x24,
    0x6f,
    0x28,
    0x12,
    0x34,
    0x50 + (index % 4),
    index & 255,
    0,
  ];
  if (beacon) {
    const ssid = new TextEncoder().encode(
      ["EBED-Lab", "Sensor-Network", "DevKit-AP", "Office-IoT"][index % 4],
    );
    raw.push(
      ...Array(8).fill(0),
      100,
      0,
      0x11,
      0x04,
      0,
      ssid.length,
      ...ssid,
      3,
      1,
      channel,
    );
  } else
    raw.push(...Array.from({ length: 48 }, (_, i) => (i * 19 + index) & 255));
  return {
    ...base,
    data: toBase64(raw),
    originalLength: raw.length,
    fcs: false,
  };
}
export function demoLogic(
  sampleRate = 1000000,
  sampleCount = 2048,
): LogicCapture {
  const samples = Array<number>(sampleCount).fill(0x47);
  const set = (start: number, end: number, ch: number, value: number) => {
    for (
      let i = Math.max(0, Math.round(start));
      i < Math.min(sampleCount, Math.round(end));
      i++
    )
      samples[i] = value ? samples[i] | (1 << ch) : samples[i] & ~(1 << ch);
  };
  let pos = 80;
  const step = sampleRate / 115200;
  for (const byte of new TextEncoder().encode("Hello EBED")) {
    set(pos, pos + step, 0, 0);
    for (let bit = 0; bit < 8; bit++)
      set(pos + step * (bit + 1), pos + step * (bit + 2), 0, (byte >> bit) & 1);
    pos += step * 12;
  }
  pos = 120;
  set(pos, pos + 8, 2, 0);
  pos += 8;
  for (const byte of [0xa0, 0x00, 0x2a]) {
    for (const value of [
      ...Array.from({ length: 8 }, (_, i) => (byte >> (7 - i)) & 1),
      0,
    ]) {
      set(pos, pos + 8, 1, 0);
      set(pos, pos + 16, 2, value);
      pos += 16;
    }
  }
  set(pos, pos + 8, 1, 0);
  set(pos, pos + 16, 2, 0);
  pos = 180;
  set(pos, pos + 4 * 8 * 16 + 8, 6, 0);
  for (const byte of [0x9f, 0xef, 0x40, 0x18])
    for (let bit = 7; bit >= 0; bit--) {
      set(pos + 8, pos + 16, 3, 1);
      set(pos, pos + 16, 4, (byte >> bit) & 1);
      set(pos, pos + 16, 5, ((byte ^ 0x55) >> bit) & 1);
      pos += 16;
    }
  set(80, 200, 7, 1);
  return {
    type: "logic",
    sampleRate,
    channels: 8,
    timestampUs: Date.now() * 1000,
    samples,
  };
}
