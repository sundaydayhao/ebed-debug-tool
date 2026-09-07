import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Bluetooth,
  Cable,
  Check,
  ChevronRight,
  CircuitBoard,
  Cpu,
  Download,
  FileClock,
  FolderOpen,
  LayoutDashboard,
  LoaderCircle,
  Network,
  Play,
  PlugZap,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  Terminal,
  Unplug,
  Usb,
  Waves,
  Wifi,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { useProbe } from "./probe/useProbe";
import {
  exportPcapng,
  hex,
  strictHex,
  toBytes,
  validateSession,
} from "./probe/analysis";
import { saveArtifact } from "./probe/files";
import { LogicView } from "./probe/LogicView";
import { SerialMonitor } from "./probe/SerialMonitor";
import { ConnectionWorkspace } from "./workspace/ConnectionWorkspace";
import { useConnections } from "./workspace/useConnections";
import { buildModbusFrame, decodeModbusFrame } from "./lib/protocols";
import type {
  Feature,
  PacketRow,
  SessionData,
  SerialConfig,
} from "./probe/types";
const LegacyWorkbench = lazy(() => import("./LegacyWorkbench"));
type Page =
  | "home"
  | "connections"
  | "wireless"
  | "logic"
  | "debug"
  | "tools"
  | "hardware";
