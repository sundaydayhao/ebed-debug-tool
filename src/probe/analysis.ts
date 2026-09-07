import type { LogicCapture, Packet, PacketRow, SessionData } from "./types";

export const toBytes = (data: string) =>
  Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
export const toBase64 = (bytes: number[] | Uint8Array) =>
  btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
export const hex = (bytes: ArrayLike<number>) =>
  Array.from(bytes, (n) => n.toString(16).padStart(2, "0"))
    .join(" ")
    .toUpperCase();
export function strictHex(value: string) {
  const clean = value.replace(/\s/g, "");
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(clean))
    throw new Error("HEX 必须为完整字节，例如 01 03 00 00");
  if (clean.length > 2048) throw new Error("单次最多发送 1024 字节");
  return clean.toUpperCase();
}
const mac = (b: Uint8Array, start: number) =>
  b.length < start + 6
    ? "—"
    : Array.from(b.slice(start, start + 6), (n) =>
        n.toString(16).padStart(2, "0"),
      ).join(":");
export function describePacket(packet: Packet, id: number): PacketRow {
  const b = toBytes(packet.data);
  if (packet.protocol === "ble")
    return {
      ...packet,
      id,
      source: packet.address || "—",
      destination: "广播扫描报告",
      summary: packet.name || "未广播名称",
      frameType: "ADV report",
    };
  if (b.length < 2)
    return {
      ...packet,
      id,
      source: "—",
      destination: "—",
      summary: "截断的 802.11 帧",
      frameType: "Truncated",
    };
  const type = (b[0] >> 2) & 3,
    subtype = b[0] >> 4;
  const names: Record<number, string> = {
    0: "Association Request",
    1: "Association Response",
    4: "Probe Request",
    5: "Probe Response",
    8: "Beacon",
    10: "Disassociation",
    11: "Authentication",
    12: "Deauthentication",
  };
  const ctrl: Record<number, string> = {
    8: "Block ACK Request",
    9: "Block ACK",
    11: "RTS",
    12: "CTS",
    13: "ACK",
  };
  const frameType =
    type === 0
      ? names[subtype] || "Management"
      : type === 1
        ? ctrl[subtype] || "Control"
        : type === 2
          ? subtype & 8
            ? "QoS Data"
            : "Data"
          : "Extension";
  let source = mac(b, 10),
    destination = mac(b, 4);
  if (type === 1 && [12, 13].includes(subtype)) source = "—";
  if (type === 2) {
    const toDS = !!(b[1] & 1),
      fromDS = !!(b[1] & 2);
    if (toDS) destination = mac(b, 16);
    if (fromDS) source = mac(b, toDS ? 24 : 16);
  }
  let summary = frameType;
  if (type === 0 && [4, 5, 8].includes(subtype)) {
    let pos = subtype === 4 ? 24 : 36;
    while (pos + 2 <= b.length) {
      const tag = b[pos],
        length = b[pos + 1];
      if (pos + 2 + length > b.length) break;
      if (tag === 0) {
        summary += ` · ${new TextDecoder().decode(b.slice(pos + 2, pos + 2 + length)) || "隐藏 SSID"}`;
        break;
      }
      pos += 2 + length;
    }
  }
  if (b[1] & 0x40) summary += " · 受保护载荷";
  if (b[1] & 8) summary += " · 重传";
  return { ...packet, id, source, destination, frameType, summary };
}

