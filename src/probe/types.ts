export type Feature =
  "wifi" | "ble" | "logic" | "uart" | "spi" | "i2c" | "modbus";
export interface ProbeCapabilities {
  protocol: 1 | null;
  model: string;
  serial: string;
  firmware: string;
  features: Feature[];
  wifiChannels: number[];
  logicChannels: number;
  sampleRates: number[];
  maxSamples: number;
  pinout: Record<string, string>;
}
export interface DevicePort {
  path: string;
  label: string;
  serialNumber: string;
  recognized: boolean;
}
export interface ProbeStatus {
  connected: boolean;
  kind: "serial" | "probe";
  serialConfig?: SerialConfig;
  capabilities: ProbeCapabilities | null;
  path: string;
  active: Feature | null;
  message?: string;
}
export interface SerialConfig {
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 2;
  parity: "none" | "even" | "odd";
  rtscts: boolean;
}
export interface ConnectRequest {
  kind: "serial" | "probe";
  path: string;
  serialConfig?: SerialConfig;
}
export interface SerialEntry {
  at: string;
  direction: "rx" | "tx";
  hex: string;
}
export interface Packet {
  type: "packet";
  protocol: "wifi" | "ble";
  timestampUs: number;
  channel: number;
  rssi: number;
  data: string;
  originalLength: number;
  address?: string;
  name?: string;
  fcs?: boolean;
}
export interface LogicCapture {
  type: "logic";
  timestampUs: number;
  sampleRate: number;
  channels: number;
  samples: number[];
}
export type DeviceEvent =
  | Packet
  | LogicCapture
  | { type: "stats"; received: number; dropped: number }
  | { type: "log"; message: string };
export type ProbeEvent =
  | ({ type: "connection" } & ProbeStatus)
  | { type: "serial"; entries: SerialEntry[]; dropped: number }
  | { type: "batch"; events: DeviceEvent[]; hostDropped: number }
  | { type: "warning"; message: string };
export interface ProbeAPI {
  list(): Promise<DevicePort[]>;
  status(): Promise<ProbeStatus>;
  connect(request: ConnectRequest): Promise<ProbeStatus>;
  disconnect(): Promise<ProbeStatus>;
  command(
    command: string,
    config: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  onEvent(callback: (event: ProbeEvent) => void): () => void;
}
export interface PacketRow extends Packet {
  id: number;
  source: string;
  destination: string;
  summary: string;
  frameType: string;
}
export interface SessionData {
  version: 1;
  createdAt: string;
  source: "demo" | "device";
  capabilities: ProbeCapabilities | null;
  packets: Packet[];
  logic: LogicCapture | null;
}
