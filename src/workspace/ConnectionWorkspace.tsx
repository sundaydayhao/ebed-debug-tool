import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Cable,
  Check,
  ChevronDown,
  Download,
  FolderOpen,
  LoaderCircle,
  Network,
  Play,
  Plus,
  Save,
  Search,
  Settings2,
  Square,
  Trash2,
  Unplug,
  Upload,
  X,
} from "lucide-react";
import type { DevicePort } from "../probe/types";
import type { NativeEvent } from "../types";
import { saveArtifact } from "../probe/files";
import { kindNames, serializeProfiles } from "./profiles";
import type { Config, ConnectionKind, QuickCommand } from "./profiles";
import { defaultDraft, emptySession, useConnections } from "./useConnections";
import "./workspace.css";
type Workspace = ReturnType<typeof useConnections>;
const phaseNames = {
  connecting: "连接中",
  open: "已连接",
  closed: "未连接",
  error: "连接错误",
};
function eventText(e: NativeEvent, decoder?: TextDecoder) {
  if (e.type !== "data")
    return e.type === "overflow"
      ? `队列已丢弃 ${e.droppedBytes} 字节`
      : e.message || "";
  return (decoder || new TextDecoder()).decode(
    Uint8Array.from(e.payload?.match(/../g) || [], (h) => parseInt(h, 16)),
    decoder ? { stream: true } : undefined,
  );
}
export function ConnectionWorkspace({
  work,
  ports,
}: {
  work: Workspace;
  ports: DevicePort[];
}) {
  const { selected: p, session: s } = work;
  const [showConfig, setShowConfig] = useState(true);
  const [format, setFormat] = useState<"hex" | "text">("hex");
  const [filter, setFilter] = useState("");
  const [direction, setDirection] = useState("all");
  const [follow, setFollow] = useState(true);
  const {
    payload,
    format: sendFormat,
    ending,
    name: commandName,
    repeat,
    intervalMs,
  } = work.drafts[p.id] || defaultDraft(p.kind);
  const setPayload = (payload: string) => work.setDraft(p.id, { payload });
  const setSendFormat = (format: QuickCommand["format"]) =>
    work.setDraft(p.id, { format });
  const setEnding = (ending: QuickCommand["ending"]) =>
    work.setDraft(p.id, { ending });
  const setCommandName = (name: string) => work.setDraft(p.id, { name });
  const setRepeat = (repeat: number) => work.setDraft(p.id, { repeat });
  const setIntervalMs = (intervalMs: number) =>
    work.setDraft(p.id, { intervalMs });
  const list = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const locked = s.phase === "open" || s.phase === "connecting";
  const plan = work.sending[p.id];
  useEffect(() => {
    setShowConfig(s.phase !== "open");
  }, [p.id, s.phase]);
  useEffect(() => {
    setFilter("");
    setDirection("all");
  }, [p.id]);
  useEffect(() => {
    if (p.kind === "serial" && !p.config.path && ports.length === 1 && !locked)
      work.update({ ...p, config: { ...p.config, path: ports[0].path } });
  }, [p.id, p.config.path, ports]);
  const decoded = useMemo(() => {
    const decoders = { rx: new TextDecoder(), tx: new TextDecoder() };
    return s.entries.map((e) => ({
      event: e,
      text: eventText(
        e,
        (p.kind === "serial" || p.kind === "tcp") &&
          (e.direction === "rx" || e.direction === "tx")
          ? decoders[e.direction]
          : undefined,
      ),
    }));
  }, [s.entries, p.kind]);
  const rows = decoded.filter(
    ({ event: e, text }) =>
      (direction === "all" ||
        (direction === "sys"
          ? e.type !== "data"
          : e.direction === direction)) &&
      `${text} ${e.payload || ""} ${e.payload?.match(/../g)?.join(" ") || ""} ${e.meta || ""}`
        .toLowerCase()
        .includes(filter.toLowerCase()),
  );
  useEffect(() => {
    if (follow && list.current)
      list.current.scrollTop = list.current.scrollHeight;
  }, [s.entries, follow, filter, direction]);
  const updateConfig = (key: string, value: Config[string]) =>
    work.update({ ...p, config: { ...p.config, [key]: value } });
  const draft = (): QuickCommand => ({
    id: crypto.randomUUID(),
    name: commandName || "当前命令",
    payload,
    format: sendFormat,
    ending,
  });
  const load = (c: QuickCommand) => {
    setPayload(c.payload);
    setSendFormat(c.format);
    setEnding(c.ending);
    setCommandName(c.name);
  };
  async function save(name: string, data: string, mime: string) {
    try {
      const result = await saveArtifact(name, data, mime);
      if (result.ok) work.setMessage(`已导出 ${name}`);
    } catch (error) {
      work.setMessage(String(error));
    }
  }
  const exportLog = (csv: boolean) => {
    const contents = csv
      ? [
          ["UTC", "方向", "HEX / 状态", "端点 / Topic", "原始字节数", "截断"],
          ...rows.map(({ event: e }) => [
            e.at,
            e.direction || "sys",
            e.payload || e.message || "",
            e.meta || "",
            String(e.bytes || 0),
            e.truncated ? "true" : "false",
          ]),
        ]
          .map((row) =>
            row
              .map(
                (cell) =>
                  `"${(/^[=+\-@\t\r]/.test(cell) ? "'" : "") + cell.replace(/"/g, '""')}"`,
              )
              .join(","),
          )
          .join("\r\n")
      : JSON.stringify(
          {
            version: 1,
            source: "device",
            exportedAt: new Date().toISOString(),
            connection: { name: p.name, kind: p.kind, config: p.config },
            retainedOnly: true,
            filtered: Boolean(filter || direction !== "all"),
            entries: rows.map((row) => row.event),
          },
          null,
          2,
        );
    void save(
      `ebed-${p.kind}-log.${csv ? "csv" : "json"}`,
      contents,
      csv ? "text/csv" : "application/json",
    );
  };
  return (
    <>
      <div className="s-page-heading">
        <div>
          <span className="s-eyebrow">CONNECT. SEND. REPRODUCE.</span>
          <h1>连接工作区</h1>
          <p>保存常用接口，串口与网络同时在线；切换页面后继续收发。</p>
        </div>
        <span className="s-offline-tag">
          <Check size={16} />
          {work.storageSaved ? "参数自动保存在本机" : "配置未保存 · 请导出备份"}
        </span>
      </div>
      {work.message && (
        <div className="c-notice" role="status">
          <span>{work.message}</span>
          <button
            aria-label="关闭工作区提示"
            onClick={() => work.setMessage("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      <div className="c-layout">
        <aside className="s-panel c-profiles">
          <div className="s-section-title">
            <h3>我的连接</h3>
            <span>{work.connectedCount} 在线</span>
          </div>
          <div className="c-new">
            {(["serial", "tcp", "udp", "mqtt"] as ConnectionKind[]).map(
              (kind) => (
                <button
                  key={kind}
                  title={`新建 ${kindNames[kind]} 连接`}
                  onClick={() => work.add(kind)}
                >
                  <Plus size={12} />
                  {kindNames[kind]}
                </button>
              ),
            )}
          </div>
          <div className="c-profile-list">
            {work.profiles.map((profile) => {
              const state = work.sessions[profile.id] || emptySession();
              return (
                <button
                  className={p.id === profile.id ? "selected" : ""}
                  key={profile.id}
                  onClick={() => work.setSelectedId(profile.id)}
                >
                  <div>
                    <b>{profile.name}</b>
                    <i
                      className={`s-dot ${state.phase === "open" ? "live" : ""}`}
                    />
                  </div>
                  <small>
                    {kindNames[profile.kind]} · {phaseNames[state.phase]}
                  </small>
                  <span>{work.summary(profile)}</span>
                </button>
              );
            })}
          </div>
          <div className="c-profile-actions">
            <button onClick={() => file.current?.click()}>
              <Upload size={14} />
              导入配置
            </button>
            <button
              onClick={() =>
                void save(
                  "ebed-connections.json",
                  serializeProfiles(work.profiles),
                  "application/json",
                )
              }
            >
              <Download size={14} />
              导出配置
            </button>
          </div>
          <p className="s-muted s-small">
            重启后恢复参数，点击连接才访问目标。MQTT 密码仅保留在本次运行中。
          </p>
        </aside>
        <div className="c-main">
          <section className="s-panel c-connection">
            <div className="c-connection-header">
              <div className="c-kind-icon">
                {p.kind === "serial" ? (
                  <Cable size={24} />
                ) : (
                  <Network size={24} />
                )}
              </div>
              <div className="c-connection-title">
                <input
                  aria-label="连接名称"
                  value={p.name}
                  maxLength={80}
                  onChange={(e) => work.update({ ...p, name: e.target.value })}
                />
                <span className={`c-state ${s.phase}`}>
                  {phaseNames[s.phase]} · {s.localAddress || work.summary(p)}
                </span>
              </div>
              <button
                aria-label="显示连接参数"
                onClick={() => setShowConfig(!showConfig)}
              >
                <Settings2 size={16} />
                参数
                <ChevronDown size={14} />
              </button>
              {locked ? (
                <button onClick={() => void work.disconnect(p.id)}>
                  <Unplug size={16} />
                  {s.phase === "connecting" ? "取消连接" : "断开"}
                </button>
              ) : (
                <button
                  className="s-primary c-connect"
                  onClick={() => void work.connect(p.id)}
                >
                  <Play size={16} />
                  连接
                </button>
              )}
              <button
                aria-label="删除连接配置"
                disabled={locked || work.profiles.length === 1}
                onClick={() => void work.remove(p.id)}
              >
                <Trash2 size={16} />
              </button>
            </div>
            {showConfig && (
              <div className="c-config">
                {p.kind === "serial" && (
                  <>
                    <label>
                      串口
                      <select
                        aria-label="工作区串口"
                        disabled={locked}
                        value={String(p.config.path)}
                        onChange={(e) => updateConfig("path", e.target.value)}
                      >
                        <option value="">请选择串口</option>
                        {p.config.path &&
                          !ports.some(
                            (port) => port.path === p.config.path,
                          ) && (
                            <option value={String(p.config.path)}>
                              {p.config.path}（未发现）
                            </option>
                          )}
                        {ports.map((port) => (
                          <option key={port.path} value={port.path}>
                            {port.path} · {port.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Field
                      label="波特率"
                      field="baudRate"
                      config={p.config}
                      set={updateConfig}
                      locked={locked}
                      number
                    />
                    <Select
                      label="数据位"
                      field="dataBits"
                      config={p.config}
                      set={updateConfig}
                      locked={locked}
                      options={[5, 6, 7, 8]}
                    />
                    <Select
                      label="校验"
                      field="parity"
                      config={p.config}
                      set={updateConfig}
                      locked={locked}
                      options={["none", "even", "odd"]}
                    />
                    <Select
                      label="停止位"
                      field="stopBits"
                      config={p.config}
                      set={updateConfig}
                      locked={locked}
                      options={[1, 2]}
                    />
                    <label>
                      流控
                      <select
                        disabled={locked}
                        value={String(p.config.rtscts)}
                        onChange={(e) =>
                          updateConfig("rtscts", e.target.value === "true")
                        }
                      >
                        <option value="false">无</option>
                        <option value="true">RTS / CTS</option>
                      </select>
                    </label>
                  </>
                )}
                {p.kind === "tcp" && (
                  <>
                    <Field
                      label="目标主机"
                      field="host"
                      config={p.config}
                      set={updateConfig}
                      locked={locked}
                    />
                    <Field
                      label="目标端口"
                      field="port"
                      config={p.config}
                      set={updateConfig}
                      locked={locked}
                      number
                    />
                  </>
                )}
                {p.kind === "udp" && (
                  <>
                    <Field
                      label="监听地址"
                      field="bindHost"
                      config={p.config}
                      set={updateConfig}
                      locked={locked}
                    />
                    <Field
                      label="监听端口（0 自动分配）"
                      field="localPort"
                      config={p.config}
                      set={updateConfig}
                      locked={locked}
                      number
                    />
                    <Field
                      label="目标主机"
                      field="remoteHost"
                      config={p.config}
                      set={updateConfig}
                      locked={locked}
                    />
                    <Field
                      label="目标端口"
                      field="remotePort"
                      config={p.config}
                      set={updateConfig}
                      locked={locked}
                      number
                    />
                  </>
                )}
                {p.kind === "mqtt" && (
                  <>
                    <Field
                      label="Broker URL"
                      field="url"
                      config={p.config}
                      set={updateConfig}
                      locked={locked}
                    />
                    <Field
                      label="Client ID（空则生成）"
                      field="clientId"
                      config={p.config}
                      set={updateConfig}
                      locked={locked}
                    />
                    <Field
                      label="用户名"
                      field="username"
                      config={p.config}
                      set={updateConfig}
                      locked={locked}
                    />
                    <label>
                      密码（仅本次运行）
                      <input
                        type="password"
                        autoComplete="off"
                        disabled={locked}
                        value={work.passwords[p.id] || ""}
                        onChange={(e) =>
                          work.setPasswords((old) => ({
                            ...old,
                            [p.id]: e.target.value,
                          }))
                        }
                      />
                    </label>
                    <Field
                      label="订阅 Topic（可留空）"
                      field="subscribeTopic"
                      config={p.config}
                      set={updateConfig}
                      locked={locked}
                    />
                    <Field
                      label="发布 Topic"
                      field="publishTopic"
                      config={p.config}
                      set={updateConfig}
                      locked={locked}
                    />
                    <Select
                      label="QoS"
                      field="qos"
                      config={p.config}
                      set={updateConfig}
                      locked={locked}
                      options={[0, 1, 2]}
                    />
                  </>
                )}
                <Field
                  label="连接 / 发送超时 ms"
                  field="timeoutMs"
                  config={p.config}
                  set={updateConfig}
                  locked={locked}
                  number
                />
              </div>
            )}
            <p
              className={`c-status-message ${s.phase === "error" ? "error" : ""}`}
            >
              {s.phase === "connecting" && (
                <LoaderCircle size={14} className="s-spin" />
              )}
              {s.message}
              {p.kind === "serial" &&
                " · 按目标确认 TTL / RS232 / RS485 接口类型与电平。"}
            </p>
          </section>
          <section className="s-panel c-terminal">
            <div className="c-log-toolbar">
              <div>
                <h3>收发记录</h3>
                <small>
                  RX {s.rxBytes.toLocaleString()} B · TX{" "}
                  {s.txBytes.toLocaleString()} B
                </small>
              </div>
              <label className="c-search">
                <Search size={14} />
                <input
                  aria-label="搜索收发记录"
                  placeholder="文本、HEX、Topic…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </label>
              <select
                aria-label="日志方向"
                value={direction}
                onChange={(e) => setDirection(e.target.value)}
              >
                <option value="all">全部</option>
                <option value="rx">接收 RX</option>
                <option value="tx">发送 TX</option>
                <option value="sys">状态</option>
              </select>
              <select
                aria-label="工作区显示格式"
                value={format}
                onChange={(e) => setFormat(e.target.value as "text" | "hex")}
              >
                <option value="hex">HEX</option>
                <option value="text">UTF-8</option>
              </select>
            </div>
            <div
              className="c-log"
              ref={list}
              role="log"
              aria-label="工作区收发记录"
            >
              {rows.length ? (
                rows.map(({ event: e, text }, index) => (
                  <div
                    className={`c-log-row ${e.direction || "sys"}`}
                    key={index}
                  >
                    <time>
                      {new Date(e.at).toLocaleTimeString("zh-CN", {
                        hour12: false,
                      })}
                      .{e.at.slice(20, 23)}
                    </time>
                    <b>{e.direction?.toUpperCase() || "SYS"}</b>
                    <div>
                      {e.meta && <small>{e.meta}</small>}
                      <code>
                        {e.type === "data" && format === "hex"
                          ? e.payload?.match(/../g)?.join(" ").toUpperCase()
                          : text}
                      </code>
                      {e.truncated && (
                        <em>原始 {e.bytes} 字节，仅显示前 64 KB</em>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <div className="c-log-empty">
                  <ArrowDownToLine size={24} />
                  <strong>
                    {filter || direction !== "all"
                      ? "没有匹配记录"
                      : "等待收发数据"}
                  </strong>
                  <span>连接成功后自动接收，点击发送才会写入数据。</span>
                </div>
              )}
            </div>
            <div className="c-log-foot">
              <span>
                最近 500 条 · 淘汰 {s.evicted} 条 · 队列丢弃 {s.dropped} B
              </span>
              <div>
                <button onClick={() => setFollow(!follow)}>
                  {follow ? "停止跟随" : "跟随最新"}
                </button>
                <button
                  disabled={!rows.length}
                  onClick={() => exportLog(false)}
                >
                  JSON
                </button>
                <button disabled={!rows.length} onClick={() => exportLog(true)}>
                  CSV
                </button>
                <button onClick={() => work.clear(p.id)}>清空记录</button>
              </div>
            </div>
          </section>
          <section className="s-panel c-sender">
            <div className="s-section-title">
              <h3>发送数据</h3>
              <span>
                {p.kind === "mqtt"
                  ? `→ ${p.config.publishTopic} · QoS ${p.config.qos} · retain 关闭`
                  : "原始字节发送"}
              </span>
            </div>
            <div className="c-send-options">
              <label>
                格式
                <select
                  aria-label="工作区发送格式"
                  value={sendFormat}
                  disabled={Boolean(plan)}
                  onChange={(e) =>
                    setSendFormat(e.target.value as QuickCommand["format"])
                  }
                >
                  <option value="text">UTF-8 文本</option>
                  <option value="hex">HEX</option>
                  <option value="json">JSON</option>
                </select>
              </label>
              <label>
                追加行尾
                <select
                  value={ending}
                  disabled={sendFormat === "hex" || Boolean(plan)}
                  onChange={(e) =>
                    setEnding(e.target.value as QuickCommand["ending"])
                  }
                >
                  <option value="">无</option>
                  <option value={"\n"}>LF</option>
                  <option value={"\r\n"}>CRLF</option>
                </select>
              </label>
              <label>
                次数
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={repeat}
                  disabled={Boolean(plan)}
                  onChange={(e) => setRepeat(+e.target.value)}
                />
              </label>
              <label>
                间隔 ms
                <input
                  type="number"
                  min={100}
                  max={60000}
                  value={intervalMs}
                  disabled={Boolean(plan)}
                  onChange={(e) => setIntervalMs(+e.target.value)}
                />
              </label>
            </div>
            <textarea
              aria-label="工作区发送内容"
              value={payload}
              disabled={Boolean(plan)}
              onChange={(e) => setPayload(e.target.value)}
              placeholder="输入命令或 HEX 字节"
              spellCheck={false}
            />
            <div className="c-send-actions">
              <input
                aria-label="快捷命令名称"
                placeholder="快捷命令名称"
                value={commandName}
                maxLength={80}
                onChange={(e) => setCommandName(e.target.value)}
              />
              <button
                disabled={!commandName.trim() || p.commands.length >= 20}
                onClick={() => {
                  work.update({ ...p, commands: [...p.commands, draft()] });
                  setCommandName("");
                }}
              >
                <Save size={15} />
                保存命令
              </button>
              {plan ? (
                <button onClick={() => work.stop(p.id)}>
                  <Square size={15} />
                  停止 · {plan.sent}/{plan.total}
                </button>
              ) : (
                <button
                  className="s-primary c-send"
                  disabled={s.phase !== "open"}
                  onClick={() => {
                    if (
                      !Number.isInteger(repeat) ||
                      repeat < 1 ||
                      repeat > 1000
                    )
                      work.setMessage("发送次数应为 1–1000");
                    else
                      void work.sendPlan(
                        p.id,
                        Array.from({ length: repeat }, draft),
                        intervalMs,
                      );
                  }}
                >
                  <Play size={16} />
                  {repeat > 1 ? `发送 ${repeat} 次` : "发送"}
                </button>
              )}
            </div>
            <p className="s-muted s-small" style={{ marginTop: 12 }}>
              间隔从上次发送完成起计时；停止会取消后续命令，已提交的字节无法撤回。
            </p>
            {p.commands.length > 0 && (
              <div className="c-commands">
                <span>快捷命令 · 点击加载</span>
                {p.commands.map((c) => (
                  <div key={c.id}>
                    <button disabled={Boolean(plan)} onClick={() => load(c)}>
                      {c.name}
                    </button>
                    <button
                      aria-label={`删除命令 ${c.name}`}
                      onClick={() =>
                        work.update({
                          ...p,
                          commands: p.commands.filter(
                            (item) => item.id !== c.id,
                          ),
                        })
                      }
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
                <button
                  disabled={s.phase !== "open" || Boolean(plan)}
                  onClick={() =>
                    void work.sendPlan(p.id, p.commands, intervalMs)
                  }
                >
                  <Play size={13} />
                  依次发送全部
                </button>
              </div>
            )}
          </section>
        </div>
      </div>
      <input
        type="file"
        accept=".json"
        hidden
        ref={file}
        onChange={async (e) => {
          const chosen = e.target.files?.[0];
          e.target.value = "";
          if (!chosen) return;
          if (chosen.size > 2097152) {
            work.setMessage("配置文件不能超过 2 MB");
            return;
          }
          try {
            work.importProfiles(await chosen.text());
          } catch (error) {
            work.setMessage(String(error));
          }
        }}
      />
    </>
  );
}
function Field({
  label,
  field,
  config,
  set,
  locked,
  number = false,
}: {
  label: string;
  field: string;
  config: Config;
  set: (key: string, value: Config[string]) => void;
  locked: boolean;
  number?: boolean;
}) {
  return (
    <label>
      {label}
      <input
        aria-label={label}
        type={number ? "number" : "text"}
        value={String(config[field])}
        disabled={locked}
        onChange={(e) => set(field, number ? +e.target.value : e.target.value)}
      />
    </label>
  );
}
function Select({
  label,
  field,
  config,
  set,
  locked,
  options,
}: {
  label: string;
  field: string;
  config: Config;
  set: (key: string, value: Config[string]) => void;
  locked: boolean;
  options: (string | number)[];
}) {
  return (
    <label>
      {label}
      <select
        value={String(config[field])}
        disabled={locked}
        onChange={(e) =>
          set(
            field,
            typeof options[0] === "number" ? +e.target.value : e.target.value,
          )
        }
      >
        {options.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
    </label>
  );
}
