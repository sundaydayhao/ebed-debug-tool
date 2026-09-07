import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeI2c,
  decodeSpi,
  decodeUart,
  describePacket,
  exportPcapng,
  exportVcd,
  strictHex,
  toBase64,
  validateSession,
} from "../src/probe/analysis";
import { demoLogic, demoPacket } from "../src/probe/demo";
import { crc16Modbus, buildModbusFrame } from "../src/lib/protocols";

test("HEX rejects malformed input instead of silently changing transmitted bytes", () => {
  assert.equal(strictHex("01 03\n00 FF"), "010300FF");
  for (const value of ["0", "0x01", "GG", "01,02", "AA".repeat(1025)])
    assert.throws(() => strictHex(value));
});
test("802.11 extracts SSID and handles short control frames and DS addressing", () => {
  const beacon = describePacket(demoPacket(1, "wifi", 6), 1);
  assert.equal(beacon.frameType, "Beacon");
  assert.match(beacon.summary, /Sensor-Network/);
  const raw = new Uint8Array(30);
  raw[0] = 8;
  raw[1] = 3;
  raw.fill(1, 4, 10);
  raw.fill(2, 10, 16);
  raw.fill(3, 16, 22);
  raw.fill(4, 24, 30);
  const wds = describePacket(
    { ...demoPacket(1, "wifi", 6), data: toBase64(raw) },
    2,
  );
  assert.equal(wds.source, "04:04:04:04:04:04");
  assert.equal(wds.destination, "03:03:03:03:03:03");
  raw[0] = 0xd4;
  assert.equal(
    describePacket(
      { ...demoPacket(1, "wifi", 6), data: toBase64(raw.slice(0, 10)) },
      3,
    ).source,
    "—",
  );
});
test("PCAPNG exports Wi-Fi only with aligned blocks, Radiotap metadata, exact timestamps", () => {
  const p = {
    ...demoPacket(1, "wifi", 6),
    timestampUs: 1788881234567890,
    rssi: -63,
    fcs: true,
  };
  const output = exportPcapng([p, demoPacket(2, "ble", 0)], "demo fixture");
  const v = new DataView(output.buffer);
  let offset = 0;
  const types: number[] = [];
  while (offset < output.length) {
    const type = v.getUint32(offset, true),
      length = v.getUint32(offset + 4, true);
    types.push(type);
    assert.equal(length % 4, 0);
    assert.ok(length >= 12);
    assert.equal(v.getUint32(offset + length - 4, true), length);
    if (type === 1) assert.equal(v.getUint16(offset + 8, true), 127);
    if (type === 6) {
      assert.equal(
        v.getUint32(offset + 12, true) * 2 ** 32 +
          v.getUint32(offset + 16, true),
        p.timestampUs,
      );
      const radio = offset + 28;
      assert.equal(v.getUint16(radio + 2, true), 16);
      assert.equal(v.getUint16(radio + 10, true), 2437);
      assert.equal(v.getInt8(radio + 14), -63);
      assert.equal(v.getUint8(radio + 8), 0x10);
      assert.equal(v.getUint8(radio + 16), 0x80);
    }
    offset += length;
  }
  assert.equal(offset, output.length);
  assert.deepEqual(types, [0x0a0d0d0a, 1, 6]);
});
test("UART 8N1 decoder samples the centers of asynchronous bits and rejects inadequate sampling", () => {
  const capture = demoLogic();
  const tokens = decodeUart(capture);
  assert.equal(tokens.length, 10);
  assert.match(tokens[0].text, /0x48 H/);
  assert.match(tokens[9].text, /0x44 D/);
  assert.equal(
    tokens.some((t) => t.error),
    false,
  );
  assert.equal(decodeUart({ ...capture, sampleRate: 100000 })[0].error, true);
});
test("I2C decoder recovers address, direction, data and ACK from waveform edges", () => {
  const result = decodeI2c(demoLogic()).map((t) => t.text);
  assert.deepEqual(result, [
    "START",
    "地址 0x50 W · ACK",
    "0x00 · ACK",
    "0x2A · ACK",
    "STOP",
  ]);
});
test("SPI decodes bytes within active CS, all four modes use correct sampling edge", () => {
  const result = decodeSpi(demoLogic()).map((t) => t.text);
  assert.deepEqual(result, [
    "MOSI 0x9F",
    "MOSI 0xEF",
    "MOSI 0x40",
    "MOSI 0x18",
  ]);
  for (const mode of [0, 1, 2, 3]) {
    const samples = [4 | (mode >= 2 ? 1 : 0)];
    for (let bit = 7; bit >= 0; bit--) {
      const data = ((0xa5 >> bit) & 1) << 1,
        idle = mode >= 2 ? 1 : 0;
      samples.push(data | idle, data | (idle ^ 1), data | idle);
    }
    samples.push(4);
    assert.equal(
      decodeSpi(
        {
          type: "logic",
          timestampUs: 0,
          channels: 3,
          sampleRate: 1000000,
          samples,
        },
        0,
        1,
        2,
        mode,
      )[0].text,
      "MOSI 0xA5",
    );
  }
});
test("VCD preserves initial levels and transition timestamps without repeated steady samples", () => {
  const vcd = exportVcd({
    type: "logic",
    timestampUs: 0,
    sampleRate: 1000000,
    channels: 2,
    samples: [1, 1, 3, 0],
  });
  assert.match(vcd, /#0\n1!\n0"/);
  assert.match(vcd, /#2000\n1"/);
  assert.doesNotMatch(vcd, /#1000/);
});
test("session replay validates bounded data and never imports hardware capabilities", () => {
  const good = {
    version: 1,
    source: "demo",
    createdAt: new Date().toISOString(),
    capabilities: { features: ["wifi"] },
    packets: [demoPacket(1, "wifi", 6)],
    logic: demoLogic(),
  };
  assert.equal(validateSession(good).capabilities, null);
  for (const bad of [
    null,
    {},
    { ...good, version: 2 },
    { ...good, source: "unknown" },
    { ...good, packets: Array(2001).fill(good.packets[0]) },
    { ...good, logic: { ...good.logic, channels: 2, samples: [255] } },
    { ...good, packets: [{ ...good.packets[0], data: "<script>" }] },
  ])
    assert.throws(() => validateSession(bad));
});
test("Modbus golden request and demo response CRC are correct", () => {
  assert.equal(
    buildModbusFrame({
      variant: "rtu",
      unitId: 1,
      functionCode: 3,
      address: 0,
      quantity: 10,
      value: 0,
      transactionId: 1,
    }),
    "01 03 00 00 00 0A C5 CD",
  );
  assert.equal(crc16Modbus([1, 3, 4, 0, 42, 0, 100]), 0x10da);
});
