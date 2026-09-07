import { useMemo, useState } from "react";
import { Download, Play, Square, ZoomIn, ZoomOut, Waves } from "lucide-react";
import type { LogicCapture, ProbeCapabilities } from "./types";
import { decodeI2c, decodeSpi, decodeUart, exportVcd } from "./analysis";
const colors = [
  "#21c3a0",
  "#63b3ed",
  "#bd93f9",
  "#f7bc62",
  "#ec8cac",
  "#66d9ce",
  "#98bd76",
  "#879bad",
];
export function LogicView({
  capture,
  caps,
  busy,
  active,
  run,
  save,
}: {
  capture: LogicCapture | null;
  caps: ProbeCapabilities | null;
  busy: boolean;
  active: string | null;
  run: (name: string, config?: Record<string, unknown>) => void;
  save: (name: string, content: string | Uint8Array, mime?: string) => void;
}) {
  const [rate, setRate] = useState(1000000),
    [sampleCount, setSampleCount] = useState(2048);
  const [trigger, setTrigger] = useState("immediate"),
    [triggerChannel, setTriggerChannel] = useState(0);
  const [decoder, setDecoder] = useState("uart"),
    [baud, setBaud] = useState(115200),
    [spiMode, setSpiMode] = useState(0);
  const [pinA, setPinA] = useState(0),
    [pinB, setPinB] = useState(1),
    [pinC, setPinC] = useState(2);
  const [zoom, setZoom] = useState(1),
    [offset, setOffset] = useState(0),
    [cursor, setCursor] = useState<[number | null, number | null]>([
      null,
      null,
    ]);
  const decoded = useMemo(
    () =>
      capture
        ? decoder === "uart"
          ? decodeUart(capture, pinA, baud)
          : decoder === "spi"
            ? decodeSpi(capture, pinA, pinB, pinC, spiMode)
            : decodeI2c(capture, pinA, pinB)
        : [],
    [capture, decoder, pinA, pinB, pinC, baud, spiMode],
  );
  const count = capture
    ? Math.max(32, Math.ceil(capture.samples.length / zoom))
    : 2048;
  const start = Math.min(
    offset,
    Math.max(0, (capture?.samples.length || 0) - count),
  );
  const channels = capture?.channels || caps?.logicChannels || 8;
  const nameFor = (ch: number) =>
    ch === pinA
      ? decoder === "uart"
        ? "UART RX"
        : decoder === "spi"
          ? "SPI CLK"
          : "I²C SCL"
      : decoder !== "uart" && ch === pinB
        ? decoder === "spi"
          ? "SPI MOSI"
          : "I²C SDA"
        : decoder === "spi" && ch === pinC
          ? "SPI CS"
          : "DIGITAL";
  const validRate = caps?.sampleRates.includes(rate)
    ? rate
    : caps?.sampleRates[0] || rate;
  const validCount = Math.min(sampleCount, caps?.maxSamples || sampleCount);
  const pathFor = (ch: number) => {
    if (!capture) return "";
    let path = "",
      prev = -1;
    for (
      let i = start;
      i < Math.min(capture.samples.length, start + count);
      i++
    ) {
      const bit = (capture.samples[i] >> ch) & 1,
        x = 132 + ((i - start) / count) * 860,
        y = 62 + ch * 51 + (bit ? 0 : 22);
      if (i === start) path = `M${x} ${y}`;
      else if (bit !== prev) path += ` H${x} V${y}`;
      prev = bit;
    }
    return path + " H992";
  };
  const chooseDecoder = (value: string) => {
    setDecoder(value);
    setPinA(value === "uart" ? 0 : value === "i2c" ? 1 : 3);
    setPinB(value === "i2c" ? 2 : 4);
    setPinC(6);
  };
  return (
    <>
      <div className="s-page-heading">
        <div>
          <span className="s-eyebrow">DIGITAL SIGNALS</span>
          <h1>逻辑分析仪</h1>
          <p>捕获时序、放大边沿，让总线对话清晰可见。</p>
        </div>
        <button
          disabled={!capture}
          onClick={() =>
            capture && save("ebed-logic.vcd", exportVcd(capture), "text/plain")
          }
        >
          <Download size={16} />
          导出 VCD
        </button>
      </div>
      <section className="s-panel s-controlbar">
        <label>
          采样率
          <select
            value={validRate}
            disabled={!!active}
            onChange={(e) => setRate(+e.target.value)}
          >
            {(caps?.sampleRates.length ? caps.sampleRates : [1000000]).map(
              (n) => (
                <option key={n} value={n}>
                  {n / 1e6} MSa/s
                </option>
              ),
            )}
          </select>
        </label>
        <label>
          采样点数
          <input
            type="number"
            min={16}
            max={caps?.maxSamples || 32768}
            value={validCount}
            onChange={(e) => setSampleCount(Math.max(16, +e.target.value))}
          />
        </label>
        <label>
          触发条件
          <select value={trigger} onChange={(e) => setTrigger(e.target.value)}>
            <option value="immediate">立即采集</option>
            <option value="rising">上升沿</option>
            <option value="falling">下降沿</option>
          </select>
        </label>
        <label>
          触发通道
          <select
            value={Math.min(triggerChannel, channels - 1)}
            onChange={(e) => setTriggerChannel(+e.target.value)}
          >
            {Array.from({ length: channels }, (_, i) => (
              <option key={i} value={i}>
                D{i}
              </option>
            ))}
          </select>
        </label>
        <button
          className="s-primary"
          disabled={
            busy ||
            (!active && !caps?.features.includes("logic")) ||
            (!!active && active !== "logic")
          }
          onClick={() =>
            run(active ? "capture.stop" : "logic.start", {
              sampleRate: validRate,
              sampleCount: validCount,
              trigger,
              triggerChannel: Math.min(triggerChannel, channels - 1),
            })
          }
        >
          {active === "logic" ? <Square size={15} /> : <Play size={15} />}
          {active === "logic" ? "停止等待" : "单次采集"}
        </button>
      </section>
      <section className="s-wave-panel">
        <div className="s-wave-toolbar">
          <span>
            <i className="s-dot" />
            {capture
              ? `${capture.channels} 通道 · ${capture.sampleRate / 1e6} MSa/s · ${((capture.samples.length / capture.sampleRate) * 1000).toFixed(3)} ms`
              : "等待数字信号"}
          </span>
          <div>
            <button
              aria-label="缩小波形"
              disabled={!capture || zoom === 1}
              onClick={() => setZoom((z) => Math.max(1, z / 2))}
            >
              <ZoomOut size={16} />
            </button>
            <span>{zoom}×</span>
            <button
              aria-label="放大波形"
              disabled={!capture || zoom >= 32}
              onClick={() => setZoom((z) => Math.min(32, z * 2))}
            >
              <ZoomIn size={16} />
            </button>
            <button onClick={() => setCursor([null, null])}>清除游标</button>
          </div>
        </div>
        {!capture ? (
          <div className="s-wave-empty">
            <Waves size={44} />
            <h3>等待第一次采集</h3>
            <p>连接带逻辑采样能力的设备，或在演示工作区查看 8 通道波形。</p>
            <span>UART · SPI · I²C 离线解码 / A、B 游标 / VCD 导出</span>
          </div>
        ) : (
          <svg
            className="s-wave-svg"
            viewBox={`0 0 1024 ${76 + channels * 51}`}
            role="img"
            aria-label="数字波形，点击波形区放置 A、B 游标"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect(),
                x = ((e.clientX - rect.left) / rect.width) * 1024;
              if (x < 132 || x > 992) return;
              const sample = Math.round(start + ((x - 132) / 860) * count);
              setCursor(([a, b]) =>
                a === null || b !== null ? [sample, null] : [a, sample],
              );
            }}
          >
            {Array.from({ length: 9 }, (_, i) => (
              <g key={i}>
                <line
                  x1={132 + i * 107.5}
                  y1={35}
                  x2={132 + i * 107.5}
                  y2={65 + channels * 51}
                  stroke="#2b3b4d"
                  strokeDasharray="3 5"
                />
                <text x={132 + i * 107.5} y={22} fill="#8da0b4" fontSize={11}>
                  {(
                    ((start + (i * count) / 8) / capture.sampleRate) *
                    1e6
                  ).toFixed(0)}{" "}
                  µs
                </text>
              </g>
            ))}
            {Array.from({ length: channels }, (_, i) => (
              <g key={i}>
                <text x={20} y={77 + i * 51} fill={colors[i]} fontSize={12}>
                  D{i}
                </text>
                <text x={48} y={77 + i * 51} fill="#94a8ba" fontSize={10}>
                  {nameFor(i)}
                </text>
                <path
                  d={pathFor(i)}
                  stroke={colors[i]}
                  fill="none"
                  strokeWidth={1.6}
                />
              </g>
            ))}
            {cursor.map(
              (sample, i) =>
                sample !== null &&
                sample >= start &&
                sample <= start + count && (
                  <g key={i}>
                    <line
                      x1={132 + ((sample - start) / count) * 860}
                      y1={35}
                      x2={132 + ((sample - start) / count) * 860}
                      y2={65 + channels * 51}
                      stroke="#fff"
                      strokeDasharray="5 3"
                    />
                    <text
                      x={136 + ((sample - start) / count) * 860}
                      y={46}
                      fill="#fff"
                      fontSize={12}
                    >
                      {i ? "B" : "A"}
                    </text>
                  </g>
                ),
            )}
          </svg>
        )}
        <div className="s-wave-footer">
          <span>
            点击放置 A / B 游标{" "}
            {cursor[0] !== null &&
              cursor[1] !== null &&
              capture &&
              `· Δt = ${((Math.abs(cursor[1] - cursor[0]) / capture.sampleRate) * 1e6).toFixed(2)} µs`}
          </span>
          {capture && (
            <label>
              平移
              <input
                aria-label="波形平移"
                type="range"
                min={0}
                max={Math.max(0, capture.samples.length - count)}
                value={start}
                onChange={(e) => setOffset(+e.target.value)}
              />
            </label>
          )}
        </div>
      </section>
      <section className="s-panel s-decoder">
        <div className="s-section-title">
          <h3>协议解码</h3>
          <span>8N1 / SPI 8-bit MSB / I²C 7-bit</span>
        </div>
        <div className="s-controlbar">
          <label>
            协议
            <select
              value={decoder}
              onChange={(e) => chooseDecoder(e.target.value)}
            >
              <option value="uart">UART</option>
              <option value="spi">SPI</option>
              <option value="i2c">I²C</option>
            </select>
          </label>
          {[
            [
              pinA,
              setPinA,
              decoder === "uart" ? "RX" : decoder === "spi" ? "CLK" : "SCL",
            ],
            ...(decoder !== "uart"
              ? [[pinB, setPinB, decoder === "spi" ? "MOSI" : "SDA"]]
              : []),
            ...(decoder === "spi" ? [[pinC, setPinC, "CS（低有效）"]] : []),
          ].map(([v, setter, label]) => (
            <label key={String(label)}>
              {String(label)}
              <select
                value={Number(v)}
                onChange={(e) =>
                  (setter as (v: number) => void)(+e.target.value)
                }
              >
                {Array.from({ length: channels }, (_, i) => (
                  <option key={i} value={i}>
                    D{i}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {decoder === "uart" && (
            <label>
              波特率
              <select value={baud} onChange={(e) => setBaud(+e.target.value)}>
                {[9600, 19200, 38400, 57600, 115200, 230400].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
          )}
          {decoder === "spi" && (
            <label>
              SPI 模式
              <select
                value={spiMode}
                onChange={(e) => setSpiMode(+e.target.value)}
              >
                {[0, 1, 2, 3].map((n) => (
                  <option key={n} value={n}>
                    Mode {n}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="s-decode-tokens">
          {decoded.length ? (
            decoded.slice(0, 200).map((item, i) => (
              <span className={item.error ? "error" : ""} key={i}>
                <small>
                  {capture
                    ? ((item.start / capture.sampleRate) * 1e6).toFixed(1)
                    : 0}{" "}
                  µs
                </small>
                {item.text}
              </span>
            ))
          ) : (
            <p>暂无解码结果。采集后请确认通道映射、速率和协议模式。</p>
          )}
        </div>
      </section>
    </>
  );
}
