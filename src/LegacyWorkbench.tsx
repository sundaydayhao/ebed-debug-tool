import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Cable,
  CircleDot,
  Cpu,
  Download,
  FileDown,
  FileText,
  Layers,
  LineChart,
  Network,
  Pause,
  Play,
  Plug,
  Radio,
  RefreshCw,
  Search,
  Send,
  Server,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  Timer,
  Trash2,
  Wifi
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { defaultCanSignals, protocolTemplates, starterScripts } from "./data/templates";
import {
  buildHtmlReport,
  buildModbusFrame,
  bytesToHex,
  byteLength,
  createDemoPayload,
  decodeCanSignals,
  decodeModbusFrame,
  decodePayload,
  extractMetrics,
  hexToBytes,
  hexToAscii,
  logsToCsv,
  normalizeHex,
  nowStamp,
  parseCanFrameText,
  textToHex
} from "./lib/protocols";
import type {
  AutoScript,
  CanSignal,
  ChannelInfo,
  ChannelKey,
  ChartPoint,
  LogEntry,
  ModbusBuilderState,
  NativeCapabilities,
  NativeEvent,
  PayloadFormat,
  ProtocolCommand,
  TransportMode
} from "./types";

type ViewKey = "console" | "charts" | "scripts" | "templates" | "protocols" | "logs" | "reports";

type BrowserSerialPortInfo = {
  usbVendorId?: number;
  usbProductId?: number;
};

type BrowserSerialPort = {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open: (options: {
    baudRate: number;
    dataBits?: number;
    stopBits?: number;
    parity?: "none" | "even" | "odd";
    bufferSize?: number;
    flowControl?: "none" | "hardware";
  }) => Promise<void>;
  close: () => Promise<void>;
  getInfo?: () => BrowserSerialPortInfo;
};

type BrowserSerial = {
  requestPort: () => Promise<BrowserSerialPort>;
  getPorts: () => Promise<BrowserSerialPort[]>;
  addEventListener?: (type: "connect" | "disconnect", listener: () => void) => void;
  removeEventListener?: (type: "connect" | "disconnect", listener: () => void) => void;
};

type BrowserSerialSession = {
  port: BrowserSerialPort;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  writer?: WritableStreamDefaultWriter<Uint8Array>;
  closing: boolean;
};

const channels: ChannelInfo[] = [
  {
    key: "serial",
    name: "串口调试",
    shortName: "串口",
    icon: Cable,
    accent: "#2563eb",
    summary: "ESP32 / STM32 / GD32 UART"
  },
  {
    key: "tcp",
    name: "TCP 调试",
    shortName: "TCP",
    icon: Network,
    accent: "#059669",
    summary: "Socket 客户端收发"
  },
  {
    key: "udp",
    name: "UDP 调试",
    shortName: "UDP",
    icon: Radio,
    accent: "#d97706",
    summary: "网关广播与遥测"
  },
  {
    key: "mqtt",
    name: "MQTT 调试",
    shortName: "MQTT",
    icon: Wifi,
    accent: "#7c3aed",
    summary: "Broker 订阅与发布"
  },
  {
    key: "modbus",
    name: "Modbus",
    shortName: "Modbus",
    icon: Server,
    accent: "#0f766e",
    summary: "RTU / TCP 帧构造解析"
  },
  {
    key: "can",
    name: "CAN 解析",
    shortName: "CAN",
    icon: Cpu,
    accent: "#be123c",
    summary: "帧解析与信号换算"
  }
];

const viewTabs: Array<{ key: ViewKey; label: string; icon: typeof Terminal }> = [
  { key: "console", label: "工作台", icon: Terminal },
  { key: "charts", label: "图表", icon: LineChart },
  { key: "scripts", label: "脚本", icon: Timer },
  { key: "templates", label: "模板", icon: Layers },
  { key: "protocols", label: "协议", icon: SlidersHorizontal },
  { key: "logs", label: "日志", icon: FileText },
  { key: "reports", label: "报告", icon: FileDown }
];

const initialConnected = channels.reduce<Record<ChannelKey, boolean>>((acc, channel) => {
  acc[channel.key] = false;
  return acc;
}, {} as Record<ChannelKey, boolean>);

const connectionIds = channels.reduce<Record<ChannelKey, string>>((acc, channel) => {
  acc[channel.key] = `${channel.key}-main`;
  return acc;
}, {} as Record<ChannelKey, string>);

const initialPoint: ChartPoint = {
  id: 0,
  time: nowStamp(),
  voltage: 3.3,
  current: 0.42,
  temperature: 35,
  rpm: 1200
};

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function inferFormat(payload: string): PayloadFormat {
  const trimmed = payload.trim();
  if (!trimmed) return "text";
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return "json";
  }
  if (/^(0x)?[0-9a-fA-F]{2}([\s,:-]+(0x)?[0-9a-fA-F]{2})*$/.test(trimmed)) return "hex";
  return "text";
}

function getBrowserSerial() {
  if (typeof navigator === "undefined") return null;
  return ((navigator as Navigator & { serial?: BrowserSerial }).serial || null);
}

function formatBrowserSerialPort(port: BrowserSerialPort, index: number) {
  const info = port.getInfo?.() || {};
  const vendor = typeof info.usbVendorId === "number" ? info.usbVendorId.toString(16).padStart(4, "0").toUpperCase() : "";
  const product = typeof info.usbProductId === "number" ? info.usbProductId.toString(16).padStart(4, "0").toUpperCase() : "";
  return vendor && product ? `Web Serial ${vendor}:${product}` : `Web Serial ${index + 1}`;
}

function payloadToBytes(payload: string, format: PayloadFormat) {
  if (format === "hex") return new Uint8Array(hexToBytes(payload));
  return new TextEncoder().encode(payload);
}

