import type { PayloadFormat } from "../types";
export type ConnectionKind = "serial" | "tcp" | "udp" | "mqtt";
export type Config = Record<string, string | number | boolean>;
export interface QuickCommand {
  id: string;
  name: string;
  payload: string;
  format: PayloadFormat;
  ending: "" | "\n" | "\r\n";
}
export interface ConnectionProfile {
  id: string;
  name: string;
  kind: ConnectionKind;
  config: Config;
  commands: QuickCommand[];
}
export const profileKey = "ebed.connections.v1";
export const kindNames: Record<ConnectionKind, string> = {
  serial: "串口",
  tcp: "TCP",
  udp: "UDP",
  mqtt: "MQTT",
};
export function newProfile(kind: ConnectionKind): ConnectionProfile {
  const defaults: Record<ConnectionKind, Config> = {
    serial: {
      path: "",
      baudRate: 115200,
      dataBits: 8,
      parity: "none",
      stopBits: 1,
      rtscts: false,
      timeoutMs: 5000,
    },
    tcp: { host: "127.0.0.1", port: 9000, timeoutMs: 5000 },
    udp: {
      bindHost: "127.0.0.1",
      localPort: 0,
      remoteHost: "127.0.0.1",
      remotePort: 7002,
      timeoutMs: 5000,
    },
    mqtt: {
      url: "mqtt://127.0.0.1:1883",
      clientId: "",
      username: "",
      subscribeTopic: "debug/#",
      publishTopic: "debug/tx",
      qos: 0,
      timeoutMs: 5000,
    },
  };
  return {
    id: crypto.randomUUID(),
    name: `${kindNames[kind]} 连接`,
    kind,
    config: defaults[kind],
    commands: [],
  };
}
const fields: Record<ConnectionKind, string[]> = {
  serial: [
    "path",
    "baudRate",
    "dataBits",
    "parity",
    "stopBits",
    "rtscts",
    "timeoutMs",
  ],
  tcp: ["host", "port", "timeoutMs"],
  udp: ["bindHost", "localPort", "remoteHost", "remotePort", "timeoutMs"],
  mqtt: [
    "url",
    "clientId",
    "username",
    "subscribeTopic",
    "publishTopic",
    "qos",
    "timeoutMs",
  ],
};
export function cleanProfile(value: unknown): ConnectionProfile {
  const p = value as ConnectionProfile;
  if (
    !p ||
    !Object.hasOwn(fields, p.kind) ||
    typeof p.id !== "string" ||
    !/^[\w-]{1,64}$/.test(p.id) ||
    typeof p.name !== "string" ||
    !p.name.trim() ||
    p.name.length > 80 ||
    !p.config ||
    typeof p.config !== "object"
  )
    throw new Error("连接配置格式无效");
  const config = { ...newProfile(p.kind).config };
  for (const key of fields[p.kind]) {
    const value = p.config[key];
    if (value === undefined) continue;
    if (
      typeof value !== typeof config[key] ||
      (typeof value === "string" && value.length > 1024) ||
      (typeof value === "number" &&
        (!Number.isFinite(value) || Math.abs(value) > 2000000))
    )
      throw new Error(`配置字段无效：${key}`);
    // Never persist broker credentials embedded in a URL, even in an unfinished draft.
    config[key] =
      key === "url" ? String(value).replace(/(\w+:\/\/)[^/?#]*@/, "$1") : value;
  }
  if (!Array.isArray(p.commands) || p.commands.length > 20)
    throw new Error("每个连接最多保存 20 个快捷命令");
  const commands = p.commands.map((c) => {
    if (
      !c ||
      typeof c.id !== "string" ||
      c.id.length > 64 ||
      typeof c.name !== "string" ||
      !c.name.trim() ||
      c.name.length > 80 ||
      typeof c.payload !== "string" ||
      c.payload.length > 65536 ||
      !["text", "hex", "json"].includes(c.format) ||
      !["", "\n", "\r\n"].includes(c.ending)
    )
      throw new Error("快捷命令格式无效");
    return {
      id: c.id,
      name: c.name,
      payload: c.payload,
      format: c.format,
      ending: c.ending,
    };
  });
  return { id: p.id, name: p.name, kind: p.kind, config, commands };
}
export function parseProfiles(text: string): ConnectionProfile[] {
  if (text.length > 2097152) throw new Error("配置文件不能超过 2 MB");
  const value = JSON.parse(text);
  if (
    value?.version !== 1 ||
    !Array.isArray(value.profiles) ||
    !value.profiles.length ||
    value.profiles.length > 50
  )
    throw new Error("配置文件版本或数量无效（1–50 个）");
  const profiles = value.profiles.map(cleanProfile);
  if (
    new Set(profiles.map((p: ConnectionProfile) => p.id)).size !==
    profiles.length
  )
    throw new Error("配置包含重复标识");
  serializeProfiles(profiles);
  return profiles;
}
export function serializeProfiles(profiles: ConnectionProfile[]) {
  const text = JSON.stringify(
    { version: 1, profiles: profiles.map(cleanProfile) },
    null,
    2,
  );
  if (new TextEncoder().encode(text).length > 2097152)
    throw new Error("全部连接与快捷命令合计不能超过 2 MB");
  return text;
}
export function loadProfiles(storage: Pick<Storage, "getItem" | "setItem">) {
  let raw: string | null = null;
  try {
    raw = storage.getItem(profileKey);
    return {
      profiles: raw ? parseProfiles(raw) : [newProfile("serial")],
      warning: "",
      writable: true,
    };
  } catch {
    try {
      if (raw) storage.setItem(`${profileKey}.recovery`, raw);
      return {
        profiles: [newProfile("serial")],
        warning: "原连接配置无法读取，已保留恢复副本；当前使用默认配置。",
        writable: true,
      };
    } catch {
      return {
        profiles: [newProfile("serial")],
        warning: "本地存储不可用，配置仅在本次运行保留。",
        writable: false,
      };
    }
  }
}
export function prepareCommand(command: QuickCommand) {
  if (command.format === "hex") {
    const parts = command.payload.trim().split(/\s+/);
    if (!parts.every((p) => /^(?:0x)?(?:[\da-f]{2})+$/i.test(p)))
      throw new Error("HEX 必须为完整字节");
    if (parts.map((p) => p.replace(/^0x/i, "")).join("").length > 131072)
      throw new Error("发送内容不能超过 64 KB");
    return { payload: command.payload, format: command.format };
  }
  if (command.format === "json") JSON.parse(command.payload);
  const payload = command.payload + command.ending;
  if (new TextEncoder().encode(payload).length > 65536)
    throw new Error("发送内容不能超过 64 KB");
  return { payload, format: command.format };
}
