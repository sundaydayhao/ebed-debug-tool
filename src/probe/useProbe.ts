import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DeviceEvent,
  ConnectRequest,
  SerialEntry,
  DevicePort,
  Feature,
  LogicCapture,
  PacketRow,
  ProbeStatus,
  SessionData,
} from "./types";
import { describePacket } from "./analysis";
import { demoCapabilities, demoLogic, demoPacket } from "./demo";
const offline: ProbeStatus = {
  connected: false,
  kind: "serial",
  capabilities: null,
  path: "",
  active: null,
};
export function useProbe() {
  const [status, setStatus] = useState<ProbeStatus>(offline);
  const [ports, setPorts] = useState<DevicePort[]>([]);
  const [mode, setMode] = useState<"device" | "demo" | "replay">("device");
  const [source, setSource] = useState<"device" | "demo">("device");
  const [packets, setPackets] = useState<PacketRow[]>([]);
  const [logic, setLogic] = useState<LogicCapture | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState({
    received: 0,
    deviceDropped: 0,
    hostDropped: 0,
    evicted: 0,
  });
  const [logs, setLogs] = useState<string[]>([]);
  const [serialEntries, setSerialEntries] = useState<SerialEntry[]>([]);
  const [serialDropped, setSerialDropped] = useState(0);
  const [serialBytes, setSerialBytes] = useState({ rx: 0, tx: 0, evicted: 0 });
  const timer = useRef<ReturnType<typeof setInterval>>();
  const nextId = useRef(0),
    epochOffset = useRef<number | null>(null),
    count = useRef(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const statusRef = useRef(status);
  statusRef.current = status;
  const lock = useRef(false);
  const log = useCallback(
    (text: string) =>
      setLogs((old) =>
        [
          `${new Date().toLocaleTimeString("zh-CN", { hour12: false })}  ${text}`,
          ...old,
        ].slice(0, 100),
      ),
    [],
  );
  const ingest = useCallback(
    (events: DeviceEvent[], simulated = false) => {
      const rows: PacketRow[] = [];
      for (const raw of events) {
        let e = raw;
        if ("timestampUs" in raw && !simulated) {
          epochOffset.current ??= Date.now() * 1000 - raw.timestampUs;
          e = { ...raw, timestampUs: raw.timestampUs + epochOffset.current };
        }
        if (e.type === "packet") rows.push(describePacket(e, ++nextId.current));
        if (e.type === "logic") {
          setLogic(e);
          log(
            `采样完成 · ${e.samples.length.toLocaleString()} 点 / ${e.sampleRate.toLocaleString()} Hz`,
          );
        }
        if (e.type === "stats")
          setStats((old) => ({ ...old, deviceDropped: e.dropped }));
        if (e.type === "log") log(e.message);
      }
      if (rows.length) {
        count.current += rows.length;
        setPackets((old) => [...old, ...rows].slice(-2000));
        setStats((old) => ({
          ...old,
          received: count.current,
          evicted: Math.max(0, count.current - 2000),
        }));
      }
    },
    [log],
  );
  const refresh = useCallback(async () => {
    if (!window.probeAPI) return;
    try {
      setPorts(await window.probeAPI.list());
    } catch (e) {
      setMessage(String(e));
    }
  }, []);
  useEffect(() => {
    const api = window.probeAPI;
    if (!api) return;
    let disposed = false;
    void refresh();
    const poll = setInterval(() => {
      if (!disposed) void refresh();
    }, 3000);
    void api.status().then((s) => {
      if (!disposed && modeRef.current === "device") setStatus(s);
    });
    const off = api.onEvent((e) => {
      if (modeRef.current !== "device") return;
      if (e.type === "connection") {
        setStatus(e);
        if (e.message) {
          setMessage(e.message);
          log(e.message);
        }
      }
      if (e.type === "warning") setMessage(e.message);
      if (e.type === "serial") {
        setSerialEntries((old) => [...old, ...e.entries].slice(-200));
        setSerialDropped(e.dropped);
        setSerialBytes((old) => ({
          rx:
            old.rx +
            e.entries
              .filter((row) => row.direction === "rx")
              .reduce((n, row) => n + row.hex.length / 2, 0),
          tx:
            old.tx +
            e.entries
              .filter((row) => row.direction === "tx")
              .reduce((n, row) => n + row.hex.length / 2, 0),
          evicted: old.evicted + e.entries.length,
        }));
      }
      if (e.type === "batch") {
        ingest(e.events);
        setStats((old) => ({ ...old, hostDropped: e.hostDropped }));
      }
    });
    return () => {
      disposed = true;
      clearInterval(poll);
      off();
    };
  }, [refresh, ingest, log]);
  useEffect(() => () => clearInterval(timer.current), []);
  function clear() {
    clearSerial();
    setPackets([]);
    setLogic(null);
    nextId.current = 0;
    count.current = 0;
    setStats({ received: 0, deviceDropped: 0, hostDropped: 0, evicted: 0 });
  }
  function clearSerial() {
    setSerialEntries([]);
    setSerialBytes({ rx: 0, tx: 0, evicted: 0 });
  }
  const perform = async <T>(
    action: () => Promise<T>,
  ): Promise<T | undefined> => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      return await action();
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      setMessage(text);
      log(text);
      return undefined;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const connect = (request: ConnectRequest) =>
    perform(async () => {
      if (!window.probeAPI)
        throw new Error(
          "浏览器为预览环境。请使用 EBED Studio 桌面程序连接 USB 设备，或打开演示工作区。",
        );
      if (statusRef.current.connected) throw new Error("请先断开当前设备");
      const found = await window.probeAPI.list();
      setPorts(found);
      const target = request.path || (found.length === 1 ? found[0].path : "");
      if (!target)
        throw new Error(
          found.length
            ? "请选择要使用的串口。普通串口可直接收发，无需 EBED 固件。"
            : "未发现串口。请检查数据线及系统是否已识别串口设备。",
        );
      clearInterval(timer.current);
      modeRef.current = "device";
      setMode("device");
      setSource("device");
      clear();
      setSerialDropped(0);
      epochOffset.current = null;
      const s = await window.probeAPI.connect({ ...request, path: target });
      setStatus(s);
      log(`设备已连接 · ${s.capabilities?.model}`);
      return s;
    });
  const disconnect = () =>
    perform(async () => {
      clearInterval(timer.current);
      if (mode === "device") await window.probeAPI?.disconnect();
      setStatus(offline);
      log("设备已断开");
    });
  const demo = () =>
    perform(async () => {
      if (mode === "device" && status.connected)
        await window.probeAPI?.disconnect();
      clearInterval(timer.current);
      modeRef.current = "demo";
      setMode("demo");
      setSource("demo");
      clear();
      setStatus({
        connected: true,
        kind: "probe",
        capabilities: demoCapabilities,
        path: "模拟 USB",
        active: null,
      });
      log("已打开演示工作区，所有采集与调试数据均为模拟");
    });
  const leaveDemo = () => {
    clearInterval(timer.current);
    modeRef.current = "device";
    setMode("device");
    setStatus(offline);
    clear();
  };
  const command = (name: string, config: Record<string, unknown> = {}) =>
    perform(async () => {
      if (!status.connected) throw new Error("请先连接设备或打开演示工作区");
      if (mode === "replay") throw new Error("回放为离线只读模式");
      if (status.active && name !== "capture.stop")
        throw new Error("请先停止当前采集");
      if (mode === "device") {
        const reply = await window.probeAPI!.command(name, config);
        log(`${name} · ${String(reply.message || "设备已确认")}`);
        return reply;
      }
      if (name === "capture.stop") {
        clearInterval(timer.current);
        setStatus((s) => ({ ...s, active: null }));
        log("已停止演示采集");
        return { ok: true };
      }
      const feature = name.split(".")[0] as Feature;
      if (name.endsWith(".start")) {
        setStatus((s) => ({ ...s, active: feature }));
        if (feature === "logic") {
          ingest(
            [demoLogic(Number(config.sampleRate), Number(config.sampleCount))],
            true,
          );
          setStatus((s) => ({ ...s, active: null }));
        } else if (feature === "wifi" || feature === "ble") {
          let i = 0;
          const tick = () =>
            ingest(
              Array.from({ length: 3 }, () =>
                demoPacket(i++, feature, Number(config.channel || 6)),
              ),
              true,
            );
          tick();
          timer.current = setInterval(tick, 500);
        }
        log(`${name} · 演示采集`);
        return { ok: true };
      }
      log(`${name} · 演示响应`);
      const responses: Record<string, string> = {
        uart: "48 65 6C 6C 6F 20 45 42 45 44 0D 0A",
        spi: "00 EF 40 18",
        i2c: "2A",
        modbus: "01 03 04 00 2A 00 64 DA 10",
      };
      return {
        ok: true,
        hex: responses[feature] || "",
        message: "模拟响应，未访问真实硬件",
      };
    });
  const load = (session: SessionData) =>
    perform(async () => {
      if (mode === "device" && status.connected)
        await window.probeAPI?.disconnect();
      clearInterval(timer.current);
      modeRef.current = "replay";
      setMode("replay");
      setSource(session.source);
      clear();
      setStatus(offline);
      ingest(session.packets, true);
      if (session.logic) setLogic(session.logic);
      log(
        `已载入 ${session.source === "demo" ? "演示" : "设备"}会话 · ${session.createdAt}`,
      );
    });
  return {
    status,
    ports,
    mode,
    source,
    packets,
    logic,
    message,
    busy,
    stats,
    logs,
    serialEntries,
    serialBytes,
    serialDropped,
    clearSerial,
    setMessage,
    refresh,
    connect,
    disconnect,
    demo,
    leaveDemo,
    command,
    clear,
    load,
    log,
  };
}
