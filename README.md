# EBED Studio

面向嵌入式无线开发工程师的本地桌面工作台。Electron 提供本地运行环境，React/HTML 构建 GUI，普通系统串口直接用于 UART / Modbus，软件可独立交付；USB dongle 是以 Wi-Fi 抓包为核心的选配增值配件。

## 产品定位

软件本身承载串口、网络、协议分析、日志、脚本和会话工作流。自有 dongle 用于提供 Wi-Fi 空口采集和硬件套餐，不作为软件的激活器或基础功能解锁条件。软件授权方式和套餐定价尚未确定。SPI/I²C、逻辑采样与 BLE 作为独立能力演进，不要求用户购买自有 Wi-Fi 配件；目前尚未集成通用第三方采样和总线适配器。

## 普通用户：双击打开

Windows x64 免安装版：`release/EBED-Studio-0.3.0-Windows-x64.exe`。无需 Node.js、Python、ESP-IDF、浏览器插件或 Wireshark。也可运行 `release/win-unpacked/EBED Studio.exe`，需要保留整个目录。

打开程序 → “打开连接工作区” → 新建或选择串口 / TCP / UDP / MQTT → 设置目标参数 → 连接。配置和快捷命令自动保存在本机，重启后恢复参数；不会自动打开端口或重发命令。已有板载串口、USB CDC、USB-UART、USB-RS485 可直接使用，不需要 EBED 板卡或专用固件。系统每三秒刷新串口列表。

连接工作区最多保存 50 个配置（配置文件总计 2 MB）、同时打开 16 个接口。每个连接独立保留发送草稿与日志，跨页面持续接收，支持 HEX / UTF-8 / JSON 发送、行尾、1–1000 次重复发送、快捷命令顺序执行和停止。TCP 是客户端，UDP 为 IPv4 监听/发送，MQTT 支持 mqtt/mqtts/ws/wss、订阅和 QoS 0/1/2 发布；当前不自动重连、retain 关闭。MQTT 密码不落盘，导出配置也不包含该密码字段。

Modbus RTU FC03、SPI/I²C 预设位于“总线调试”；同一串口一次只能由一个工作区持有，需要先断开再切换工具。Wi-Fi 与逻辑采集通过“设备与接线”连接扩展设备。
UART 支持 HEX / UTF-8 文本发送、LF / CRLF、持续接收、显示切换和日志导出。串口参数支持 300–2,000,000 波特率（实际由适配器决定）、5–8 数据位、无/奇/偶校验、1/2 停止位和 RTS/CTS。更改参数需断开重连。Modbus RTU FC03 读寄存器共用该串口，校验响应地址、功能码、长度和 CRC；RS485 目标需对应电气适配器，软件不承担电平转换或自动 DE 控制。

使用选配 EBED Probe 时，在“连接接口”中将连接方式切换为“扩展设备”，握手后启用其报告的功能。没有硬件时，“体验演示工作区”可体验采集、解码和导出，所有模拟数据均明确标记。

**硬件仍在设计阶段：本仓库实现了上位机和 USB 协议，尚未提供可烧录固件，也未完成真实 dongle 联调。**普通 S3 开发板不会因为连接 USB 就自动具备抓包能力。开发者需按 [EBP/1 协议](docs/PROBE_PROTOCOL.md) 实现固件并出厂烧录。Windows 内置驱动的自动加载需要正确 CDC 描述符，首版交付目标为 Windows 10/11 x64。

## 当前功能

