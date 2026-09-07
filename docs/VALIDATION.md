# 验证与交付范围

`npm test` 覆盖 HEX、802.11 地址/SSID、PCAPNG 结构/时间/Radiotap、UART 位中心和停止位、SPI 四模式、I²C START/STOP/ACK、VCD 时间和会话输入限制。

USB 测试使用可控串口替身，直接运行真实 FrameParser/ProbeManager，验证 hello/ACK、分包/粘包、CRC32、损坏恢复、超长帧、能力限制、互斥、拔线、超时、并发连接。

普通串口测试直接运行 SerialManager / DeviceHub，覆盖无探测字节、参数透传、主动上报接收、精确发送、Modbus 分段响应/异常/CRC/超时、拔线、流控阻塞、队列上限和端口占用。串口发送排空超时会关闭端口，防止阻塞的数据在稍后继续发送；已发送但未收到 Modbus 响应则保留端口，报告超时且不自动重试。

`npm run test:serial-ui` 在隔离的 Electron 测试进程中加载实际生产 React 页面、preload 与 DeviceHub，仅使用内存串口替身。验证默认普通串口、参数输入、连接后进入终端、不发 hello、文本与 CRLF、实时收发、Modbus CRC、SPI 能力禁用、断开和连接失败后保留错误窗口。该测试不枚举或打开物理端口，截图为 `artifacts/serial-ui.png`。

`npm run build` 验证 TypeScript/生产构建；`npm run dist:win` 生成 Windows x64 便携 EXE。`npm run smoke:desktop` 验证打包生产页、preload 与串口模块，结果写入 artifacts/desktop-smoke.json。串口烟雾检查仅枚举，不打开目标端口或发送数据。

浏览器交互检查包括空状态、显式演示、Wi-Fi 开始/停止/筛选、BLE 扫描、逻辑捕获/解码、总线预设与旧工具箱。浏览器不宣称支持桌面 dongle USB。

待验收：普通串口适配器与真实目标的收发联调、真实 EBP/1 固件、USB 描述符免驱加载、无线丢包率、电气前端、时基/触发、I²C 时钟拉伸、RS485 收尾、干净 Windows 首次运行。模拟测试不能替代硬件验收。

发布包未配置代码签名，正式分发需发布方证书与信誉提示测试。当前仅构建 Windows x64，macOS/Linux 尚未交付。

## 本次验证结果（2026-09-08）

- 0.2.x 阶段 24 项自动测试通过，普通串口 Electron 界面集成测试通过；TypeScript 与生产构建通过。0.3.0 验证见下方。
- Windows 完整目录和单文件便携 EXE 启动检查均通过。生产页面使用 `file:` 加载；串口、TCP、UDP、MQTT 组件可用；只枚举端口，没有向真实设备发送数据。
- 生产版浏览器验证了 BLE 广播报告和工具箱加载；Wi-Fi 筛选、逻辑 UART/SPI/I²C 解码与四类总线预设交互均已检查。
- 依赖修复后 `npm audit --omit=dev` 为 0 个已知漏洞。
- `npm run smoke:portable` 可复现单文件便携版检查，报告位于 `artifacts/portable-smoke.json`。
- 修复了 Vite 监听发布目录导致 Windows DLL 文件占用、打包失败和开发服务器退出的问题：release/artifacts 排除在文件监听外；打包复用已安装的 Electron 发行目录。

## 0.2.2 产品定位调整

- 首页以串口、网络工具与离线会话为主，Wi-Fi 配件作为选配入口；生产页面截图 `artifacts/home-ui.png` 已检查，无横向溢出。
- 生产构建、现有串口 Electron 界面集成测试、完整目录与便携 EXE 启动检查通过。
- 文档中的 Wi-Fi-only hello 示例通过实际能力校验器，采样参数可为 0/空列表；这验证主机协议兼容性，不代表固件已实现。
- 软件独立交付、配件首版范围和第三方适配的待实现边界已记录在产品定位与硬件文档中。

## 0.3.0 连接工作区实现

- 35 项自动测试通过，覆盖新连接生命周期、配置持久化与原有协议/采样功能。`tests/connections.test.cjs` 使用本机 TCP/UDP socket 和最小 MQTT 协议测试服务端验证二进制收发、SUBACK、QoS1、关闭/重连、监听占用、超时/取消、队列上限和串口独占。
- `npm run test:workspace-ui` 通过。真实生产 React 页面、preload、ConnectionManager 联动，使用本机 TCP 与内存串口，验证两个连接同时运行、跨页接收、重复发送停止、日志搜索/导出、独立发送草稿、重载后配置/命令恢复、密码不持久化和不自动连接。截图 `artifacts/workspace-ui.png` 已进行视觉检查。
- 原有总线串口界面集成测试继续通过，包含连接失败后保留错误窗口与 Modbus CRC 结果。
- TypeScript / Vite 生产构建、`git diff --check` 通过；npm 安装检查为 0 个已知漏洞。
- 0.3.0 Windows x64 便携包构建成功，`npm run smoke:desktop` 和 `npm run smoke:portable` 均通过：生产页面与串口、TCP、UDP、MQTT 原生组件正常加载，系统识别到 2 个串口；检查未打开物理端口。发布文件校验值记录于 `release/SHA256SUMS.txt`。
- 网络测试只访问测试进程在 127.0.0.1 上的服务，没有访问用户的远端设备或 Broker；物理串口仅枚举，未做真实收发。远端认证服务、TLS、WebSocket Broker、QoS2、长时间高吞吐和不同串口适配器仍需单独验收。