const nav = [
  { id: "home" as const, title: "工作台", icon: LayoutDashboard },
  { id: "connections" as const, title: "连接工作区", icon: Cable },
  { id: "debug" as const, title: "总线调试", icon: Terminal },
  { id: "tools" as const, title: "协议工具箱", icon: Wrench },
  { id: "wireless" as const, title: "无线抓包", icon: Radio },
  { id: "logic" as const, title: "逻辑分析", icon: Waves },
  { id: "hardware" as const, title: "设备与接线", icon: CircuitBoard },
];
const featureLabels: Record<Feature, string> = {
  wifi: "Wi-Fi 2.4G",
  ble: "BLE 广播",
  logic: "逻辑采样",
  uart: "UART",
  spi: "SPI",
  i2c: "I²C",
  modbus: "Modbus",
};
const cards = [
  {
    page: "debug" as const,
    icon: Terminal,
    title: "调试，从接线到响应",
    label: "BUS DEBUG",
    text: "已有串口直接收发 UART、调试 Modbus，常用预设就地执行。",
    chips: ["UART", "SPI", "I²C", "Modbus"],
    cls: "amber",
  },
  {
    page: "tools" as const,
    icon: Network,
    title: "工具，为日常开发准备",
    label: "TOOLBOX",
    text: "串口、网络、协议、图表、脚本和日志，继续协同工作。",
    chips: ["TCP / UDP", "MQTT", "CAN 解析"],
    cls: "violet",
  },
  {
    page: "wireless" as const,
    icon: Wifi,
    title: "无线，从空口看见",
    label: "WIRELESS",
    text: "选配 Wi-Fi 抓包器获取空口数据，也可分析已保存的采集会话。",
    chips: ["802.11 b/g/n", "BLE ADV", "PCAPNG"],
    cls: "mint",
  },
  {
    page: "logic" as const,
    icon: Waves,
    title: "时序，每个边沿都清晰",
    label: "LOGIC ANALYZER",
    text: "多通道波形、边沿触发与协议解码，在同一处分析。",
    chips: ["UART / SPI / I²C", "VCD"],
    cls: "blue",
  },
];
export default function App() {
  const probe = useProbe();
  const work = useConnections();
  const [page, setPage] = useState<Page>("home"),
    [deviceDialog, setDeviceDialog] = useState(false),
    [port, setPort] = useState("");
  const [connectionKind, setConnectionKind] = useState<"serial" | "probe">(
    "serial",
  );
  const [serialConfig, setSerialConfig] = useState<SerialConfig>({
    baudRate: 115200,
    dataBits: 8,
    parity: "none",
    stopBits: 1,
    rtscts: false,
  });
  const [inputFormat, setInputFormat] = useState("hex");
  const [uartText, setUartText] = useState("AT");
  const [lineEnding, setLineEnding] = useState("\r\n");
  const [wireless, setWireless] = useState<"wifi" | "ble">("wifi"),
    [channel, setChannel] = useState(6),
    [filter, setFilter] = useState(""),
    [selected, setSelected] = useState<number | null>(null);
  const [debug, setDebug] = useState<"uart" | "spi" | "i2c" | "modbus">("uart"),
    [payload, setPayload] = useState("41 54 0D 0A"),
    [baud, setBaud] = useState(115200),
    [busAddress, setBusAddress] = useState(80),
    [frequency, setFrequency] = useState(100000),
    [spiMode, setSpiMode] = useState(0),
    [readLength, setReadLength] = useState(32);
  const [unit, setUnit] = useState(1),
    [register, setRegister] = useState(0),
    [quantity, setQuantity] = useState(2);
  const [debugResult, setDebugResult] = useState<{
    tx: string;
    rx: string;
    text: string;
    demo: boolean;
    protocol: string;
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { status, busy, mode } = probe,
    caps = status.capabilities;
  const rawSerial = mode === "device" && status.kind === "serial";
  const rawUart = rawSerial && debug === "uart";
  const serialLabel = status.serialConfig
    ? `${status.serialConfig.baudRate} · ${status.serialConfig.dataBits}${{ none: "N", even: "E", odd: "O" }[status.serialConfig.parity]}${status.serialConfig.stopBits}`
    : "";
  const available = (feature: Feature) =>
    status.connected && !!caps?.features.includes(feature);
  const activeChannel = caps?.wifiChannels.includes(channel)
    ? channel
    : caps?.wifiChannels[0] || channel;
  const filtered = probe.packets.filter(
    (p) =>
      p.protocol === wireless &&
      `${p.summary} ${p.source} ${p.destination} ${p.channel}`
        .toLowerCase()
        .includes(filter.toLowerCase()),
  );
  const selectedPacket =
    filtered.find((p) => p.id === selected) || filtered.at(-1);
  const wireCount = probe.packets.filter((p) => p.protocol === wireless).length;
  const modeLabel =
    mode === "demo"
      ? "演示工作区"
      : mode === "replay"
        ? `离线回放 · ${probe.source === "demo" ? "演示数据" : "设备数据"}`
        : "本地工作区";
  useEffect(() => {
    if (!port && probe.ports.length === 1) setPort(probe.ports[0].path);
    else if (port && !probe.ports.some((p) => p.path === port)) setPort("");
  }, [probe.ports, port]);
  useEffect(() => {
    setDebugResult(null);
  }, [status.connected, status.path, mode]);
  useEffect(() => {
    if (mode === "device" && status.connected) {
      setConnectionKind(status.kind);
      setPort(status.path);
      if (status.serialConfig) setSerialConfig(status.serialConfig);
    }
  }, [status.connected, status.path, mode]);
  async function save(
    name: string,
    content: string | Uint8Array,
    mime?: string,
  ) {
    try {
      const result = await saveArtifact(name, content, mime);
      if (result.ok) probe.log(`已导出 ${name}`);
    } catch (e) {
      probe.setMessage(`保存失败：${String(e)}`);
    }
  }
  function saveSession() {
    const session: SessionData = {
      version: 1,
      createdAt: new Date().toISOString(),
      source: probe.source,
      capabilities: caps,
      packets: probe.packets,
      logic: probe.logic,
    };
    void save(
      `ebed-${probe.source}-session.ebed.json`,
      JSON.stringify(session),
    );
  }
  async function loadSession(file?: File) {
    if (!file) return;
    try {
      if (file.size > 32 * 1024 * 1024)
        throw new Error("会话文件不能超过 32 MB");
      await probe.load(validateSession(JSON.parse(await file.text())));
      setPage("wireless");
    } catch (e) {
      probe.setMessage(
        `无法载入会话：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  function selectDebug(value: typeof debug) {
    setDebug(value);
    setDebugResult(null);
    if (value === "i2c") setFrequency(100000);
    const defaults = {
      uart: ["41 54 0D 0A", 32],
      spi: ["9F 00 00 00", 4],
      i2c: ["00", 1],
      modbus: ["", 9],
    } as const;
    setPayload(defaults[value][0]);
    setReadLength(defaults[value][1]);
  }
  async function runDebug() {
    try {
      if (
        debug === "modbus" &&
        (!Number.isInteger(unit) ||
          unit < 1 ||
          unit > 247 ||
          !Number.isInteger(register) ||
          register < 0 ||
          register > 65535 ||
          !Number.isInteger(quantity) ||
          quantity < 1 ||
          quantity > 125 ||
          register + quantity > 65536)
      )
        throw new Error("请检查从站地址（1–247）、寄存器地址和数量（1–125）");
      const tx =
        debug === "modbus"
          ? strictHex(
              buildModbusFrame({
                variant: "rtu",
                unitId: unit,
                functionCode: 3,
                address: register,
                quantity,
                value: 0,
                transactionId: 1,
              }),
            )
          : rawUart && inputFormat === "text"
            ? strictHex(hex(new TextEncoder().encode(uartText + lineEnding)))
            : strictHex(payload);
      if (!Number.isInteger(readLength) || readLength < 0 || readLength > 1024)
        throw new Error("接收长度应为 0–1024 的整数");
      if (debug === "spi" && readLength !== tx.length / 2)
        throw new Error("SPI 接收长度应等于发送字节数；请补齐时钟用的 00 字节");
      if (
        debug === "i2c" &&
        (!Number.isInteger(busAddress) || busAddress < 8 || busAddress > 119)
      )
        throw new Error("I²C 7-bit 地址应为 8–119");
      setDebugResult(null);
      const result = await probe.command(
        rawUart ? "uart.send" : `${debug}.transfer`,
        {
          hex: tx,
          baudRate: rawSerial ? status.serialConfig?.baudRate : baud,
          address: busAddress,
          frequency,
          mode: spiMode,
          readLength: debug === "modbus" ? 5 + quantity * 2 : readLength,
          timeoutMs: 1000,
        },
      );
      if (result)
        setDebugResult({
          tx,
          rx: typeof result.hex === "string" ? result.hex : "",
          text: String(result.message || "设备已完成收发"),
          demo: mode === "demo",
          protocol: debug,
        });
    } catch (e) {
      probe.setMessage(e instanceof Error ? e.message : String(e));
    }
  }
  const startWireless = () =>
    void probe.command(
      status.active === wireless ? "capture.stop" : `${wireless}.start`,
      { channel: activeChannel },
    );
  return (
    <div className="studio">
      <aside className="s-sidebar">
        <button className="s-brand" onClick={() => setPage("home")}>
          <span className="s-logo">
            <Activity size={25} />
          </span>
          <span>
            EBED<span className="s-brand-light"> STUDIO</span>
            <small>嵌入式无线工作台</small>
          </span>
        </button>
        <div className="s-workspace-label">
          <span className="s-workspace-icon">
            <Cpu size={15} />
          </span>
          默认工作空间<span className="s-local-badge">LOCAL</span>
        </div>
        <div className="s-nav-caption">工作空间</div>
        <nav className="s-nav">
          {nav
            .filter((n) => n.id !== "hardware")
            .map(({ id, title, icon: Icon }) => (
              <button
                key={id}
                className={page === id ? "selected" : ""}
                onClick={() => setPage(id)}
              >
                <Icon size={18} />
                {title}
                {id === "connections" && work.connectedCount > 0 && (
                  <i className="s-dot live" />
                )}
                {id === "wireless" &&
                  status.active &&
                  ["wifi", "ble"].includes(status.active) && (
                    <i className="s-dot live" />
                  )}
              </button>
            ))}
        </nav>
        <div className="s-nav-caption s-nav-second">设备管理</div>
        <nav className="s-nav">
          <button
            className={page === "hardware" ? "selected" : ""}
            onClick={() => setPage("hardware")}
          >
            <CircuitBoard size={18} />
            设备与接线
          </button>
          <button onClick={() => fileInput.current?.click()}>
            <FileClock size={18} />
            打开采集会话
          </button>
        </nav>
        <div className="s-sidebar-bottom">
          <div className="s-device-mini">
            <div>
              <Usb size={19} />
              <strong>
                {status.connected
                  ? rawSerial
                    ? "串口已就绪"
                    : "Probe 已就绪"
                  : work.connectedCount
                    ? `${work.connectedCount} 个接口在线`
                    : "等待连接串口"}
                <small>
                  {status.connected
                    ? caps?.serial
                    : work.connectedCount
                      ? "串口 / 网络连接工作区"
                      : `已发现 ${probe.ports.length} 个串口`}
                </small>
              </strong>
              <i
                className={`s-dot ${status.connected || work.connectedCount ? "live" : ""}`}
              />
            </div>
            <button
              onClick={() =>
                status.connected
                  ? setDeviceDialog(true)
                  : setPage("connections")
              }
            >
              {status.connected || work.connectedCount
                ? "管理连接"
                : "连接串口"}
              <ArrowRight size={14} />
            </button>
          </div>
          <div className="s-version">
            <span>EBED Studio</span>
            <span>v0.3.0</span>
          </div>
        </div>
      </aside>
      <div className="s-main">
        <header className="s-topbar">
          <div className="s-breadcrumb">
            工作空间
            <ChevronRight size={14} />
            <strong>{nav.find((n) => n.id === page)?.title}</strong>
          </div>
          <div className="s-topbar-right">
            <span
              className={`s-mode ${mode !== "device" && page !== "connections" && page !== "tools" ? "demo" : ""}`}
            >
              <i className="s-dot" />
              {page === "connections"
                ? "真实连接工作区"
                : page === "tools"
                  ? "协议工具箱"
                  : modeLabel}
            </span>
            <button onClick={() => fileInput.current?.click()}>
              <FolderOpen size={15} />
              打开会话
            </button>
            <button
              disabled={!probe.packets.length && !probe.logic}
              onClick={saveSession}
            >
              <ArrowDownToLine size={15} />
              保存会话
            </button>
          </div>
        </header>
        {mode !== "device" && page !== "connections" && page !== "tools" && (
          <div className="s-mode-banner">
            <span>
              <ShieldCheck size={15} />
              {mode === "demo"
                ? "采集演示模式 · 采集数据为模拟；连接工作区的真实串口与网络独立运行。"
                : `离线回放 · ${probe.source === "demo" ? "这是一份演示数据会话。" : "查看已保存的设备数据。"}设备操作已停用。`}
            </span>
            <button onClick={probe.leaveDemo}>
              返回设备模式
              <ArrowRight size={14} />
            </button>
          </div>
        )}
        {probe.message && (
          <div className="s-notice" role="status">
            <span>{probe.message}</span>
            <button aria-label="关闭提示" onClick={() => probe.setMessage("")}>
              <X size={15} />
            </button>
          </div>
        )}
        <main
          className={`s-content ${page === "tools" ? "s-tools-content" : ""}`}
        >
          {page === "connections" && (
            <ConnectionWorkspace work={work} ports={probe.ports} />
          )}
          {page === "home" && (
            <>
              <div className="s-page-heading">
                <div>
                  <span className="s-eyebrow">YOUR EMBEDDED WORKBENCH</span>
                  <h1>从信号，到答案。</h1>
                  <p>串口、网络、协议与数据分析，在一个工作空间里完成。</p>
                </div>
                <span className="s-offline-tag">
                  <ShieldCheck size={16} />
                  本地运行 · 无需账号
                </span>
              </div>
              <section className="s-hero">
                <div className="s-hero-copy">
                  <span className="s-pill">
                    <i className={`s-dot ${status.connected ? "live" : ""}`} />
                    {status.connected
                      ? "DEVICE READY"
                      : "YOUR TOOLS. READY TO WORK."}
                  </span>
                  <h2>
                    {status.connected
                      ? "设备已就绪。\n开始一次新的探索。"
                      : "打开工作台，\n开始今天的调试。"}
                  </h2>
                  <p>
                    {status.connected
                      ? rawSerial
                        ? `${status.path} · ${serialLabel} 已连接。UART 实时收发与 Modbus 调试已就绪。`
                        : `${caps?.model} 已连接。选择下方工具开始采集或总线调试。`
                      : "使用已有串口、网络连接和本地文件。\n收发、分析、记录，都在这里完成。"}
                  </p>
                  <div className="s-hero-actions">
                    <button
                      className="s-primary"
                      onClick={() => setPage("connections")}
                    >
                      <Usb size={17} />
                      打开连接工作区
                      <ArrowRight size={16} />
                    </button>
                    <button
                      className="s-text-button"
                      onClick={() => setPage("tools")}
                    >
                      打开协议工具箱
                      <ChevronRight size={15} />
                    </button>
                  </div>
                  <div className="s-hero-foot">
                    <Check size={14} />
                    内置协议工具
                    <Check size={14} />
                    离线使用
                    <Check size={14} />
                    本地文件分析
                  </div>
                  <button
                    className="s-demo-link"
                    disabled={busy}
                    onClick={() => void probe.demo()}
                  >
                    体验演示工作区 <ArrowRight size={13} />
                  </button>
                </div>
                <div
                  className="s-workspace-launchpad"
                  aria-label="工作台快捷入口"
                >
                  <span className="s-eyebrow">EVERYDAY WORKFLOW</span>
                  <button onClick={() => setPage("debug")}>
                    <Terminal size={22} />
                    <span>
                      <strong>串口与总线</strong>
                      <small>UART / Modbus · 使用已有接口</small>
                    </span>
                    <ChevronRight size={17} />
                  </button>
                  <button onClick={() => setPage("connections")}>
                    <Network size={22} />
                    <span>
                      <strong>串口与网络连接</strong>
                      <small>TCP / UDP / MQTT · 保存配置与命令</small>
                    </span>
                    <ChevronRight size={17} />
                  </button>
                  <button onClick={() => fileInput.current?.click()}>
                    <FolderOpen size={22} />
                    <span>
                      <strong>采集会话分析</strong>
                      <small>打开本地文件 · 无需连接设备</small>
                    </span>
                    <ChevronRight size={17} />
                  </button>
                  <button
                    className="s-accessory-link"
                    onClick={() => setPage("hardware")}
                  >
                    <Wifi size={18} />
                    <span>
                      <strong>
                        Wi-Fi 抓包配件 <em>选配 · 设计中</em>
                      </strong>
                      <small>需要空口数据时，扩展采集能力</small>
                    </span>
                    <ArrowRight size={16} />
                  </button>
                </div>
              </section>
              <section className="s-metrics">
                <Metric
                  icon={Usb}
                  label="当前设备"
                  value={String(
                    (status.connected ? 1 : 0) + work.connectedCount,
                  )}
                  detail={
                    status.connected
                      ? caps?.serial || ""
                      : `发现 ${probe.ports.length} 个串口 · 选择后直接连接`
                  }
                />
                <Metric
                  icon={ArrowDownToLine}
                  label="接口接收"
                  value={`${(probe.serialBytes.rx + Object.values(work.sessions).reduce((n, s) => n + s.rxBytes, 0)).toLocaleString()} B`}
                  detail="连接工作区 + 总线调试"
                />
                <Metric
                  icon={Terminal}
                  label="接口发送"
                  value={`${(probe.serialBytes.tx + Object.values(work.sessions).reduce((n, s) => n + s.txBytes, 0)).toLocaleString()} B`}
                  detail="连接工作区 + 总线调试"
                />
                <Metric
                  icon={Activity}
                  label="采集状态"
                  value={status.active ? "采集中" : "空闲"}
                  detail={
                    status.active
                      ? featureLabels[status.active]
                      : "准备开始新任务"
                  }
                />
              </section>
              <div className="s-section-title">
                <h3>选择你的调试工具</h3>
                <span>从一个问题开始</span>
              </div>
              <section className="s-tool-grid">
                {cards.map(
                  ({
                    page: target,
                    icon: Icon,
                    title,
                    label,
                    text,
                    chips,
                    cls,
                  }) => (
                    <button
                      className="s-tool-card"
                      key={target}
                      onClick={() => setPage(target)}
                    >
                      <div>
                        <span className={`s-tool-icon ${cls}`}>
                          <Icon size={23} />
                        </span>
                        <ArrowRight size={17} />
                      </div>
                      <span className="s-eyebrow">{label}</span>
                      <h3>{title}</h3>
                      <p>{text}</p>
                      <div className="s-card-chips">
                        {chips.map((c) => (
                          <span key={c}>{c}</span>
                        ))}
                      </div>
                    </button>
                  ),
                )}
              </section>
              <section className="s-bottom-grid">
                <div className="s-panel">
                  <div className="s-section-title">
                    <h3>工作区动态</h3>
                    <span>本次运行</span>
                  </div>
                  <div className="s-recent-log">
                    {probe.logs.length ? (
                      probe.logs.slice(0, 4).map((l, i) => (
                        <p key={i}>
                          <i className="s-dot" />
                          {l}
                        </p>
                      ))
                    ) : (
                      <div className="s-empty-inline">
                        <FileClock size={22} />
                        <p>
                          你的下一次发现，从这里开始。
                          <small>连接设备、采集和导出记录将显示在这里。</small>
                        </p>
                      </div>
                    )}
                  </div>
                </div>
                <div className="s-tip">
                  <span>
                    <Zap size={18} />
                    工作流小贴士
                  </span>
                  <h3>从一次收发，到可复现的记录。</h3>
                  <p>
                    从已有串口或网络接口开始，保存原始收发日志，再结合协议解析定位问题。需要观察空口时，再接入抓包配件。
                  </p>
                  <button onClick={() => setPage("tools")}>
                    打开协议工具箱
                    <ArrowRight size={14} />
                  </button>
                </div>
              </section>
            </>
          )}
          {page === "wireless" && (
            <>
              <div className="s-page-heading">
                <div>
                  <span className="s-eyebrow">ON-AIR INSIGHTS</span>
                  <h1>无线抓包</h1>
                  <p>观察 Wi-Fi 空口帧和 BLE 广播，从数据中定位问题。</p>
                </div>
                <button
                  disabled={!filtered.length}
                  onClick={() =>
                    wireless === "wifi"
                      ? void save(
                          `ebed-${probe.source}-wifi.pcapng`,
                          exportPcapng(
                            filtered,
                            `EBED ${probe.source}; approximate host-aligned time; retained/filtered frames only`,
                          ),
                          "application/octet-stream",
                        )
                      : void save(
                          `ebed-${probe.source}-ble.json`,
                          JSON.stringify(
                            {
                              source: probe.source,
                              kind: "ble-scan-reports",
                              packets: filtered,
                            },
                            null,
                            2,
                          ),
                        )
                  }
                >
                  <Download size={16} />
                  导出{wireless === "wifi" ? " PCAPNG" : "扫描报告"}
                </button>
              </div>
              <section className="s-panel s-wire-controls">
                <div className="s-segment">
                  <button
                    className={wireless === "wifi" ? "active" : ""}
                    disabled={!!status.active}
                    onClick={() => {
                      setWireless("wifi");
                      setFilter("");
                      setSelected(null);
                    }}
                  >
                    <Wifi size={16} />
                    Wi-Fi
                  </button>
                  <button
                    className={wireless === "ble" ? "active" : ""}
                    disabled={!!status.active}
                    onClick={() => {
                      setWireless("ble");
                      setFilter("");
                      setSelected(null);
                    }}
                  >
                    <Bluetooth size={16} />
                    Bluetooth LE
                  </button>
                </div>
                {wireless === "wifi" ? (
                  <label className="s-inline-label">
                    监听信道
                    <select
                      aria-label="Wi-Fi 信道"
                      value={activeChannel}
                      disabled={!!status.active}
                      onChange={(e) => setChannel(+e.target.value)}
                    >
                      {(caps?.wifiChannels.length
                        ? caps.wifiChannels
                        : Array.from({ length: 13 }, (_, i) => i + 1)
                      ).map((n) => (
                        <option key={n} value={n}>
                          CH {n} · {2407 + n * 5} MHz
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <span className="s-muted">
                    被动广播扫描 · 设备返回广播数据与 RSSI
                  </span>
                )}
                <button
                  className="s-primary"
                  disabled={
                    busy ||
                    !available(wireless) ||
                    (!!status.active && status.active !== wireless)
                  }
                  onClick={startWireless}
                >
                  {status.active === wireless ? (
                    <Square size={15} />
                  ) : (
                    <Play size={15} />
                  )}
                  {status.active === wireless ? "停止采集" : "开始采集"}
                </button>
              </section>
              <div className="s-context-note">
                <Radio size={15} />
                {wireless === "wifi"
                  ? "ESP32-S3：2.4 GHz 单信道监听。受保护载荷保留原始字节；切换信道会错过其他信道的帧。"
                  : "BLE 广播扫描不等同于连接级空口抓包。经典蓝牙与 BLE 连接跟踪需要额外硬件及适配。"}
              </div>
              <section className="s-panel s-packet-panel">
                <div className="s-packet-toolbar">
                  <h3>
                    数据流{" "}
                    <span>
                      {filtered.length} / {wireCount}
                    </span>
                  </h3>
                  <label className="s-search">
                    <Search size={16} />
                    <input
                      placeholder="筛选 MAC、SSID、类型或信道…"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    />
                  </label>
                  <button
                    disabled={!!status.active || !probe.packets.length}
                    onClick={probe.clear}
                  >
                    清空采集
                  </button>
                </div>
                <div className="s-packet-table">
                  <table>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>时间</th>
                        <th>来源</th>
                        <th>类型</th>
                        <th>信道</th>
                        <th>RSSI</th>
                        <th>长度</th>
                        <th>摘要</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.slice(-500).map((p) => (
                        <tr
                          key={p.id}
                          tabIndex={0}
                          aria-selected={selectedPacket?.id === p.id}
                          className={
                            selectedPacket?.id === p.id ? "selected" : ""
                          }
                          onClick={() => setSelected(p.id)}
                          onKeyDown={(e) =>
                            (e.key === "Enter" || e.key === " ") &&
                            setSelected(p.id)
                          }
                        >
                          <td>{p.id}</td>
                          <td>
                            {new Date(p.timestampUs / 1000).toLocaleTimeString(
                              "zh-CN",
                              { hour12: false },
                            )}
                            .
                            {String(
                              Math.floor(p.timestampUs / 1000) % 1000,
                            ).padStart(3, "0")}
                          </td>
                          <td>{p.source}</td>
                          <td>
                            <span className={`s-protocol-chip ${p.protocol}`}>
                              {p.frameType}
                            </span>
                          </td>
                          <td>{p.channel || "—"}</td>
                          <td>
                            {p.rssi} <small>dBm</small>
                          </td>
                          <td>{toBytes(p.data).length}</td>
                          <td>{p.summary}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!filtered.length && (
                    <div className="s-empty">
                      <Radio size={34} />
                      <h3>
                        {filter ? "没有匹配的数据" : "空口的故事，等待捕获"}
                      </h3>
                      <p>
                        {filter
                          ? "尝试更换筛选条件。"
                          : "连接设备后开始采集，或使用演示工作区体验。"}
                      </p>
                      {!status.connected && (
                        <button onClick={() => setDeviceDialog(true)}>
                          <Usb size={15} />
                          连接设备
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <div className="s-table-foot">
                  <span>
                    显示最近 500 条 · 内存最多保留 2,000 条 · 导出当前筛选结果
                  </span>
                  <span>
                    设备丢帧 {probe.stats.deviceDropped} / USB 队列丢帧{" "}
                    {probe.stats.hostDropped} / 已淘汰 {probe.stats.evicted}
                  </span>
                </div>
              </section>
              <PacketDetails packet={selectedPacket} />
            </>
          )}
          {page === "logic" && (
            <LogicView
              capture={probe.logic}
              caps={caps}
              active={status.active}
              busy={busy}
              run={(n, c) => void probe.command(n, c)}
              save={save}
            />
          )}
          {page === "debug" && (
            <>
              <div className="s-page-heading">
                <div>
                  <span className="s-eyebrow">CONNECT. CONFIGURE. DEBUG.</span>
                  <h1>总线调试</h1>
                  <p>
                    UART / Modbus 使用已有串口；SPI / I²C
                    需要对应总线接口，当前支持 EBP 适配后端。
                  </p>
                </div>
                <span className="s-offline-tag">
                  <Zap size={15} />
                  {rawSerial && status.connected
                    ? `${status.path} · ${serialLabel}`
                    : "按任务选择接口"}
                </span>
              </div>
              <div className="s-debug-protocols">
                {(["uart", "spi", "i2c", "modbus"] as const).map((p) => (
                  <button
                    key={p}
                    className={debug === p ? "selected" : ""}
                    onClick={() => selectDebug(p)}
                  >
                    <Cable size={19} />
                    <strong>{featureLabels[p]}</strong>
                    <small>
                      {
                        {
                          uart: "串口终端",
                          spi: "同步总线",
                          i2c: "寄存器读写",
                          modbus: "RTU 主站",
                        }[p]
                      }
                    </small>
                    {available(p) && <i className="s-dot live" />}
                  </button>
                ))}
              </div>
              <div className="s-debug-grid">
                <section className="s-panel">
                  <div className="s-section-title">
                    <h3>
                      <span className="s-step">1</span>确认接线与预设
                    </h3>
                    <Settings2 size={17} />
                  </div>
                  <div className="s-wiring">
                    <Cable size={24} />
                    <div>
                      <strong>
                        {rawSerial && (debug === "uart" || debug === "modbus")
                          ? debug === "uart"
                            ? "使用目标已有串口或 USB 转串口适配器"
                            : "使用目标已有串口或 USB-RS485 适配器"
                          : caps?.pinout[
                              debug === "uart"
                                ? "UART"
                                : debug === "spi"
                                  ? "SPI"
                                  : debug === "i2c"
                                    ? "I2C"
                                    : "Modbus"
                            ] || "连接设备后显示固件声明的接线"}
                      </strong>
                      <p>
                        按目标接口确认接线和电平。TTL、RS232、RS485
                        不可直接混接；RS485 目标需要对应适配器。
                      </p>
                    </div>
                  </div>
                  <div className="s-form-grid">
                    {(debug === "uart" || debug === "modbus") &&
                      (rawSerial ? (
                        <div className="s-serial-config-summary">
                          <strong>
                            {status.connected
                              ? serialLabel
                              : "连接时选择波特率、数据位、校验和停止位"}
                          </strong>
                          <button onClick={() => setDeviceDialog(true)}>
                            {status.connected ? "管理串口参数" : "连接普通串口"}
                          </button>
                          <small>
                            {status.connected
                              ? "更改参数需断开后重新连接。"
                              : "无需专用板卡或 EBED 固件。"}
                          </small>
                        </div>
                      ) : (
                        <label>
                          波特率 · 8N1
                          <select
                            value={baud}
                            onChange={(e) => setBaud(+e.target.value)}
                          >
                            {[
                              9600, 19200, 38400, 57600, 115200, 230400, 921600,
                            ].map((n) => (
                              <option key={n}>{n}</option>
                            ))}
                          </select>
                        </label>
                      ))}
                    {debug === "i2c" && (
                      <label>
                        7-bit 地址（十进制）
                        <input
                          type="number"
                          min={8}
                          max={119}
                          value={busAddress}
                          onChange={(e) => setBusAddress(+e.target.value)}
                        />
                      </label>
                    )}
                    {(debug === "i2c" || debug === "spi") && (
                      <label>
                        总线频率
                        <select
                          value={frequency}
                          onChange={(e) => setFrequency(+e.target.value)}
                        >
                          {[
                            100000,
                            400000,
                            ...(debug === "spi" ? [1000000, 4000000] : []),
                          ].map((n) => (
                            <option key={n} value={n}>
                              {n / 1000} kHz
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {debug === "spi" && (
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
                    {debug !== "modbus" && !rawUart && (
                      <label>
                        期望接收字节
                        <input
                          type="number"
                          min={0}
                          max={1024}
                          value={readLength}
                          onChange={(e) => setReadLength(+e.target.value)}
                        />
                      </label>
                    )}
                    {debug === "modbus" && (
                      <>
                        <label>
                          从站地址
                          <input
                            type="number"
                            min={1}
                            max={247}
                            value={unit}
                            onChange={(e) => setUnit(+e.target.value)}
                          />
                        </label>
                        <label>
                          起始寄存器（0-based）
                          <input
                            type="number"
                            min={0}
                            max={65535}
                            value={register}
                            onChange={(e) => setRegister(+e.target.value)}
                          />
                        </label>
                        <label>
                          寄存器数量
                          <input
                            type="number"
                            min={1}
                            max={125}
                            value={quantity}
                            onChange={(e) => setQuantity(+e.target.value)}
                          />
                        </label>
                      </>
                    )}
                  </div>
                  <div className="s-preset-note">
                    <ShieldCheck size={16} />
                    <p>
                      {debug === "modbus"
                        ? "默认读取保持寄存器 FC03，自动附加 CRC16。"
                        : debug === "spi"
                          ? "预设为 JEDEC ID 命令 9F；需目标芯片支持。全双工字节在同一个 CS 周期传输。"
                          : debug === "i2c"
                            ? "预设为 0x50 设备的 0x00 寄存器读取；使用重复起始条件。"
                            : "预设发送 AT + CRLF，适合支持 AT 指令的模块。"}
                      <small>
                        预设是起点，请按目标器件调整。点击执行后才会驱动总线。
                      </small>
                    </p>
                  </div>
                </section>
                <section className="s-panel">
                  <div className="s-section-title">
                    <h3>
                      <span className="s-step">2</span>执行一次调试
                    </h3>
                    <span>
                      {rawUart ? "持续接收 · 手动发送" : "超时 1,000 ms"}
                    </span>
                  </div>
                  {rawUart && (
                    <div className="s-form-grid s-send-options">
                      <label>
                        发送格式
                        <select
                          value={inputFormat}
                          onChange={(e) => setInputFormat(e.target.value)}
                        >
                          <option value="hex">HEX</option>
                          <option value="text">UTF-8 文本</option>
                        </select>
                      </label>
                      {inputFormat === "text" && (
                        <label>
                          追加行尾
                          <select
                            value={lineEnding}
                            onChange={(e) => setLineEnding(e.target.value)}
                          >
                            <option value="">无</option>
                            <option value={"\n"}>LF</option>
                            <option value={"\r\n"}>CRLF</option>
                          </select>
                        </label>
                      )}
                    </div>
                  )}
                  <label className="s-payload-label">
                    {debug === "modbus"
                      ? "请求帧 · 自动 CRC"
                      : rawUart && inputFormat === "text"
                        ? "发送文本"
                        : "发送 HEX"}
                    <textarea
                      readOnly={debug === "modbus"}
                      value={
                        debug === "modbus"
                          ? buildModbusFrame({
                              variant: "rtu",
                              unitId: unit,
                              functionCode: 3,
                              address: register,
                              quantity,
                              value: 0,
                              transactionId: 1,
                            })
                          : rawUart && inputFormat === "text"
                            ? uartText
                            : payload
                      }
                      onChange={(e) =>
                        rawUart && inputFormat === "text"
                          ? setUartText(e.target.value)
                          : setPayload(e.target.value)
                      }
                      spellCheck={false}
                    />
                  </label>
                  <button
                    className="s-primary s-debug-run"
                    disabled={busy || !!status.active || !available(debug)}
                    onClick={() => void runDebug()}
                  >
                    {busy ? (
                      <LoaderCircle className="s-spin" size={17} />
                    ) : (
                      <Play size={17} />
                    )}
                    {rawUart
                      ? "发送串口数据"
                      : `执行 ${featureLabels[debug]} 调试`}
                  </button>
                  {!available(debug) && (
                    <p className="s-muted s-small">
                      {debug === "uart" || debug === "modbus"
                        ? "连接普通串口即可使用。"
                        : `需要支持 ${featureLabels[debug]} 的总线接口；当前可连接 EBP 固件设备，其他适配器尚待接入。`}{" "}
                      演示工作区可预览流程。
                    </p>
                  )}
                  <div className="s-result">
                    <div>
                      <Terminal size={16} />
                      <strong>收发结果</strong>
                      {debugResult && (
                        <span>
                          {debugResult.demo
                            ? "模拟响应"
                            : rawUart
                              ? "串口发送"
                              : "设备响应"}
                        </span>
                      )}
                    </div>
                    {debugResult ? (
                      <>
                        <p className="s-result-tx">
                          TX　{debugResult.tx.match(/.{2}/g)?.join(" ")}
                        </p>
                        <p className="s-result-rx">
                          RX　
                          {debugResult.rx ||
                            (rawUart ? "查看下方实时串口数据" : "没有返回数据")}
                        </p>
                        <p>
                          {debugResult.protocol === "modbus" && debugResult.rx
                            ? decodeModbusFrame(debugResult.rx)
                            : debugResult.text}
                        </p>
                      </>
                    ) : (
                      <p className="s-result-empty">
                        执行后显示发送帧、接收帧和设备结果。
                      </p>
                    )}
                  </div>
                </section>
              </div>
              {(rawSerial || probe.serialEntries.length > 0) && (
                <SerialMonitor
                  entries={probe.serialEntries}
                  bytes={probe.serialBytes}
                  dropped={probe.serialDropped}
                  connected={rawSerial && status.connected}
                  clear={probe.clearSerial}
                  save={save}
                />
              )}
              <section className="s-panel s-debug-log">
                <div className="s-section-title">
                  <h3>操作记录</h3>
                  <button
                    disabled={!probe.logs.length}
                    onClick={() =>
                      void save(
                        "ebed-debug-log.txt",
                        probe.logs.join("\n"),
                        "text/plain",
                      )
                    }
                  >
                    <Download size={14} />
                    导出日志
                  </button>
                </div>
                <pre>
                  {probe.logs.slice(0, 12).join("\n") || "等待设备操作…"}
                </pre>
              </section>
            </>
          )}
          {page === "tools" && (
            <>
              <div className="s-page-heading">
                <div>
                  <span className="s-eyebrow">EVERYDAY UTILITIES</span>
                  <h1>协议工具箱</h1>
                  <p>独立串口、TCP/UDP、MQTT、Modbus、CAN 解析与自动化脚本。</p>
                </div>
              </div>
              <div className="s-legacy">
                <Suspense
                  fallback={<div className="s-empty">正在打开工具箱…</div>}
                >
                  <LegacyWorkbench />
                </Suspense>
              </div>
            </>
          )}
          {page === "hardware" && (
            <>
              <div className="s-page-heading">
                <div>
                  <span className="s-eyebrow">BUILT AROUND YOUR HARDWARE</span>
                  <h1>设备与接线</h1>
                  <p>使用已有串口与接口；Wi-Fi 抓包配件按需选配。</p>
                </div>
                <button onClick={() => setDeviceDialog(true)}>
                  <Usb size={16} />
                  管理设备
                </button>
              </div>
              <div className="s-hardware-grid">
                <section className="s-panel">
                  <div className="s-section-title">
                    <h3>当前连接</h3>
                    <span>{status.connected ? "已连接" : "未连接"}</span>
                  </div>
                  <dl className="s-device-info">
                    <dt>设备型号</dt>
                    <dd>{caps?.model || "等待 USB 设备"}</dd>
                    <dt>序列号</dt>
                    <dd>{caps?.serial || "—"}</dd>
                    <dt>固件版本</dt>
                    <dd>{caps?.firmware || "—"}</dd>
                    <dt>传输接口</dt>
                    <dd>
                      {status.path || "系统串口 / USB dongle"}
                      {rawSerial && status.connected ? ` · ${serialLabel}` : ""}
                    </dd>
                  </dl>
                  <div className="s-feature-list">
                    {Object.entries(featureLabels).map(([f, text]) => (
                      <span
                        className={available(f as Feature) ? "ready" : ""}
                        key={f}
                      >
                        {available(f as Feature) ? (
                          <Check size={13} />
                        ) : (
                          <Square size={12} />
                        )}
                        {text}
                      </span>
                    ))}
                  </div>
                  <p className="s-muted s-small">
                    普通串口直接启用 UART /
                    Modbus。采集与其他总线操作按接口实际能力启用；当前后端为普通串口和
                    EBP 设备。
                  </p>
                </section>
                <section className="s-panel">
                  <div className="s-section-title">
                    <h3>板卡接线</h3>
                    <Cable size={18} />
                  </div>
                  {rawSerial ? (
                    <p className="s-muted">
                      普通串口无法报告目标引脚。按目标手册连接 TX/RX/GND 或
                      A/B；确认 TTL、RS232 或 RS485 接口类型和电压。
                    </p>
                  ) : caps ? (
                    <dl className="s-device-info">
                      {Object.entries(caps.pinout).map(([key, value]) => (
                        <div className="s-pin-row" key={key}>
                          <dt>{key}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <div className="s-empty-inline">
                      <Unplug size={26} />
                      <p>
                        接入设备后显示对应接线。
                        <small>
                          出厂固件需提供板卡引脚定义和可用采样参数。
                        </small>
                      </p>
                    </div>
                  )}
                  <div className="s-context-note">
                    可选数字探头需提供 GND、VTref 和带保护的输入。S3 GPIO
                    不应直接接 5 V 或 RS485 总线。
                  </div>
                </section>
              </div>
              <section className="s-panel s-hardware-plan">
                <div className="s-section-title">
                  <h3>选配配件 · EBED Wi-Fi 抓包器</h3>
                  <span>设计建议，尚非实测规格</span>
                </div>
                <div className="s-architecture">
                  <div>
                    <Usb size={28} />
                    <strong>USB-C</strong>
                    <span>系统标准 CDC 驱动</span>
                  </div>
                  <ArrowRight size={22} />
                  <div>
                    <Cpu size={28} />
                    <strong>ESP32-S3</strong>
                    <span>Wi-Fi 单信道监听</span>
                  </div>
                  <ArrowRight size={22} />
                  <div>
                    <Wifi size={28} />
                    <strong>空口数据</strong>
                    <span>帧分析 / PCAPNG 导出</span>
                  </div>
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>能力</th>
                      <th>交付定位</th>
                      <th>扩展方向</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Wi-Fi</td>
                      <td>2.4 GHz，单信道混杂模式</td>
                      <td>5 / 6 GHz 需要其他无线硬件</td>
                    </tr>
                    <tr>
                      <td>Bluetooth</td>
                      <td>后续可选：BLE 广播扫描，无经典蓝牙</td>
                      <td>BLE 连接抓包：独立 nRF52840 等接收器</td>
                    </tr>
                    <tr>
                      <td>逻辑分析</td>
                      <td>独立采样扩展，非首版 Wi-Fi 配件必选项</td>
                      <td>持续高速采样：采样协处理器 / FPGA + 高速 USB</td>
                    </tr>
                    <tr>
                      <td>总线调试</td>
                      <td>UART / Modbus 使用已有串口</td>
                      <td>SPI / I²C 适配器；第三方后端按需接入</td>
                    </tr>
                  </tbody>
                </table>
                <p className="s-muted s-small">
                  S3 的 Wi-Fi 与 BLE 共用射频；当前 EBP
                  后端一次运行一项采集或总线操作。USB Full Speed 的线路速率为 12
                  Mbit/s，有效载荷吞吐低于此值，采样指标必须经硬件实测确定。
                </p>
              </section>
            </>
          )}
        </main>
        <footer className="s-statusbar">
          <span>
            <i className={`s-dot ${status.connected ? "live" : ""}`} />
            {status.connected
              ? `${caps?.model} · ${status.path}`
              : work.connectedCount
                ? `${work.connectedCount} 个串口 / 网络连接在线`
                : "未连接设备"}
            {busy && <LoaderCircle size={13} className="s-spin" />}
          </span>
          <span>
            {status.active
              ? `正在采集 ${featureLabels[status.active]}`
              : "就绪"}
            <i />
            {window.desktopAPI ? "桌面运行环境" : "浏览器预览"}
            <i />
            数据保存在本地
          </span>
        </footer>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept=".json"
        hidden
        onChange={(e) => {
          void loadSession(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {deviceDialog && (
        <div
          className="s-modal-backdrop"
          onClick={() => setDeviceDialog(false)}
        >
          <section
            className="s-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="device-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="s-section-title">
              <h2 id="device-title">连接接口</h2>
              <button
                aria-label="关闭设备窗口"
                onClick={() => setDeviceDialog(false)}
              >
                <X size={18} />
              </button>
            </div>
            <p>
              直接选择已有串口。使用选配 Wi-Fi 抓包器或其他 EBP
              设备时，再切换连接方式。
            </p>
            <label>
              连接方式
              <select
                aria-label="连接方式"
                disabled={busy || status.connected}
                value={connectionKind}
                onChange={(e) =>
                  setConnectionKind(e.target.value as "serial" | "probe")
                }
              >
                <option value="serial">普通串口 · UART / Modbus</option>
                <option value="probe">扩展设备 · EBP/1 固件</option>
              </select>
            </label>
            <label>
              系统串口
              <select
                aria-label="系统串口"
                disabled={busy || status.connected}
                value={port}
                onChange={(e) => setPort(e.target.value)}
              >
                <option value="">
                  {probe.ports.length ? "请选择串口" : "未发现串口"}
                </option>
                {probe.ports.map((p) => (
                  <option key={p.path} value={p.path}>
                    {p.path} · {p.label}
                    {p.recognized ? " · 已识别" : ""}
                  </option>
                ))}
              </select>
            </label>
            {connectionKind === "serial" && (
              <div className="s-form-grid s-serial-connect">
                <label>
                  波特率
                  <input
                    aria-label="串口波特率"
                    type="number"
                    min={300}
                    max={2000000}
                    disabled={busy || status.connected}
                    value={serialConfig.baudRate}
                    onChange={(e) =>
                      setSerialConfig((c) => ({
                        ...c,
                        baudRate: +e.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  数据位
                  <select
                    disabled={busy || status.connected}
                    value={serialConfig.dataBits}
                    onChange={(e) =>
                      setSerialConfig((c) => ({
                        ...c,
                        dataBits: +e.target.value as SerialConfig["dataBits"],
                      }))
                    }
                  >
                    {[5, 6, 7, 8].map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </label>
                <label>
                  校验
                  <select
                    disabled={busy || status.connected}
                    value={serialConfig.parity}
                    onChange={(e) =>
                      setSerialConfig((c) => ({
                        ...c,
                        parity: e.target.value as SerialConfig["parity"],
                      }))
                    }
                  >
                    <option value="none">None 无</option>
                    <option value="even">Even 偶</option>
                    <option value="odd">Odd 奇</option>
                  </select>
                </label>
                <label>
                  停止位
                  <select
                    disabled={busy || status.connected}
                    value={serialConfig.stopBits}
                    onChange={(e) =>
                      setSerialConfig((c) => ({
                        ...c,
                        stopBits: +e.target.value as 1 | 2,
                      }))
                    }
                  >
                    <option>1</option>
                    <option>2</option>
                  </select>
                </label>
                <label>
                  硬件流控
                  <select
                    disabled={busy || status.connected}
                    value={String(serialConfig.rtscts)}
                    onChange={(e) =>
                      setSerialConfig((c) => ({
                        ...c,
                        rtscts: e.target.value === "true",
                      }))
                    }
                  >
                    <option value="false">无</option>
                    <option value="true">RTS / CTS</option>
                  </select>
                </label>
              </div>
            )}
            <p className="s-connect-note">
              {status.connected
                ? `已连接 ${status.path}。更改连接方式或参数，请先断开。`
                : connectionKind === "serial"
                  ? "默认 115200 / 8N1，请按目标设置。连接只打开串口，不发送探测数据。"
                  : "仅连接已烧录 EBP/1 固件的设备；会发送 hello 握手。"}
            </p>
            {probe.message && (
              <div className="s-connect-error" role="status">
                {probe.message}
              </div>
            )}
            <div className="s-modal-actions">
              <button disabled={busy} onClick={() => void probe.refresh()}>
                <RefreshCw size={15} />
                刷新
              </button>
              {status.connected ? (
                <button disabled={busy} onClick={() => void probe.disconnect()}>
                  <Unplug size={15} />
                  断开设备
                </button>
              ) : (
                <button
                  className="s-primary"
                  disabled={busy || !port}
                  onClick={() => {
                    void probe
                      .connect({
                        path: port,
                        kind: connectionKind,
                        serialConfig,
                      })
                      .then((result) => {
                        if (result) {
                          setDeviceDialog(false);
                          if (connectionKind === "serial") {
                            selectDebug("uart");
                            setPage("debug");
                          }
                        }
                      });
                  }}
                >
                  {busy ? (
                    <LoaderCircle size={16} className="s-spin" />
                  ) : (
                    <PlugZap size={16} />
                  )}
                  连接设备
                </button>
              )}
            </div>
            <div className="s-dialog-foot">
              <span>还没有硬件？</span>
              <button
                disabled={busy}
                onClick={() => {
                  void probe.demo();
                  setDeviceDialog(false);
                }}
              >
                打开演示工作区
                <ArrowRight size={14} />
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
function Metric({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Usb;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="s-metric">
      <div>
        <span>{label}</span>
        <Icon size={17} />
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}
function PacketDetails({ packet }: { packet?: PacketRow }) {
  const bytes = packet ? toBytes(packet.data) : new Uint8Array();
  return (
    <section className="s-panel s-packet-detail">
      <div className="s-section-title">
        <h3>帧详情</h3>
        <span>
          {packet
            ? `#${packet.id} · ${packet.protocol === "wifi" ? "802.11 原始帧" : "BLE 广播数据"}`
            : "选择一条数据查看详情"}
        </span>
      </div>
      <div>
        <dl>
          <dt>来源</dt>
          <dd>{packet?.source || "—"}</dd>
          <dt>目的</dt>
          <dd>{packet?.destination || "—"}</dd>
          <dt>摘要</dt>
          <dd>{packet?.summary || "—"}</dd>
          <dt>数据类型</dt>
          <dd>
            {!packet
              ? "—"
              : packet.protocol === "ble"
                ? "扫描 API 报告（非完整链路层 PDU）"
                : "IEEE 802.11"}
          </dd>
        </dl>
        <pre>
          {bytes.length
            ? Array.from(
                { length: Math.ceil(bytes.length / 16) },
                (_, i) =>
                  `${(i * 16).toString(16).padStart(4, "0")}   ${hex(bytes.slice(i * 16, i * 16 + 16)).padEnd(47)}   ${Array.from(bytes.slice(i * 16, i * 16 + 16), (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("")}`,
              ).join("\n")
            : "0000   等待数据…"}
        </pre>
      </div>
    </section>
  );
}
