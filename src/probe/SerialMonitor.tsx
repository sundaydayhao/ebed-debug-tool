import { useEffect, useRef, useState } from "react";
import { Download, Terminal, Trash2 } from "lucide-react";
import type { SerialEntry } from "./types";
export function SerialMonitor({
  entries,
  bytes,
  dropped,
  connected,
  clear,
  save,
}: {
  entries: SerialEntry[];
  bytes: { rx: number; tx: number; evicted: number };
  dropped: number;
  connected: boolean;
  clear: () => void;
  save: (name: string, content: string, mime?: string) => Promise<void>;
}) {
  const [format, setFormat] = useState("hex");
  const [follow, setFollow] = useState(true);
  const view = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (follow && view.current)
      view.current.scrollTop = view.current.scrollHeight;
  }, [entries, follow]);
  const decoders = { rx: new TextDecoder(), tx: new TextDecoder() };
  return (
    <section className="s-panel s-serial-monitor">
      <div className="s-section-title">
        <h3>
          <Terminal size={17} /> 串口数据{" "}
          <small>{connected ? "持续接收中" : "已断开 · 保留记录"}</small>
        </h3>
        <div className="s-serial-actions">
          <select
            aria-label="接收显示格式"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
          >
            <option value="hex">HEX</option>
            <option value="text">UTF-8 文本</option>
          </select>
          <button onClick={() => setFollow(!follow)}>
            {follow ? "停止跟随" : "跟随最新"}
          </button>
          <button
            disabled={!entries.length}
            onClick={() =>
              void save(
                "ebed-serial-log.txt",
                entries
                  .map(
                    (row) =>
                      `${row.at}\t${row.direction.toUpperCase()}\t${row.hex.match(/../g)?.join(" ")}`,
                  )
                  .join("\n"),
                "text/plain",
              )
            }
          >
            <Download size={14} />
            导出
          </button>
          <button onClick={clear}>
            <Trash2 size={14} />
            清空
          </button>
        </div>
      </div>
      <div className="s-serial-stats">
        RX {bytes.rx.toLocaleString()} B · TX {bytes.tx.toLocaleString()} B ·
        保留最近 200 段 · 已淘汰 {Math.max(0, bytes.evicted - 200)} 段 ·
        本次连接队列丢弃 {dropped} B
      </div>
      <div
        className="s-serial-stream"
        ref={view}
        role="log"
        aria-label="串口收发记录"
      >
        {entries.length ? (
          entries.map((row, index) => (
            <div className={`s-serial-row ${row.direction}`} key={index}>
              <time>
                {new Date(row.at).toLocaleTimeString("zh-CN", {
                  hour12: false,
                })}
                .{row.at.slice(20, 23)}
              </time>
              <b>{row.direction.toUpperCase()}</b>
              <code>
                {format === "hex"
                  ? row.hex.match(/../g)?.join(" ").toUpperCase()
                  : decoders[row.direction].decode(
                      Uint8Array.from(row.hex.match(/../g) || [], (h) =>
                        parseInt(h, 16),
                      ),
                      { stream: true },
                    )}
              </code>
            </div>
          ))
        ) : (
          <p className="s-muted">串口打开后自动接收。点击发送才会写入数据。</p>
        )}
      </div>
    </section>
  );
}