function LegacyWorkbench() {
  const [activeChannel, setActiveChannel] = useState<ChannelKey>("serial");
  const [activeView, setActiveView] = useState<ViewKey>("console");
  const [transportMode, setTransportMode] = useState<TransportMode>(window.desktopAPI ? "native" : "demo");
  const [connected, setConnected] = useState(initialConnected);
  const [capabilities, setCapabilities] = useState<NativeCapabilities | null>(null);
  const [recording, setRecording] = useState(true);
  const recordingRef = useRef(recording);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [chartPoints, setChartPoints] = useState<ChartPoint[]>([initialPoint]);
  const [search, setSearch] = useState("");
  const [txPayload, setTxPayload] = useState("AT\r\n");
  const [txFormat, setTxFormat] = useState<PayloadFormat>("text");
  const [serialPorts, setSerialPorts] = useState<Array<Record<string, unknown>>>([]);
  const [runningScripts, setRunningScripts] = useState<Record<string, boolean>>({});
  const [scripts, setScripts] = useState<AutoScript[]>(starterScripts);
  const [selectedScriptId, setSelectedScriptId] = useState(starterScripts[0].id);
  const [canSignals, setCanSignals] = useState<CanSignal[]>(defaultCanSignals);
  const [canInput, setCanInput] = useState("18FF50E5#211F245804000001");
  const [modbusDecodeInput, setModbusDecodeInput] = useState("01 03 04 01 4A 00 1F 5A 3B");
  const [serialConfig, setSerialConfig] = useState({
    path: "",
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: "none"
  });
  const [tcpConfig, setTcpConfig] = useState({ host: "127.0.0.1", port: 9000 });
  const [udpConfig, setUdpConfig] = useState({ localPort: 7001, remoteHost: "127.0.0.1", remotePort: 7002 });
  const [mqttConfig, setMqttConfig] = useState({
    url: "mqtt://127.0.0.1:1883",
    clientId: "ebed-debug-pro",
    subscribeTopic: "ebed/debug/rx",
    publishTopic: "ebed/debug/tx",
    username: "",
    password: ""
  });
  const [modbusEndpoint, setModbusEndpoint] = useState({
    tcpHost: "127.0.0.1",
    tcpPort: 502,
    serialPath: "",
    baudRate: 9600
  });
  const [modbusBuilder, setModbusBuilder] = useState<ModbusBuilderState>({
    variant: "rtu",
    unitId: 1,
    functionCode: 3,
    address: 0,
    quantity: 4,
    value: 1,
    transactionId: 1
  });

  const demoTimersRef = useRef<Partial<Record<ChannelKey, number>>>({});
  const demoTicksRef = useRef<Record<ChannelKey, number>>({
    serial: 0,
    tcp: 0,
    udp: 0,
    mqtt: 0,
    modbus: 0,
    can: 0
  });
  const scriptTimersRef = useRef<Record<string, number>>({});
  const nativeChannelByIdRef = useRef<Record<string, ChannelKey>>({});
  const browserSerialSessionsRef = useRef<Partial<Record<ChannelKey, BrowserSerialSession>>>({});

  const activeChannelInfo = channels.find((channel) => channel.key === activeChannel) || channels[0];
  const activeScript = scripts.find((script) => script.id === selectedScriptId) || scripts[0];
  const browserSerialAvailable = Boolean(getBrowserSerial());
  const localAdapterAvailable = Boolean(window.desktopAPI || browserSerialAvailable);
  const runtimeLabel = window.desktopAPI ? "Electron 桌面端" : browserSerialAvailable ? "浏览器 Web Serial" : "浏览器演示端";
  const serialAdapterLabel = capabilities?.serialAvailable || browserSerialAvailable ? "可用" : "未检测";
  const generatedModbusFrame = useMemo(() => buildModbusFrame(modbusBuilder), [modbusBuilder]);
  const parsedCanFrame = useMemo(() => parseCanFrameText(canInput), [canInput]);
  const decodedCanSignals = useMemo(
    () => (parsedCanFrame ? decodeCanSignals(parsedCanFrame, canSignals) : []),
    [canSignals, parsedCanFrame]
  );
  const filteredLogs = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return logs;
    return logs.filter((log) =>
      [log.ts, log.channel, log.direction, log.format, log.payload, log.decoded, log.meta]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(term)
    );
  }, [logs, search]);
  const activeLogs = useMemo(
    () => filteredLogs.filter((log) => log.channel === activeChannel).slice(0, 120),
    [activeChannel, filteredLogs]
  );
  const stats = useMemo(() => {
    const bytes = logs.reduce((sum, log) => sum + (log.bytes || 0), 0);
    const rx = logs.filter((log) => log.direction === "rx").length;
    const tx = logs.filter((log) => log.direction === "tx").length;
    const online = Object.values(connected).filter(Boolean).length;
    return { bytes, rx, tx, online };
  }, [connected, logs]);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  const addLog = useCallback((draft: Omit<LogEntry, "id" | "ts" | "decoded" | "bytes"> & Partial<Pick<LogEntry, "decoded" | "bytes" | "ts">>) => {
    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      ts: draft.ts || nowStamp(),
      bytes: draft.bytes ?? byteLength(draft.payload, draft.format),
      decoded: draft.decoded ?? decodePayload(draft.channel, draft.payload, draft.format),
      ...draft
    };

    if (entry.direction === "rx") {
      setChartPoints((previous) => {
        const nextPoint = extractMetrics(entry, previous.at(-1) || initialPoint);
        return [...previous.slice(-179), nextPoint];
      });
    }

    if (recordingRef.current || entry.direction === "sys") {
      setLogs((previous) => [entry, ...previous].slice(0, 1500));
    }

    return entry;
  }, []);

  const stopDemo = useCallback((channel: ChannelKey) => {
    const timer = demoTimersRef.current[channel];
    if (timer) {
      window.clearInterval(timer);
      delete demoTimersRef.current[channel];
    }
  }, []);

  const startDemo = useCallback(
    (channel: ChannelKey) => {
      stopDemo(channel);
      addLog({
        channel,
        direction: "sys",
        format: "event",
        payload: "演示连接已建立",
        meta: "demo"
      });

      demoTimersRef.current[channel] = window.setInterval(() => {
        demoTicksRef.current[channel] += 1;
        const demo = createDemoPayload(channel, demoTicksRef.current[channel]);
        addLog({
          channel,
          direction: "rx",
          format: demo.format,
          payload: demo.payload,
          meta: "simulator"
        });
      }, channel === "can" ? 900 : 1200);
    },
    [addLog, stopDemo]
  );

  const refreshBrowserSerialPorts = useCallback(async () => {
    const serial = getBrowserSerial();
    if (!serial) return;
    try {
      const ports = await serial.getPorts();
      setSerialPorts(ports.map((port, index) => ({ path: formatBrowserSerialPort(port, index), source: "web-serial" })));
    } catch {
      setSerialPorts([]);
    }
  }, []);

  const closeBrowserSerial = useCallback(async (channel: ChannelKey) => {
    const session = browserSerialSessionsRef.current[channel];
    if (!session) return;

    session.closing = true;
    try {
      await session.reader?.cancel();
    } catch {
      // The reader may already be released by the read loop.
    }

    try {
      session.reader?.releaseLock();
    } catch {
      // Ignore duplicate releases during close.
    }

    try {
      session.writer?.releaseLock();
    } catch {
      // Ignore duplicate releases during close.
    }

    try {
      await session.port.close();
    } catch {
      // Some browsers close the port as part of stream cancellation.
    }

    delete browserSerialSessionsRef.current[channel];
  }, []);

  const openBrowserSerial = useCallback(
    async (channel: ChannelKey, config: Record<string, unknown>) => {
      const serial = getBrowserSerial();
      if (!serial) {
        throw new Error("当前浏览器不支持 Web Serial。本地串口请使用 Chrome/Edge 的 localhost 页面，或使用 Electron 桌面端。");
      }

      await closeBrowserSerial(channel);
      const port = await serial.requestPort();
      const parity = config.parity === "even" || config.parity === "odd" ? config.parity : "none";
      await port.open({
        baudRate: Number(config.baudRate || 115200),
        dataBits: Number(config.dataBits || 8),
        stopBits: Number(config.stopBits || 1),
        parity
      });

      const writer = port.writable?.getWriter();
      if (!writer) {
        await port.close();
        throw new Error("浏览器无法获取串口写入通道。");
      }

      const session: BrowserSerialSession = { port, writer, closing: false };
      browserSerialSessionsRef.current[channel] = session;
      await refreshBrowserSerialPorts();

      void (async () => {
        while (port.readable && !session.closing) {
          const reader = port.readable.getReader();
          session.reader = reader;
          try {
            while (!session.closing) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value?.byteLength) {
                addLog({
                  channel,
                  direction: "rx",
                  format: "hex",
                  payload: bytesToHex(Array.from(value)),
                  meta: "web serial"
                });
              }
            }
          } catch (error) {
            if (!session.closing) {
              addLog({
                channel,
                direction: "sys",
                format: "event",
                payload: error instanceof Error ? error.message : String(error),
                meta: "web serial read"
              });
            }
          } finally {
            try {
              reader.releaseLock();
            } catch {
              // The close path may have released this lock already.
            }
            if (session.reader === reader) delete session.reader;
          }
        }
      })();
    },
    [addLog, closeBrowserSerial, refreshBrowserSerialPorts]
  );

  const writeBrowserSerial = useCallback(async (channel: ChannelKey, payload: string, format: PayloadFormat) => {
    const session = browserSerialSessionsRef.current[channel];
    if (!session?.writer) throw new Error("Web Serial 串口未打开。");
    const bytes = payloadToBytes(payload, format);
    if (bytes.byteLength === 0) return;
    await session.writer.write(bytes);
  }, []);

  const closeChannel = useCallback(
    async (channel: ChannelKey) => {
      stopDemo(channel);
      const id = connectionIds[channel];
      if (window.desktopAPI) {
        try {
          await window.desktopAPI.closeConnection(id);
        } catch (error) {
          addLog({
            channel,
            direction: "sys",
            format: "event",
            payload: error instanceof Error ? error.message : String(error),
            meta: "close error"
          });
        }
      }
      await closeBrowserSerial(channel);
      setConnected((previous) => ({ ...previous, [channel]: false }));
      addLog({ channel, direction: "sys", format: "event", payload: "连接已关闭" });
    },
    [addLog, closeBrowserSerial, stopDemo]
  );

  const getNativeRequest = useCallback(
    (channel: ChannelKey) => {
      if (channel === "serial") return { kind: "serial" as ChannelKey, config: serialConfig };
      if (channel === "tcp") return { kind: "tcp" as ChannelKey, config: tcpConfig };
      if (channel === "udp") return { kind: "udp" as ChannelKey, config: udpConfig };
      if (channel === "mqtt") return { kind: "mqtt" as ChannelKey, config: mqttConfig };
      if (channel === "modbus") {
        if (modbusBuilder.variant === "tcp") {
          return {
            kind: "tcp" as ChannelKey,
            config: { host: modbusEndpoint.tcpHost, port: modbusEndpoint.tcpPort }
          };
        }
        return {
          kind: "serial" as ChannelKey,
          config: {
            path: modbusEndpoint.serialPath,
            baudRate: modbusEndpoint.baudRate,
            dataBits: 8,
            stopBits: 1,
            parity: "none"
          }
        };
      }
      return { kind: "can" as ChannelKey, config: {} };
    },
    [modbusBuilder.variant, modbusEndpoint, mqttConfig, serialConfig, tcpConfig, udpConfig]
  );

  const connectChannel = useCallback(
    async (channel: ChannelKey) => {
      if (connected[channel]) {
        await closeChannel(channel);
        return;
      }

      if (transportMode === "native" && window.desktopAPI && channel !== "can") {
        const request = getNativeRequest(channel);
        const id = connectionIds[channel];
        nativeChannelByIdRef.current[id] = channel;
        try {
          await window.desktopAPI.openConnection({ id, kind: request.kind, config: request.config });
          setConnected((previous) => ({ ...previous, [channel]: true }));
          addLog({
            channel,
            direction: "sys",
            format: "event",
            payload: `本地 ${request.kind.toUpperCase()} 连接请求已发送`,
            meta: "native"
          });
        } catch (error) {
          addLog({
            channel,
            direction: "sys",
            format: "event",
            payload: error instanceof Error ? error.message : String(error),
            meta: "native error"
          });
        }
        return;
      }

      if (transportMode === "native" && !window.desktopAPI) {
        const request = getNativeRequest(channel);
        if (request.kind !== "serial") {
          addLog({
            channel,
            direction: "sys",
            format: "event",
            payload: "浏览器本地模式仅支持 Web Serial 串口；TCP/UDP/MQTT 本地连接请使用 Electron 桌面端。",
            meta: "native unsupported"
          });
          return;
        }

        try {
          await openBrowserSerial(channel, request.config);
          setConnected((previous) => ({ ...previous, [channel]: true }));
          addLog({
            channel,
            direction: "sys",
            format: "event",
            payload: "Web Serial 串口已打开",
            meta: "web serial"
          });
        } catch (error) {
          addLog({
            channel,
            direction: "sys",
            format: "event",
            payload: error instanceof Error ? error.message : String(error),
            meta: "web serial error"
          });
        }
        return;
      }

      setConnected((previous) => ({ ...previous, [channel]: true }));
      startDemo(channel);
    },
    [addLog, closeChannel, connected, getNativeRequest, openBrowserSerial, startDemo, transportMode]
  );

  const sendPayload = useCallback(
    async (channel: ChannelKey, payload: string, format: PayloadFormat, meta?: Record<string, unknown>) => {
      const cleanPayload = format === "hex" ? normalizeHex(payload) : payload;
      if (!cleanPayload.trim()) return;

      addLog({
        channel,
        direction: "tx",
        format,
        payload: cleanPayload,
        meta: meta?.topic ? String(meta.topic) : undefined
      });

      if (transportMode === "native" && window.desktopAPI && connected[channel] && channel !== "can") {
        try {
          await window.desktopAPI.sendConnection({
            id: connectionIds[channel],
            payload: cleanPayload,
            format,
            meta
          });
          return;
        } catch (error) {
          addLog({
            channel,
            direction: "sys",
            format: "event",
            payload: error instanceof Error ? error.message : String(error),
            meta: "send error"
          });
        }
      }

      if (transportMode === "native" && !window.desktopAPI && connected[channel]) {
        const request = getNativeRequest(channel);
        if (request.kind === "serial") {
          try {
            await writeBrowserSerial(channel, cleanPayload, format);
            return;
          } catch (error) {
            addLog({
              channel,
              direction: "sys",
              format: "event",
              payload: error instanceof Error ? error.message : String(error),
              meta: "web serial send"
            });
          }
        } else {
          addLog({
            channel,
            direction: "sys",
            format: "event",
            payload: "浏览器本地模式仅支持 Web Serial 串口发送。",
            meta: "native unsupported"
          });
        }
        return;
      }

      window.setTimeout(() => {
        const demo = createDemoPayload(channel, demoTicksRef.current[channel] + 1);
        addLog({
          channel,
          direction: "rx",
          format: demo.format,
          payload: demo.payload,
          meta: "echo"
        });
      }, 220);
    },
    [addLog, connected, getNativeRequest, transportMode, writeBrowserSerial]
  );

  useEffect(() => {
    let cancelled = false;
    if (window.desktopAPI) {
      window.desktopAPI
        .capabilities()
        .then((result) => {
          if (!cancelled) setCapabilities(result);
        })
        .catch(() => setCapabilities(null));
      window.desktopAPI
        .listSerialPorts()
        .then((ports) => {
          if (!cancelled) {
            setSerialPorts(ports);
            if (ports.length === 1) {
              setSerialConfig(old => ({ ...old, path: String(ports[0].path) }));
              setModbusEndpoint(old => ({ ...old, serialPath: String(ports[0].path) }));
            }
          }
        })
        .catch(() => setSerialPorts([]));

      const unsubscribe = window.desktopAPI.onNativeEvent((event: NativeEvent) => {
        if (!Object.values(connectionIds).includes(event.id)) return;
        const channel = nativeChannelByIdRef.current[event.id] || event.kind;
        if (event.type === "status" && event.phase) setConnected(previous => ({ ...previous, [channel]: event.phase === "open" }));
        if (event.direction === "tx") return; // This toolbox already records its own sends.
        if (event.type === "data" && event.payload) {
          addLog({
            channel,
            direction: event.direction || "rx",
            format: event.format || "hex",
            payload: event.payload,
            meta: event.meta || "native"
          });
        } else if (event.type === "status") {
          addLog({
            channel,
            direction: "sys",
            format: "event",
            payload: event.message || "状态更新",
            meta: event.level || "native"
          });
        }
      });

      return () => {
        cancelled = true;
        unsubscribe();
      };
    }

    const serial = getBrowserSerial();
    setCapabilities({
      platform: "browser",
      serialAvailable: Boolean(serial),
      tcpAvailable: false,
      udpAvailable: false,
      mqttAvailable: false,
      node: "browser",
      electron: "-"
    });

    if (serial) {
      const refreshPorts = () => {
        void serial
          .getPorts()
          .then((ports) => {
            if (!cancelled) setSerialPorts(ports.map((port, index) => ({ path: formatBrowserSerialPort(port, index), source: "web-serial" })));
          })
          .catch(() => {
            if (!cancelled) setSerialPorts([]);
          });
      };

      refreshPorts();
      serial.addEventListener?.("connect", refreshPorts);
      serial.addEventListener?.("disconnect", refreshPorts);

      return () => {
        cancelled = true;
        serial.removeEventListener?.("connect", refreshPorts);
        serial.removeEventListener?.("disconnect", refreshPorts);
      };
    }

    return () => {
      cancelled = true;
    };
  }, [addLog]);

  useEffect(() => {
    return () => {
      Object.values(demoTimersRef.current).forEach((timer) => timer && window.clearInterval(timer));
      Object.values(scriptTimersRef.current).forEach((timer) => timer && window.clearInterval(timer));
      for (const id of Object.values(connectionIds)) void window.desktopAPI?.closeConnection(id);
      (Object.keys(browserSerialSessionsRef.current) as ChannelKey[]).forEach((channel) => {
        void closeBrowserSerial(channel);
      });
    };
  }, [closeBrowserSerial]);

  const saveTextFile = useCallback(
    async (
      content: string,
      defaultPath: string,
      filters: Array<{ name: string; extensions: string[] }>,
      mime = "text/plain;charset=utf-8"
    ) => {
      if (window.desktopAPI) {
        const result = await window.desktopAPI.saveFile({ content, defaultPath, filters });
        if (result.ok) {
          addLog({
            channel: activeChannel,
            direction: "sys",
            format: "event",
            payload: `文件已保存：${result.path}`,
            meta: "export"
          });
        }
        return;
      }

      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = defaultPath;
      link.click();
      URL.revokeObjectURL(url);
    },
    [activeChannel, addLog]
  );

  const exportJson = () =>
    saveTextFile(JSON.stringify({ exportedAt: new Date().toISOString(), logs, chartPoints }, null, 2), "ebed-debug-log.json", [
      { name: "JSON", extensions: ["json"] }
    ], "application/json;charset=utf-8");

  const exportCsv = () =>
    saveTextFile(logsToCsv(logs), "ebed-debug-log.csv", [{ name: "CSV", extensions: ["csv"] }], "text/csv;charset=utf-8");

  const exportReport = () =>
    saveTextFile(buildHtmlReport(logs, chartPoints), "ebed-debug-report.html", [{ name: "HTML", extensions: ["html"] }], "text/html;charset=utf-8");

  const toggleScript = (script: AutoScript) => {
    if (runningScripts[script.id]) {
      const timer = scriptTimersRef.current[script.id];
      if (timer) window.clearInterval(timer);
      delete scriptTimersRef.current[script.id];
      setRunningScripts((previous) => ({ ...previous, [script.id]: false }));
      addLog({ channel: script.channel, direction: "sys", format: "event", payload: `脚本停止：${script.name}` });
      return;
    }

    const lines = script.lines
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    if (lines.length === 0) return;

    let index = 0;
    const runOnce = () => {
      const line = lines[index];
      void sendPayload(script.channel, line, inferFormat(line));
      index += 1;
      if (index >= lines.length) {
        if (script.loop) {
          index = 0;
        } else {
          const timer = scriptTimersRef.current[script.id];
          if (timer) window.clearInterval(timer);
          delete scriptTimersRef.current[script.id];
          setRunningScripts((previous) => ({ ...previous, [script.id]: false }));
        }
      }
    };

    runOnce();
    scriptTimersRef.current[script.id] = window.setInterval(runOnce, Math.max(100, script.intervalMs));
    setRunningScripts((previous) => ({ ...previous, [script.id]: true }));
    addLog({ channel: script.channel, direction: "sys", format: "event", payload: `脚本启动：${script.name}` });
  };

  const updateScript = (patch: Partial<AutoScript>) => {
    setScripts((previous) => previous.map((script) => (script.id === activeScript.id ? { ...script, ...patch } : script)));
  };

  const runTemplateCommand = (command: ProtocolCommand) => {
    setActiveChannel(command.channel);
    setTxPayload(command.payload);
    setTxFormat(command.format);
    void sendPayload(command.channel, command.payload, command.format, command.channel === "mqtt" ? { topic: mqttConfig.publishTopic } : undefined);
  };

  const sendCanFrame = () => {
    const frame = parseCanFrameText(canInput);
    if (!frame) {
      addLog({ channel: "can", direction: "sys", format: "event", payload: "CAN 帧格式无效" });
      return;
    }
    addLog({
      channel: "can",
      direction: "rx",
      format: "text",
      payload: `${frame.id}#${frame.data.replace(/\s/g, "")}`,
      decoded: decodedCanSignals.map((signal) => `${signal.name}=${signal.value.toFixed(2)}${signal.unit}`).join(", ")
    });
  };

  const sendGeneratedModbus = () => {
    setTxPayload(generatedModbusFrame);
    setTxFormat("hex");
    void sendPayload("modbus", generatedModbusFrame, "hex");
  };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Activity size={22} />
          </div>
          <div>
            <h1>协议工具箱</h1>
            <p>Serial / TCP / UDP / MQTT / Modbus / CAN</p>
          </div>
        </div>

        <div className="mode-switch" aria-label="运行模式">
          <button className={cx(transportMode === "demo" && "active")} onClick={() => setTransportMode("demo")}>
            <CircleDot size={16} />
            演示
          </button>
          <button
            className={cx(transportMode === "native" && "active")}
            disabled={!localAdapterAvailable}
            title={localAdapterAvailable ? "使用本地适配器" : "当前浏览器不支持 Web Serial，请使用 Chrome/Edge 或 Electron 桌面端"}
            onClick={() => setTransportMode("native")}
          >
            <Plug size={16} />
            本地
          </button>
        </div>

        <div className="channel-list">
          {channels.map((channel) => {
            const Icon = channel.icon;
            return (
              <button
                key={channel.key}
                className={cx("channel-item", activeChannel === channel.key && "active")}
                onClick={() => {
                  setActiveChannel(channel.key);
                  setActiveView("console");
                }}
                style={{ "--accent": channel.accent } as React.CSSProperties}
              >
                <Icon size={18} />
                <span>
                  <strong>{channel.name}</strong>
                  <small>{channel.summary}</small>
                </span>
                <i className={cx(connected[channel.key] && "online")} />
              </button>
            );
          })}
        </div>

        <div className="sidebar-footer">
          <div>
            <span>运行环境</span>
            <strong>{runtimeLabel}</strong>
          </div>
          <div>
            <span>串口适配器</span>
            <strong>{serialAdapterLabel}</strong>
          </div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <div className="eyebrow">当前通道</div>
            <h2>{activeChannelInfo.name}</h2>
          </div>
          <div className="topbar-actions">
            <button className={cx("primary", connected[activeChannel] && "danger")} onClick={() => void connectChannel(activeChannel)}>
              {connected[activeChannel] ? <Pause size={17} /> : <Play size={17} />}
              {connected[activeChannel] ? "断开" : "连接"}
            </button>
            <button className={cx("ghost", recording && "active")} onClick={() => setRecording((value) => !value)}>
              <CircleDot size={17} />
              {recording ? "记录中" : "暂停记录"}
            </button>
            <button className="ghost" onClick={() => setLogs([])}>
              <Trash2 size={17} />
              清空
            </button>
          </div>
        </header>

        <section className="stats-strip">
          <Metric label="在线通道" value={stats.online} suffix={`/ ${channels.length}`} />
          <Metric label="RX 帧" value={stats.rx} />
          <Metric label="TX 帧" value={stats.tx} />
          <Metric label="累计字节" value={stats.bytes} />
        </section>

        <nav className="view-tabs">
          {viewTabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button key={tab.key} className={cx(activeView === tab.key && "active")} onClick={() => setActiveView(tab.key)}>
                <Icon size={17} />
                {tab.label}
              </button>
            );
          })}
        </nav>

        {activeView === "console" && renderConsole()}
        {activeView === "charts" && renderCharts()}
        {activeView === "scripts" && renderScripts()}
        {activeView === "templates" && renderTemplates()}
        {activeView === "protocols" && renderProtocols()}
        {activeView === "logs" && renderLogs()}
        {activeView === "reports" && renderReports()}
      </section>
    </main>
  );

  function renderConsole() {
    return (
      <section className="content-grid">
        <div className="panel terminal-panel">
          <div className="panel-header">
            <div>
              <h3>收发终端</h3>
              <p>{activeChannelInfo.shortName} 数据流</p>
            </div>
            <div className="toolbar-inline">
              <button onClick={() => setTxPayload(textToHex(txPayload))}>
                <CodeLabel label="HEX" />
              </button>
              <button onClick={() => setTxPayload(hexToAscii(txPayload))}>
                <CodeLabel label="ASCII" />
              </button>
            </div>
          </div>

          <div className="terminal">
            {activeLogs.length === 0 ? (
              <div className="empty-state">
                <Terminal size={28} />
                <span>当前通道暂无数据</span>
              </div>
            ) : (
              activeLogs.map((log) => (
                <div key={log.id} className={cx("terminal-line", log.direction)}>
                  <span>{log.ts}</span>
                  <b>{log.direction.toUpperCase()}</b>
                  <code>{log.payload}</code>
                  <small>{log.decoded}</small>
                </div>
              ))
            )}
          </div>

          <div className="composer">
            <div className="segmented">
              {(["text", "hex", "json"] as PayloadFormat[]).map((format) => (
                <button key={format} className={cx(txFormat === format && "active")} onClick={() => setTxFormat(format)}>
                  {format.toUpperCase()}
                </button>
              ))}
            </div>
            <textarea value={txPayload} onChange={(event) => setTxPayload(event.target.value)} />
            <button className="send-button" onClick={() => void sendPayload(activeChannel, txPayload, txFormat, activeChannel === "mqtt" ? { topic: mqttConfig.publishTopic } : undefined)}>
              <Send size={18} />
              发送
            </button>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <h3>连接配置</h3>
              <p>{transportMode === "native" ? "本地适配器参数" : "演示数据源参数"}</p>
            </div>
            <button onClick={() => void connectChannel(activeChannel)}>
              <Plug size={16} />
              {connected[activeChannel] ? "断开" : "打开"}
            </button>
          </div>
          {renderConnectionForm()}
        </div>
      </section>
    );
  }

  function renderConnectionForm() {
    if (activeChannel === "serial") {
      return (
        <div className="form-grid">
          <label>
            端口
            <input value={serialConfig.path} onChange={(event) => setSerialConfig({ ...serialConfig, path: event.target.value })} list="serial-ports" />
          </label>
          <datalist id="serial-ports">
            {serialPorts.map((port, index) => (
              <option key={index} value={String(port.path || port.friendlyName || "")} />
            ))}
          </datalist>
          <label>
            波特率
            <input type="number" value={serialConfig.baudRate} onChange={(event) => setSerialConfig({ ...serialConfig, baudRate: Number(event.target.value) })} />
          </label>
          <label>
            数据位
            <input type="number" value={serialConfig.dataBits} onChange={(event) => setSerialConfig({ ...serialConfig, dataBits: Number(event.target.value) })} />
          </label>
          <label>
            停止位
            <input type="number" value={serialConfig.stopBits} onChange={(event) => setSerialConfig({ ...serialConfig, stopBits: Number(event.target.value) })} />
          </label>
          <label>
            校验
            <select value={serialConfig.parity} onChange={(event) => setSerialConfig({ ...serialConfig, parity: event.target.value })}>
              <option value="none">none</option>
              <option value="even">even</option>
              <option value="odd">odd</option>
            </select>
          </label>
        </div>
      );
    }

    if (activeChannel === "tcp") {
      return (
        <div className="form-grid">
          <label>
            Host
            <input value={tcpConfig.host} onChange={(event) => setTcpConfig({ ...tcpConfig, host: event.target.value })} />
          </label>
          <label>
            Port
            <input type="number" value={tcpConfig.port} onChange={(event) => setTcpConfig({ ...tcpConfig, port: Number(event.target.value) })} />
          </label>
        </div>
      );
    }

    if (activeChannel === "udp") {
      return (
        <div className="form-grid">
          <label>
            本地端口
            <input type="number" value={udpConfig.localPort} onChange={(event) => setUdpConfig({ ...udpConfig, localPort: Number(event.target.value) })} />
          </label>
          <label>
            远端 Host
            <input value={udpConfig.remoteHost} onChange={(event) => setUdpConfig({ ...udpConfig, remoteHost: event.target.value })} />
          </label>
          <label>
            远端端口
            <input type="number" value={udpConfig.remotePort} onChange={(event) => setUdpConfig({ ...udpConfig, remotePort: Number(event.target.value) })} />
          </label>
        </div>
      );
    }

    if (activeChannel === "mqtt") {
      return (
        <div className="form-grid single">
          <label>
            Broker URL
            <input value={mqttConfig.url} onChange={(event) => setMqttConfig({ ...mqttConfig, url: event.target.value })} />
          </label>
          <label>
            Client ID
            <input value={mqttConfig.clientId} onChange={(event) => setMqttConfig({ ...mqttConfig, clientId: event.target.value })} />
          </label>
          <label>
            订阅 Topic
            <input value={mqttConfig.subscribeTopic} onChange={(event) => setMqttConfig({ ...mqttConfig, subscribeTopic: event.target.value })} />
          </label>
          <label>
            发布 Topic
            <input value={mqttConfig.publishTopic} onChange={(event) => setMqttConfig({ ...mqttConfig, publishTopic: event.target.value })} />
          </label>
          <label>
            Username
            <input value={mqttConfig.username} onChange={(event) => setMqttConfig({ ...mqttConfig, username: event.target.value })} />
          </label>
          <label>
            Password
            <input type="password" value={mqttConfig.password} onChange={(event) => setMqttConfig({ ...mqttConfig, password: event.target.value })} />
          </label>
        </div>
      );
    }

    if (activeChannel === "modbus") {
      return (
        <div className="form-grid">
          <label>
            TCP Host
            <input value={modbusEndpoint.tcpHost} onChange={(event) => setModbusEndpoint({ ...modbusEndpoint, tcpHost: event.target.value })} />
          </label>
          <label>
            TCP Port
            <input type="number" value={modbusEndpoint.tcpPort} onChange={(event) => setModbusEndpoint({ ...modbusEndpoint, tcpPort: Number(event.target.value) })} />
          </label>
          <label>
            RTU 串口
            <input value={modbusEndpoint.serialPath} onChange={(event) => setModbusEndpoint({ ...modbusEndpoint, serialPath: event.target.value })} />
          </label>
          <label>
            RTU 波特率
            <input type="number" value={modbusEndpoint.baudRate} onChange={(event) => setModbusEndpoint({ ...modbusEndpoint, baudRate: Number(event.target.value) })} />
          </label>
        </div>
      );
    }

    return (
      <div className="form-grid single">
        <label>
          CAN 帧
          <input value={canInput} onChange={(event) => setCanInput(event.target.value)} />
        </label>
      </div>
    );
  }

  function renderCharts() {
    return (
      <section className="panel full-height">
        <div className="panel-header">
          <div>
            <h3>实时数据图表</h3>
            <p>从 RX JSON、文本数值和 Modbus 响应中提取指标</p>
          </div>
          <button onClick={() => setChartPoints([initialPoint])}>
            <RefreshCw size={16} />
            重置
          </button>
        </div>
        <div className="chart-wrap">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartPoints}>
              <defs>
                <linearGradient id="voltage" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#2563eb" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="#2563eb" stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="temperature" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#e11d48" stopOpacity={0.32} />
                  <stop offset="95%" stopColor="#e11d48" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#d8e1ed" />
              <XAxis dataKey="time" tick={{ fontSize: 11 }} minTickGap={24} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              <Area type="monotone" dataKey="voltage" name="电压 V" stroke="#2563eb" fill="url(#voltage)" strokeWidth={2} />
              <Area type="monotone" dataKey="current" name="电流 A" stroke="#059669" fill="#05966922" strokeWidth={2} />
              <Area type="monotone" dataKey="temperature" name="温度 C" stroke="#e11d48" fill="url(#temperature)" strokeWidth={2} />
              <Area type="monotone" dataKey="rpm" name="转速 rpm" stroke="#d97706" fill="#d9770620" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </section>
    );
  }

  function renderScripts() {
    return (
      <section className="content-grid scripts-grid">
        <div className="panel">
          <div className="panel-header">
            <div>
              <h3>自动发送脚本</h3>
              <p>按行发送，支持循环和固定间隔</p>
            </div>
            <button
              onClick={() => {
                const id = `script-${Date.now()}`;
                setScripts((previous) => [
                  ...previous,
                  { id, name: "新脚本", channel: activeChannel, intervalMs: 1000, loop: true, lines: "PING" }
                ]);
                setSelectedScriptId(id);
              }}
            >
              <Timer size={16} />
              新增
            </button>
          </div>

          <div className="script-list">
            {scripts.map((script) => (
              <button key={script.id} className={cx(selectedScriptId === script.id && "active")} onClick={() => setSelectedScriptId(script.id)}>
                <span>
                  <strong>{script.name}</strong>
                  <small>{script.channel.toUpperCase()} · {script.intervalMs}ms</small>
                </span>
                {runningScripts[script.id] ? <Pause size={16} /> : <Play size={16} />}
              </button>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <h3>{activeScript.name}</h3>
              <p>{runningScripts[activeScript.id] ? "正在运行" : "已就绪"}</p>
            </div>
            <button className={cx(runningScripts[activeScript.id] && "danger")} onClick={() => toggleScript(activeScript)}>
              {runningScripts[activeScript.id] ? <Pause size={16} /> : <Play size={16} />}
              {runningScripts[activeScript.id] ? "停止" : "运行"}
            </button>
          </div>
          <div className="form-grid">
            <label>
              名称
              <input value={activeScript.name} onChange={(event) => updateScript({ name: event.target.value })} />
            </label>
            <label>
              通道
              <select value={activeScript.channel} onChange={(event) => updateScript({ channel: event.target.value as ChannelKey })}>
                {channels.map((channel) => (
                  <option key={channel.key} value={channel.key}>
                    {channel.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              间隔 ms
              <input type="number" value={activeScript.intervalMs} onChange={(event) => updateScript({ intervalMs: Number(event.target.value) })} />
            </label>
            <label className="check-row">
              <input type="checkbox" checked={activeScript.loop} onChange={(event) => updateScript({ loop: event.target.checked })} />
              循环发送
            </label>
          </div>
          <textarea className="script-editor" value={activeScript.lines} onChange={(event) => updateScript({ lines: event.target.value })} />
        </div>
      </section>
    );
  }

  function renderTemplates() {
    return (
      <section className="template-grid">
        {protocolTemplates.map((template) => (
          <article key={template.id} className="panel template-panel">
            <div className="panel-header">
              <div>
                <h3>{template.name}</h3>
                <p>{template.target} · {template.description}</p>
              </div>
              <ShieldCheck size={20} />
            </div>
            <div className="command-list">
              {template.commands.map((command) => (
                <button key={command.id} onClick={() => runTemplateCommand(command)}>
                  <span>
                    <strong>{command.name}</strong>
                    <small>{command.description}</small>
                  </span>
                  <code>{command.channel.toUpperCase()}</code>
                </button>
              ))}
            </div>
          </article>
        ))}
      </section>
    );
  }

  function renderProtocols() {
    return (
      <section className="content-grid">
        <div className="panel">
          <div className="panel-header">
            <div>
              <h3>Modbus 帧构造</h3>
              <p>RTU 自动 CRC，TCP 自动 MBAP</p>
            </div>
            <button onClick={sendGeneratedModbus}>
              <Send size={16} />
              发送帧
            </button>
          </div>
          <div className="form-grid">
            <label>
              类型
              <select value={modbusBuilder.variant} onChange={(event) => setModbusBuilder({ ...modbusBuilder, variant: event.target.value as "rtu" | "tcp" })}>
                <option value="rtu">RTU</option>
                <option value="tcp">TCP</option>
              </select>
            </label>
            <label>
              Unit ID
              <input type="number" value={modbusBuilder.unitId} onChange={(event) => setModbusBuilder({ ...modbusBuilder, unitId: Number(event.target.value) })} />
            </label>
            <label>
              Function
              <select value={modbusBuilder.functionCode} onChange={(event) => setModbusBuilder({ ...modbusBuilder, functionCode: Number(event.target.value) as ModbusBuilderState["functionCode"] })}>
                <option value={3}>03 Read Holding</option>
                <option value={4}>04 Read Input</option>
                <option value={6}>06 Write Single</option>
                <option value={16}>16 Write Multiple</option>
              </select>
            </label>
            <label>
              Address
              <input type="number" value={modbusBuilder.address} onChange={(event) => setModbusBuilder({ ...modbusBuilder, address: Number(event.target.value) })} />
            </label>
            <label>
              Quantity
              <input type="number" value={modbusBuilder.quantity} onChange={(event) => setModbusBuilder({ ...modbusBuilder, quantity: Number(event.target.value) })} />
            </label>
            <label>
              Value
              <input type="number" value={modbusBuilder.value} onChange={(event) => setModbusBuilder({ ...modbusBuilder, value: Number(event.target.value) })} />
            </label>
            <label>
              Transaction ID
              <input type="number" value={modbusBuilder.transactionId} onChange={(event) => setModbusBuilder({ ...modbusBuilder, transactionId: Number(event.target.value) })} />
            </label>
          </div>
          <div className="code-output">{generatedModbusFrame}</div>
          <label className="stacked-label">
            响应解析
            <textarea value={modbusDecodeInput} onChange={(event) => setModbusDecodeInput(event.target.value)} />
          </label>
          <div className="decode-result">{decodeModbusFrame(modbusDecodeInput)}</div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <h3>CAN 数据解析</h3>
              <p>支持 11-bit / 29-bit ID 和 little-endian 信号</p>
            </div>
            <button onClick={sendCanFrame}>
              <Send size={16} />
              解析入库
            </button>
          </div>
          <label className="stacked-label">
            CAN 帧
            <input value={canInput} onChange={(event) => setCanInput(event.target.value)} />
          </label>
          <div className="can-frame-card">
            <span>ID</span>
            <strong>{parsedCanFrame?.id || "-"}</strong>
            <span>DLC</span>
            <strong>{parsedCanFrame?.dlc ?? "-"}</strong>
            <span>DATA</span>
            <strong>{parsedCanFrame?.data || "-"}</strong>
          </div>
          <div className="signal-list">
            {decodedCanSignals.map((signal) => (
              <div key={signal.id}>
                <span>{signal.name}</span>
                <strong>
                  {signal.value.toFixed(2)} {signal.unit}
                </strong>
                <small>raw {signal.raw}</small>
              </div>
            ))}
          </div>
          <div className="signal-editor">
            {canSignals.map((signal) => (
              <div key={signal.id} className="signal-row">
                <input value={signal.name} onChange={(event) => setCanSignals((previous) => previous.map((item) => (item.id === signal.id ? { ...item, name: event.target.value } : item)))} />
                <input type="number" value={signal.startBit} onChange={(event) => setCanSignals((previous) => previous.map((item) => (item.id === signal.id ? { ...item, startBit: Number(event.target.value) } : item)))} />
                <input type="number" value={signal.length} onChange={(event) => setCanSignals((previous) => previous.map((item) => (item.id === signal.id ? { ...item, length: Number(event.target.value) } : item)))} />
                <input type="number" value={signal.scale} onChange={(event) => setCanSignals((previous) => previous.map((item) => (item.id === signal.id ? { ...item, scale: Number(event.target.value) } : item)))} />
              </div>
            ))}
          </div>
        </div>
      </section>
    );
  }

  function renderLogs() {
    return (
      <section className="panel full-height">
        <div className="panel-header">
          <div>
            <h3>日志记录</h3>
            <p>收发、系统事件、协议解析结果</p>
          </div>
          <div className="toolbar-inline">
            <button onClick={exportCsv}>
              <Download size={16} />
              CSV
            </button>
            <button onClick={exportJson}>
              <Download size={16} />
              JSON
            </button>
          </div>
        </div>
        <div className="search-row">
          <Search size={17} />
          <input value={search} placeholder="搜索通道、载荷、解析结果" onChange={(event) => setSearch(event.target.value)} />
        </div>
        <div className="log-table">
          <div className="log-head">
            <span>时间</span>
            <span>通道</span>
            <span>方向</span>
            <span>载荷</span>
            <span>解析</span>
          </div>
          {filteredLogs.map((log) => (
            <div key={log.id} className="log-row">
              <span>{log.ts}</span>
              <span>{log.channel}</span>
              <span className={log.direction}>{log.direction.toUpperCase()}</span>
              <code>{log.payload}</code>
              <small>{log.decoded}</small>
            </div>
          ))}
        </div>
      </section>
    );
  }

  function renderReports() {

    return (
      <section className="reports-layout">
        <div className="panel report-panel">
          <div className="panel-header">
            <div>
              <h3>报告导出</h3>
              <p>生成包含统计、图表摘要和日志明细的 HTML 报告</p>
            </div>
            <button className="primary" onClick={exportReport}>
              <FileDown size={16} />
              导出 HTML
            </button>
          </div>
          <div className="report-summary">
            <Metric label="日志" value={logs.length} />
            <Metric label="图表点" value={chartPoints.length} />
            <Metric label="RX" value={stats.rx} />
            <Metric label="TX" value={stats.tx} />
          </div>
        </div>

      </section>
    );
  }
}

function Metric({ label, value, suffix = "" }: { label: string; value: string | number; suffix?: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>
        {value}
        {suffix}
      </strong>
    </div>
  );
}

function CodeLabel({ label }: { label: string }) {
  return (
    <>
      <Settings2 size={14} />
      {label}
    </>
  );
}

export default LegacyWorkbench;