| 工作区 | 上位机已实现 | 真实设备前提 |
| --- | --- | --- |
| 连接工作区 | 多配置、串口/TCP/UDP/MQTT 并行收发、持久化配置/命令、过滤、JSON/CSV 导出、重复与顺序发送 | 系统串口或可达目标；参数正确 |
| 总线串口 | 端口发现、参数设置、UART 实时终端、Modbus RTU FC03、拔线提示、日志导出 | 系统已识别串口；参数与电气接口正确 |
| dongle 管理 | 显式握手、能力展示、拔线恢复、互斥操作、心跳 | EBP/1 固件 |
| Wi-Fi | 802.11 分类、MAC/SSID/RSSI/信道、筛选、HEX、Radiotap PCAPNG | S3 混杂接收，2.4 GHz 单信道 |
| Bluetooth LE | 广播报告、地址/名称/RSSI/字节、JSON 导出 | 被动扫描固件；不代表连接级抓包 |
| 逻辑分析 | 波形、缩放/平移、A/B 游标、触发配置、UART/SPI/I²C 解码、VCD | 采样后端；速率由实测能力报告 |
| 总线调试 | UART/SPI/I²C/Modbus RTU FC03 预设、命令收发、CRC16 | UART/Modbus 可用普通串口；SPI/I²C 需对应接口，当前后端为 EBP |
| 工具箱 | 原有串口、TCP/UDP、MQTT、Modbus 构帧、CAN 文本解析、图表、脚本、日志/报告 | 本地适配器；CAN 目前为离线解析 |
| 会话 | `.ebed.json` 保存/载入、校验、离线回放、模拟来源保留 | 无硬件也能回放 |

主工作台默认真实设备模式，无设备时显示空状态；工具箱有独立本地/演示开关，退出工具箱关闭该工具箱的连接与脚本。主工作台采集跨页面继续运行。首版一次运行一项 dongle 采集或总线操作。

无线内存最多保留 2,000 条，表格渲染最近 500 条；导出保留且符合筛选条件的数据。逻辑为单次采集，最多 32,768 点。当前不支持无限连续无损记录。

连接工作区每接口保留最近 500 条记录，单条最多显示 64 KB，截断明确标记；主进程队列最多 512 条 / 1 MB，每 50 ms 批量推送。显示原始字节计数、队列丢弃与 UI 淘汰，导出当前保留且符合筛选的日志。它不是持续无损磁盘记录器，关闭程序后需通过导出文件保留日志。

总线调试页的串口接收跨页面持续运行，保留最近 200 段（每段最多 2 KB），显示收发字节、淘汰段数和 IPC 丢弃字节数。串口日志单独导出原始 HEX，不包含在无线/逻辑 `.ebed.json` 会话中。文本显示为 UTF-8。超时后不自动重发 Modbus 请求；有本地回显的适配器需关闭回显。

## 设计与验证

- [产品定位与交付边界](docs/PRODUCT_POSITIONING.md)：独立软件、Wi-Fi 配件、兼容与商业边界。
- [产品和软件架构](docs/PRODUCT_ARCHITECTURE.md)：方案选择、打开即用、完成情况与路线。
- [硬件建议](docs/HARDWARE_PLAN.md)：S3 边界、扩展、电平保护、带宽和验收。
- [USB 协议](docs/PROBE_PROTOCOL.md)：固件开发的报文契约。
- [验证说明](docs/VALIDATION.md)：软件测试与待完成的硬件验收。

## 开发者

以下命令只供开发/构建，最终用户不需要执行：

```bash
npm ci
npm run dev       # 桌面开发
npm run dev:web   # 浏览器预览，不连接 dongle
npm test
npm run test:serial-ui  # 总线串口界面 + 内存串口
npm run test:workspace-ui  # 多连接界面 + 本机 TCP + 内存串口
npm run build
npm run dist:win  # Windows x64 免安装单文件
npm run pack:win  # Windows 完整运行目录
npm run smoke:desktop
npm run smoke:portable
```

发布包内置运行时和串口 N-API 预编译模块，Windows x64 无需用户编译 C++。其他平台须各自打包验证，Linux 串口权限与 macOS 签名尚未处理。正式分发前需配置应用签名。

`src/workspace`：连接配置、状态、终端与命令；`electron/connection-manager.cjs`：串口与网络生命周期；`src/probe`：状态、解码、演示、导出；`electron/probe-*`：USB 主机协议；`src/LegacyWorkbench.tsx`：原有工具箱，按需加载。
