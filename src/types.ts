import type { LucideIcon } from "lucide-react";

export type ChannelKey = "serial" | "tcp" | "udp" | "mqtt" | "modbus" | "can";
export type PayloadFormat = "text" | "hex" | "json";
export type Direction = "rx" | "tx" | "sys";
export type TransportMode = "demo" | "native";

export interface ChannelInfo {
  key: ChannelKey;
  name: string;
  shortName: string;
  icon: LucideIcon;
  accent: string;
  summary: string;
}

export interface LogEntry {
  id: string;
  ts: string;
  channel: ChannelKey;
  direction: Direction;
  format: PayloadFormat | "event";
  payload: string;
  decoded?: string;
  bytes?: number;
  meta?: string;
}

export interface ChartPoint {
  id: number;
  time: string;
  voltage: number;
  current: number;
  temperature: number;
  rpm: number;
}

export interface ProtocolCommand {
  id: string;
  name: string;
  channel: ChannelKey;
  payload: string;
  format: PayloadFormat;
  description: string;
}

export interface ProtocolTemplate {
  id: string;
  name: string;
  target: string;
  description: string;
  commands: ProtocolCommand[];
}

export interface AutoScript {
  id: string;
  name: string;
  channel: ChannelKey;
  intervalMs: number;
  loop: boolean;
  lines: string;
}

export interface ModbusBuilderState {
  variant: "rtu" | "tcp";
  unitId: number;
  functionCode: 3 | 4 | 6 | 16;
  address: number;
  quantity: number;
  value: number;
  transactionId: number;
}

export interface CanSignal {
  id: string;
  name: string;
  startBit: number;
  length: number;
  scale: number;
  offset: number;
  unit: string;
}

export interface CanFrame {
  id: string;
  dlc: number;
  data: string;
  extended: boolean;
}

export interface NativeCapabilities {
  platform: string;
  serialAvailable: boolean;
  tcpAvailable: boolean;
  udpAvailable: boolean;
  mqttAvailable: boolean;
  node: string;
  electron: string;
}

export interface NativeEvent {
  id: string;
  kind: ChannelKey;
  type: "data" | "status" | "overflow";
  phase?: "connecting" | "open" | "closed" | "error";
  rxBytes?: number;
  txBytes?: number;
  bytes?: number;
  truncated?: boolean;
  droppedBytes?: number;
  localAddress?: string;
  direction?: Direction;
  payload?: string;
  format?: PayloadFormat;
  meta?: string;
  level?: "ok" | "warn" | "error";
  message?: string;
  at: string;
}
export interface NativeConnection {
  id: string;
  kind: "serial" | "tcp" | "udp" | "mqtt";
  phase: "connecting" | "open" | "closed" | "error";
  message: string;
  config: Record<string, unknown>;
  rxBytes: number;
  txBytes: number;
  localAddress: string;
}

export interface DesktopAPI {
  capabilities: () => Promise<NativeCapabilities>;
  listSerialPorts: () => Promise<Array<Record<string, unknown>>>;
  listConnections: () => Promise<NativeConnection[]>;
  onConnectionEvents: (callback: (events: NativeEvent[]) => void) => () => void;
  openConnection: (request: {
    id: string;
    kind: ChannelKey;
    config: Record<string, unknown>;
  }) => Promise<{ ok: boolean; id: string }>;
  sendConnection: (request: {
    id: string;
    payload: string;
    format: PayloadFormat;
    meta?: Record<string, unknown>;
  }) => Promise<{ ok: boolean; bytes?: number }>;
  closeConnection: (id: string) => Promise<{ ok: boolean }>;
  saveFile: (request: {
    title?: string;
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
    content: string;
    encoding?: string;
  }) => Promise<{ ok: boolean; canceled?: boolean; path?: string }>;
  onNativeEvent: (callback: (event: NativeEvent) => void) => () => void;
}
