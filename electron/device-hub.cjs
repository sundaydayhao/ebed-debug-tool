const { ProbeManager } = require("./probe-manager.cjs");
const { SerialManager } = require("./serial-manager.cjs");
class DeviceHub {
  constructor(SerialPort, emit, isPortUsed = () => false) {
    this.probe = new ProbeManager(SerialPort, emit);
    this.serial = new SerialManager(SerialPort, emit);
    this.current = this.serial;
    this.connecting = false;
    this.reservedPath = "";
    this.isPortUsed = isPortUsed;
  }
  list() {
    return this.probe.list();
  }
  snapshot() {
    return this.current.snapshot();
  }
  uses(path) {
    return [
      this.reservedPath,
      this.probe.port?.path,
      this.serial.port?.path,
    ].includes(path);
  }
  async connect(request) {
    if (this.connecting || this.probe.port || this.serial.port)
      throw new Error("请先断开当前设备，或等待连接完成");
    if (
      !request ||
      !["serial", "probe"].includes(request.kind) ||
      typeof request.path !== "string" ||
      !request.path
    )
      throw new Error("请选择连接方式和串口");
    if (this.isPortUsed(request.path))
      throw new Error("该端口正由连接工作区或协议工具箱使用，请先断开串口");
    this.connecting = true;
    this.reservedPath = request.path;
    try {
      if (!(await this.list()).some((p) => p.path === request.path))
        throw new Error("串口已移除，请重新选择");
      this.current = request.kind === "serial" ? this.serial : this.probe;
      return await this.current.connect(request.path, request.serialConfig);
    } finally {
      this.connecting = false;
      this.reservedPath = "";
    }
  }
  disconnect() {
    if (this.connecting) throw new Error("请等待连接完成");
    return this.current.disconnect();
  }
  command(name, config) {
    return this.current.command(name, config);
  }
  fail(message) {
    this.current.fail(message);
  }
  dispose() {
    this.probe.dispose();
    this.serial.dispose();
  }
}
module.exports = { DeviceHub };