// PCAPNG + Radiotap, little endian; timestamps in microseconds (IDB default).
export function exportPcapng(packets: Packet[], comment: string) {
  const result: Uint8Array[] = [];
  const block = (type: number, body: Uint8Array) => {
    const size = 12 + Math.ceil(body.length / 4) * 4;
    const bytes = new Uint8Array(size),
      view = new DataView(bytes.buffer);
    view.setUint32(0, type, true);
    view.setUint32(4, size, true);
    bytes.set(body, 8);
    view.setUint32(size - 4, size, true);
    result.push(bytes);
  };
  const section = new Uint8Array(16),
    sv = new DataView(section.buffer);
  sv.setUint32(0, 0x1a2b3c4d, true);
  sv.setUint16(4, 1, true);
  sv.setBigInt64(8, -1n, true);
  block(0x0a0d0d0a, section);
  const text = new TextEncoder().encode(comment),
    optionLength = 4 + Math.ceil(text.length / 4) * 4;
  const iface = new Uint8Array(8 + optionLength + 4),
    iv = new DataView(iface.buffer);
  iv.setUint16(0, 127, true);
  iv.setUint32(4, 65535, true);
  iv.setUint16(8, 1, true);
  iv.setUint16(10, text.length, true);
  iface.set(text, 12);
  block(1, iface);
  for (const packet of packets.filter((p) => p.protocol === "wifi")) {
    const raw = toBytes(packet.data),
      captured = new Uint8Array(16 + raw.length),
      rv = new DataView(captured.buffer);
    rv.setUint16(2, 16, true);
    rv.setUint32(4, 0x2a, true);
    captured[8] = packet.fcs ? 0x10 : 0;
    rv.setUint16(
      10,
      packet.channel === 14 ? 2484 : 2407 + packet.channel * 5,
      true,
    );
    rv.setUint16(12, 0x0080, true);
    rv.setInt8(14, packet.rssi);
    captured.set(raw, 16);
    const body = new Uint8Array(20 + Math.ceil(captured.length / 4) * 4),
      pv = new DataView(body.buffer);
    const timestamp = BigInt(Math.round(packet.timestampUs));
    pv.setUint32(4, Number(timestamp >> 32n), true);
    pv.setUint32(8, Number(timestamp & 0xffffffffn), true);
    pv.setUint32(12, captured.length, true);
    pv.setUint32(16, packet.originalLength + 16, true);
    body.set(captured, 20);
    block(6, body);
  }
  const merged = new Uint8Array(result.reduce((sum, b) => sum + b.length, 0));
  let offset = 0;
  for (const b of result) {
    merged.set(b, offset);
    offset += b.length;
  }
  return merged;
}
export function validateSession(input: unknown): SessionData {
  const fail = () => {
    throw new Error(
      "会话格式无效或数据超出限制（最多 2,000 帧 / 32,768 个采样点）",
    );
  };
  if (!input || typeof input !== "object") return fail();
  const s = input as SessionData;
  if (
    s.version !== 1 ||
    !["demo", "device"].includes(s.source) ||
    typeof s.createdAt !== "string" ||
    !Number.isFinite(Date.parse(s.createdAt)) ||
    !Array.isArray(s.packets) ||
    s.packets.length > 2000
  )
    return fail();
  for (const p of s.packets) {
    if (
      !p ||
      p.type !== "packet" ||
      !["wifi", "ble"].includes(p.protocol) ||
      !Number.isSafeInteger(p.timestampUs) ||
      p.timestampUs < 0 ||
      !Number.isInteger(p.rssi) ||
      p.rssi < -128 ||
      p.rssi > 20 ||
      !Number.isInteger(p.channel) ||
      p.channel < (p.protocol === "wifi" ? 1 : 0) ||
      p.channel > (p.protocol === "wifi" ? 14 : 40) ||
      typeof p.data !== "string" ||
      p.data.length > 12000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        p.data,
      )
    )
      return fail();
    if (
      !Number.isInteger(p.originalLength) ||
      p.originalLength < toBytes(p.data).length ||
      p.originalLength > 65535 ||
      (p.address !== undefined && typeof p.address !== "string") ||
      (p.name !== undefined && typeof p.name !== "string")
    )
      return fail();
  }
  const l = s.logic;
  if (
    l !== null &&
    (!l ||
      l.type !== "logic" ||
      !Number.isSafeInteger(l.timestampUs) ||
      l.timestampUs < 0 ||
      !Number.isInteger(l.channels) ||
      l.channels < 1 ||
      l.channels > 8 ||
      !Number.isInteger(l.sampleRate) ||
      l.sampleRate < 1 ||
      l.sampleRate > 200000000 ||
      !Array.isArray(l.samples) ||
      !l.samples.length ||
      l.samples.length > 32768 ||
      l.samples.some(
        (v) => !Number.isInteger(v) || v < 0 || v >= 1 << l.channels,
      ))
  )
    return fail();
  // Device capabilities from disk never authorize hardware operations.
  return {
    version: 1,
    createdAt: s.createdAt,
    source: s.source,
    capabilities: null,
    packets: s.packets,
    logic: s.logic,
  };
}

