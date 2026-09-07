import { useEffect, useRef, useState } from "react";
import type { NativeEvent } from "../types";
import {
  cleanProfile,
  kindNames,
  loadProfiles,
  newProfile,
  parseProfiles,
  prepareCommand,
  profileKey,
  serializeProfiles,
} from "./profiles";
import type {
  ConnectionKind,
  ConnectionProfile,
  QuickCommand,
} from "./profiles";
export interface Session {
  phase: "connecting" | "open" | "closed" | "error";
  message: string;
  entries: NativeEvent[];
  rxBytes: number;
  txBytes: number;
  dropped: number;
  evicted: number;
  localAddress: string;
}
export const emptySession = (): Session => ({
  phase: "closed",
  message: "尚未连接",
  entries: [],
  rxBytes: 0,
  txBytes: 0,
  dropped: 0,
  evicted: 0,
  localAddress: "",
});
const connectionId = (id: string) => `ws-${id}`;
export interface SendDraft {
  payload: string;
  format: QuickCommand["format"];
  ending: QuickCommand["ending"];
  name: string;
  repeat: number;
  intervalMs: number;
}
export const defaultDraft = (kind: ConnectionKind): SendDraft => ({
  payload: kind === "serial" ? "AT" : "",
  format: "text",
  ending: kind === "serial" ? "\r\n" : "",
  name: "",
  repeat: 1,
  intervalMs: 1000,
});
export function useConnections() {
  const [initial] = useState(() => loadProfiles(localStorage));
  const [profiles, setProfiles] = useState(initial.profiles);
  const [selectedId, setSelectedId] = useState(initial.profiles[0].id);
  const [sessions, setSessions] = useState<Record<string, Session>>({});
  const [message, setMessage] = useState(initial.warning);
  const [storageSaved, setStorageSaved] = useState(initial.writable);
  const [sending, setSending] = useState<
    Record<string, { sent: number; total: number }>
  >({});
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, SendDraft>>({});
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const plans = useRef(
    new Map<string, { cancelled: boolean; wake?: () => void }>(),
  );
  const operations = useRef(new Set<string>());
  const selected = profiles.find((p) => p.id === selectedId) || profiles[0];
  const session = sessions[selected.id] || emptySession();
  function stop(id: string) {
    const plan = plans.current.get(id);
    if (plan) {
      plan.cancelled = true;
      plan.wake?.();
    }
  }
  function setDraft(id: string, patch: Partial<SendDraft>) {
    const p = profilesRef.current.find((p) => p.id === id);
    if (p)
      setDrafts((old) => ({
        ...old,
        [id]: { ...defaultDraft(p.kind), ...old[id], ...patch },
      }));
  }
  useEffect(() => {
    if (!initial.writable) return;
    try {
      localStorage.setItem(profileKey, serializeProfiles(profiles));
      setStorageSaved(true);
    } catch {
      setStorageSaved(false);
      setMessage("连接配置保存失败，请导出配置备份；当前修改仍保留在内存中。");
    }
  }, [profiles, initial.writable]);
  useEffect(() => {
    const api = window.desktopAPI;
    if (!api) return;
    let disposed = false;
    const off = api.onConnectionEvents((events) => {
      const relevant = events.filter((e) =>
        profilesRef.current.some((p) => connectionId(p.id) === e.id),
      );
      for (const e of relevant)
        if (
          e.type === "status" &&
          e.phase !== "open" &&
          e.phase !== "connecting"
        )
          stop(e.id.slice(3));
      setSessions((old) => {
        const next = { ...old };
        for (const e of relevant) {
          const id = e.id.slice(3),
            prior = next[id] || emptySession();
          const entries = [...prior.entries, e];
          next[id] = {
            ...prior,
            phase: e.type === "status" && e.phase ? e.phase : prior.phase,
            message:
              e.type === "status" ? e.message || prior.message : prior.message,
            rxBytes: e.rxBytes ?? prior.rxBytes,
            txBytes: e.txBytes ?? prior.txBytes,
            localAddress: e.localAddress ?? prior.localAddress,
            dropped: prior.dropped + (e.droppedBytes || 0),
            evicted: prior.evicted + Math.max(0, entries.length - 500),
            entries: entries.slice(-500),
          };
        }
        return next;
      });
    });
    void api
      .listConnections()
      .then((list) => {
        if (disposed) return;
        setSessions((old) => {
          const next = { ...old };
          for (const c of list)
            if (
              profilesRef.current.some((p) => connectionId(p.id) === c.id) &&
              !next[c.id.slice(3)]
            )
              next[c.id.slice(3)] = { ...emptySession(), ...c };
          return next;
        });
      })
      .catch((error) => {
        if (!disposed) setMessage(String(error));
      });
    return () => {
      disposed = true;
      off();
      for (const id of plans.current.keys()) stop(id);
    };
  }, []);
  function update(profile: ConnectionProfile) {
    try {
      const clean = cleanProfile(profile);
      const next = profilesRef.current.map((p) =>
        p.id === clean.id ? clean : p,
      );
      serializeProfiles(next);
      setProfiles(next);
    } catch (error) {
      setMessage(String(error));
    }
  }
  function add(kind: ConnectionKind) {
    if (profiles.length >= 50) {
      setMessage("最多保存 50 个连接配置");
      return;
    }
    const p = newProfile(kind);
    try {
      serializeProfiles([...profilesRef.current, p]);
    } catch (error) {
      setMessage(String(error));
      return;
    }
    setProfiles((old) => [...old, p]);
    setSelectedId(p.id);
  }
  async function connect(id: string) {
    const p = profilesRef.current.find((p) => p.id === id);
    if (!p || operations.current.has(id)) return;
    operations.current.add(id);
    setMessage("");
    try {
      if (!window.desktopAPI)
        throw new Error("真实串口与网络连接请使用桌面程序。");
      setSessions((old) => ({
        ...old,
        [id]: { ...emptySession(), phase: "connecting", message: "正在连接…" },
      }));
      await window.desktopAPI.openConnection({
        id: connectionId(id),
        kind: p.kind,
        config: {
          ...p.config,
          ...(p.kind === "mqtt" ? { password: passwords[id] || "" } : {}),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSessions((old) => ({
        ...old,
        [id]: { ...(old[id] || emptySession()), phase: "error", message },
      }));
      setMessage(message);
    } finally {
      operations.current.delete(id);
    }
  }
  async function disconnect(id: string) {
    stop(id);
    try {
      await window.desktopAPI?.closeConnection(connectionId(id));
    } catch (error) {
      setMessage(String(error));
    }
  }
  async function remove(id: string) {
    if (profiles.length === 1) {
      setMessage("至少保留一个连接配置");
      return;
    }
    await disconnect(id);
    setProfiles((old) => old.filter((p) => p.id !== id));
    setSessions((old) => {
      const next = { ...old };
      delete next[id];
      return next;
    });
    setPasswords((old) => {
      const next = { ...old };
      delete next[id];
      return next;
    });
  }
  function clear(id: string) {
    setSessions((old) => ({
      ...old,
      [id]: {
        ...(old[id] || emptySession()),
        entries: [],
        evicted: 0,
        dropped: 0,
      },
    }));
  }
  function importProfiles(text: string) {
    try {
      const imported = parseProfiles(text).map((p) => ({
        ...p,
        id: crypto.randomUUID(),
        name: `${p.name}（导入）`.slice(0, 80),
      }));
      if (profiles.length + imported.length > 50)
        throw new Error("导入后不能超过 50 个连接");
      serializeProfiles([...profilesRef.current, ...imported]);
      setProfiles((old) => [...old, ...imported]);
      setSelectedId(imported[0].id);
      setMessage(
        `已导入 ${imported.length} 个连接配置，点击连接后才会访问目标。`,
      );
    } catch (error) {
      setMessage(String(error));
    }
  }
  async function sendPlan(
    id: string,
    commands: QuickCommand[],
    intervalMs: number,
  ) {
    if (plans.current.has(id)) return;
    let prepared;
    try {
      if (
        !commands.length ||
        commands.length > 1000 ||
        !Number.isInteger(intervalMs) ||
        intervalMs < 100 ||
        intervalMs > 60000
      )
        throw new Error("发送次数应为 1–1000，间隔为 100–60000 ms");
      prepared = commands.map(prepareCommand);
      const kind = profilesRef.current.find((p) => p.id === id)?.kind;
      for (const c of prepared) {
        const length =
          c.format === "hex"
            ? c.payload.replace(/0x/gi, "").replace(/\s/g, "").length / 2
            : new TextEncoder().encode(c.payload).length;
        if (!length && kind !== "mqtt")
          throw new Error("发送序列不能包含空命令");
        if (kind === "udp" && length > 65507)
          throw new Error("UDP 数据报最多 65507 字节");
      }
    } catch (error) {
      setMessage(String(error));
      return;
    }
    const plan: { cancelled: boolean; wake?: () => void } = {
      cancelled: false,
    };
    plans.current.set(id, plan);
    setMessage("");
    setSending((old) => ({
      ...old,
      [id]: { sent: 0, total: commands.length },
    }));
    try {
      for (let index = 0; index < prepared.length && !plan.cancelled; index++) {
        if (sessionsRef.current[id]?.phase !== "open" || !window.desktopAPI)
          throw new Error("连接未就绪，发送已停止");
        await window.desktopAPI.sendConnection({
          id: connectionId(id),
          ...prepared[index],
        });
        setSending((old) => ({
          ...old,
          [id]: { sent: index + 1, total: prepared.length },
        }));
        if (!plan.cancelled && index < prepared.length - 1)
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, intervalMs);
            plan.wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
      }
    } catch (error) {
      setMessage(String(error));
    } finally {
      plans.current.delete(id);
      setSending((old) => {
        const next = { ...old };
        delete next[id];
        return next;
      });
    }
  }
  return {
    profiles,
    selected,
    selectedId: selected.id,
    setSelectedId,
    sessions,
    session,
    message,
    storageSaved,
    setMessage,
    passwords,
    setPasswords,
    drafts,
    setDraft,
    sending,
    update,
    add,
    connect,
    disconnect,
    remove,
    clear,
    importProfiles,
    sendPlan,
    stop,
    connectedCount: Object.values(sessions).filter((s) => s.phase === "open")
      .length,
    summary: (p: ConnectionProfile) =>
      p.kind === "serial"
        ? `${p.config.path || "未选择串口"} · ${p.config.baudRate}`
        : p.kind === "tcp"
          ? `${p.config.host}:${p.config.port}`
          : p.kind === "udp"
            ? `:${p.config.localPort} → ${p.config.remoteHost}:${p.config.remotePort}`
            : String(p.config.url),
    kindNames,
  };
}
