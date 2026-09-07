# EBP/1 USB 应用协议

状态：主机实现与模拟传输测试可用，设备固件待实现。此协议不是 ESP32 ROM 或透明串口协议。代码真值为 `electron/probe-protocol.cjs`、`electron/probe-manager.cjs` 与 `src/probe/types.ts`。

普通串口模式不使用本协议，不发送 hello 或心跳，也不依赖任何 EBED 固件。主机通过 DeviceHub 显式选择传输方式。共享 UI 类型中 protocol 为 null 只表示主机提供的普通串口能力；EBP 固件 hello 中 protocol 必须为 1。

## 分帧

USB CDC-ACM，主机 line coding 为 115200/8N1，无硬件流控。原生 USB CDC 的吞吐不受 115200 限制，目标 UART 波特率独立设置。

16 字节头 + UTF-8 JSON 对象 + 4 字节 CRC32；多字节数为小端。

| 偏移 | 长度 | 内容 |
| --- | --- | --- |
| 0 | 4 | ASCII `EBP1`，45 42 50 31 |
| 4 | 1 | 版本 1 |
| 5 | 1 | 类型 1 请求 / 2 响应 / 3 事件 |
| 6 | 2 | 保留，必须为 0 |
| 8 | 4 | 无符号序号，响应回显请求序号 |
| 12 | 4 | JSON 字节长度，最多 262144 |
| 16 | N | UTF-8 JSON，无结尾 NUL |
| 16+N | 4 | 头与 JSON 的 CRC32/IEEE |

CRC 反射多项式 `0xEDB88320`，初值/最终 XOR 均为 `0xFFFFFFFF`；`123456789` 的结果 `0xCBF43926`。不能按 USB read 回调边界分帧，必须支持分片/粘包。无效版本、CRC、长度应拒绝并重同步。

EBP/1 优先兼容和易调试，JSON/base64 有编码开销，不是最终高速流协议。将来采用二进制块/信用流控时升级协议版本。

## 命令与生命周期

请求：`{"command":"wifi.start","config":{"channel":6}}`。

响应：`{"ok":true}` 或 `{"ok":false,"error":"资源忙"}`。类型 2，必须回显序号。超时上限 4 秒；固件事务最多 3 秒。ACK 超时后主机断开设备，不能把未知硬件状态当作空闲继续操作。

状态：hello → idle → capture/transfer → idle。一次只运行一项采集或总线事务；固件独立检查能力与资源。start 必须先 ACK 再发事件；stop ACK 前停止旧采集事件。连接不自动驱动 GPIO 或重启上次任务。

主机每秒约一次 `heartbeat`，设备返回 `ok:true`。USB 断开/挂起/CDC 关闭时立即停止输出并恢复高阻；超过 10 秒没有合法控制消息也停止。等待触发期间同样需要心跳。固件事务不得无限阻塞 USB 任务。

## hello

请求：`{"command":"hello","config":{"protocol":1}}`。

首版 Wi-Fi 配件的最小示例响应（字段示例，不是实测规格）：

```json
{
  "ok": true,
  "capabilities": {
    "protocol": 1,
    "model": "EBED Wi-Fi Probe S3 rev.A",
    "serial": "EBED-A-000001",
    "firmware": "0.1.0",
    "features": ["wifi"],
    "wifiChannels": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    "logicChannels": 0,
    "sampleRates": [],
    "maxSamples": 0,
    "pinout": {}
  }
}
```

feature 仅允许 `wifi/ble/logic/uart/spi/i2c/modbus`，未实现就不声明。逻辑后端启用时 `logicChannels` 为 1–8、`sampleRates` 为已验证整数 Hz 列表、`maxSamples` 16–32768；无逻辑后端使用 0/空列表。信道按地区实际允许范围返回，主机不越过该列表。

接线键推荐 UART / SPI / I2C / Modbus / Logic。D0–D7 是探头通道而非 GPIO 编号，真实 GPIO/方向由固件按板卡版本映射。

## 采集命令

| command | config | 行为 |
| --- | --- | --- |
| wifi.start | `{"channel":6}` | 单信道混杂接收；不连接 AP、不发帧 |
| ble.start | `{}` | 被动广播扫描，不连接外设 |
| logic.start | `{"sampleRate":1000000,"sampleCount":2048,"trigger":"rising","triggerChannel":0}` | 单次；触发为 immediate/rising/falling |
| capture.stop | `{}` | 停止当前采集，重复调用应成功 |
| heartbeat | `{}` | 心跳，不改变采集状态 |