export interface DecodedItem {
  start: number;
  end: number;
  text: string;
  error?: boolean;
}
export function decodeUart(
  c: LogicCapture,
  channel = 0,
  baud = 115200,
): DecodedItem[] {
  const out: DecodedItem[] = [],
    step = c.sampleRate / baud,
    bit = (i: number) => (c.samples[Math.floor(i)] >> channel) & 1;
  if (step < 4)
    return [
      {
        start: 0,
        end: 0,
        text: "采样率不足：UART 至少需要 4 倍波特率",
        error: true,
      },
    ];
  for (let i = 1; i + step * 9.5 < c.samples.length; i++) {
    if (!bit(i - 1) || bit(i) || bit(i + step * 0.5)) continue;
    let value = 0;
    for (let n = 0; n < 8; n++) value |= bit(i + step * (n + 1.5)) << n;
    const ok = bit(i + step * 9.5);
    out.push({
      start: i,
      end: Math.ceil(i + step * 10),
      text: `0x${hex([value])} ${value >= 32 && value < 127 ? String.fromCharCode(value) : ""}${ok ? "" : " · 停止位错误"}`,
      error: !ok,
    });
    i = Math.floor(i + step * 9.5);
  }
  return out;
}
export function decodeSpi(
  c: LogicCapture,
  clk = 3,
  mosi = 4,
  cs = 6,
  mode = 0,
): DecodedItem[] {
  const bit = (i: number, ch: number) => (c.samples[i] >> ch) & 1;
  const out: DecodedItem[] = [];
  let value = 0,
    count = 0,
    start = 0;
  const rising = mode === 0 || mode === 3;
  for (let i = 1; i < c.samples.length; i++) {
    if (bit(i, cs)) {
      count = 0;
      value = 0;
      continue;
    }
    if (bit(i, clk) === bit(i - 1, clk) || Boolean(bit(i, clk)) !== rising)
      continue;
    if (!count) start = i;
    value = (value << 1) | bit(i, mosi);
    count++;
    if (count === 8) {
      out.push({ start, end: i, text: `MOSI 0x${hex([value])}` });
      value = 0;
      count = 0;
    }
  }
  return out;
}
export function decodeI2c(c: LogicCapture, scl = 1, sda = 2): DecodedItem[] {
  const bit = (i: number, ch: number) => (c.samples[i] >> ch) & 1;
  const out: DecodedItem[] = [];
  let active = false,
    count = 0,
    value = 0,
    start = 0,
    address = true;
  for (let i = 1; i < c.samples.length; i++) {
    if (bit(i, scl) && bit(i - 1, scl) && bit(i, sda) !== bit(i - 1, sda)) {
      active = !bit(i, sda);
      count = 0;
      value = 0;
      address = true;
      out.push({ start: i, end: i, text: active ? "START" : "STOP" });
      continue;
    }
    if (!active || !bit(i, scl) || bit(i - 1, scl)) continue;
    if (!count) start = i;
    if (count < 8) {
      value = (value << 1) | bit(i, sda);
      count++;
    } else {
      const nack = !!bit(i, sda);
      out.push({
        start,
        end: i,
        text: `${address ? `地址 0x${hex([value >> 1])} ${value & 1 ? "R" : "W"}` : `0x${hex([value])}`} · ${nack ? "NACK" : "ACK"}`,
      });
      address = false;
      count = 0;
      value = 0;
    }
  }
  return out;
}
export function exportVcd(c: LogicCapture) {
  const header = [
    "$version EBED Studio $end",
    "$timescale 1 ns $end",
    "$scope module probe $end",
    ...Array.from(
      { length: c.channels },
      (_, i) => `$var wire 1 ${String.fromCharCode(33 + i)} D${i} $end`,
    ),
    "$upscope $end",
    "$enddefinitions $end",
  ];
  let previous = -1;
  c.samples.forEach((sample, i) => {
    if (sample === previous) return;
    header.push(`#${Math.round((i * 1e9) / c.sampleRate)}`);
    for (let ch = 0; ch < c.channels; ch++)
      if (i === 0 || ((sample ^ previous) >> ch) & 1)
        header.push(`${(sample >> ch) & 1}${String.fromCharCode(33 + ch)}`);
    previous = sample;
  });
  return header.join("\n") + "\n";
}