逻辑从触发样本开始采集，首版无预触发区；完成后发送一个 logic 事件并回到 idle。触发未发生时等待用户 stop。固件无法提供精确等间隔采样时不得声明该采样率。

## 无线事件

```json
{"type":"packet","protocol":"wifi","timestampUs":12345678,"channel":6,"rssi":-58,"originalLength":3,"data":"gAAA","fcs":false}
```

上例仅示范截短的载荷编码。`data` 为从 802.11 MAC 头开始的原始字节 base64，不含 ESP-IDF 接收结构、USB 包头、Radiotap 或文字。最多 12000 base64 字符；originalLength ≥实际载荷且≤65535。截断时保留原长。只有确实保留末尾 FCS 字节时才设置 fcs=true，不得补零伪造。RSSI 单位 dBm，信道 1–14。

`timestampUs` 为设备启动后单调微秒整数（≤JS safe integer），固件负责展开短计时器回绕。主机以首个事件的主机接收时间对齐 UTC，PCAPNG 的绝对时间含 USB 排队误差。主机添加 Radiotap flags/channel/signal，linktype 127；不编造 MCS、rate、PHY TSFT。

```json
{"type":"packet","protocol":"ble","timestampUs":12350000,"channel":0,"rssi":-61,"address":"d4:32:18:ab:09:10","name":"","originalLength":3,"data":"AgEG"}
```

BLE data 是扫描 API 返回的 AD structures，不是完整链路层 PDU；不伪造 Access Address/CRC/连接数据。name 缺失用空字符串，channel 未知用 0，已知时为 BLE RF 索引。主机导出 JSON 扫描报告，不将 BLE 套入 Wi-Fi PCAP 类型。

## 逻辑、统计、日志

```json
{"type":"logic","timestampUs":2000000,"sampleRate":1000000,"channels":8,"samples":[1,1,3,3,7,7,0,0]}
{"type":"stats","received":12000,"dropped":32}
{"type":"log","message":"采样缓冲区已就绪"}
```

逻辑 samples[i] 的 bit0–bit7 对应 D0–D7，同一整数表示同一时刻所有通道；未启用通道位必须为零。sampleRate 是真实时基，timestampUs 是第一点时间。长度 1–32768 且不超出能力表；断续或丢弃样本应返回错误，不拼成连续波形。

统计为本次 USB 连接以来累计整数。received 是固件接收数，dropped 是固件队列/发送丢弃数，不包括空口未收到的帧。GUI 接收量独立统计，不能推导射频丢包率。日志最长 8192 字符。

## 总线事务

公共参数：hex 为无分隔完整 HEX（≤1024 bytes），readLength 0–1024，timeoutMs 100–3000。成功响应：`{"ok":true,"hex":"EF 40 18","message":"完成"}`，错误返回 ok=false、具体原因。部分读取须说明，不得伪造成功数据。

| command | 附加参数 | 语义 |
| --- | --- | --- |
| uart.transfer | baudRate:115200 | 8N1，发送后最多读 readLength，0 表示只发 |
| spi.transfer | frequency:1000000, mode:0 | 8-bit MSB，CS 低有效，同一次 CS 全双工；读长度必须等于发送字节数，需要时由调用方补 00 |
| i2c.transfer | address:80, frequency:100000 | 7-bit 8–119；发送后重复 START 读取，无读取时 STOP；允许纯读 |
| modbus.transfer | baudRate:9600 | UART 8N1 + RS485 DE/RE；HEX 已有主机 CRC，固件不重复添加 |

主机输入上限：SPI 1 kHz–10 MHz、I²C 10–400 kHz、UART 300–2 Mbaud。它们不是所有板卡可用速率的承诺；固件必须拒绝无法稳定实现的参数。后续将这些范围也加入能力协商。

Modbus 首版预设 FC03，寄存器地址 0-based、从站 1–247、数量 1–125。静默间隔、帧边界、RS485 转向由固件完成，USB 回调边界不是 Modbus 边界。UART/SPI/I²C 命令均需要用户点击后执行。

## 固件兼容测试

hello 分成单字节输入、多请求粘包；CRC/版本/长度错误；未知命令失败；未实现能力不得声明；序号 ACK 关联；start/stop 顺序；USB 拔线、心跳超时高阻恢复；逻辑时基和计时器回绕；事务超时不堵塞 USB。参考仓库 tests 中的协议与解码向量。
