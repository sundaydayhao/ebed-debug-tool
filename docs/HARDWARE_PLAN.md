# EBED Probe 硬件方案（设计建议，未实测）

## 定位与首版范围

dongle 是可选的 Wi-Fi 抓包配件，用于硬件套餐增值。软件独立使用与销售；不要求 dongle 同时承担串口、SPI/I²C、逻辑分析和 BLE 的全部日常任务。以下范围为设计目标，硬件与固件仍未交付。

| 模块 | 首版 Wi-Fi 配件 | 后续按需扩展 |
| --- | --- | --- |
| 主控与射频 | ESP32-S3，2.4 GHz Wi-Fi 单信道混杂接收 | BLE 广播扫描单独验证；连接抓包另选接收器 |
| USB | 原生 USB、CDC-ACM、USB-C 数据口、EBP 控制和帧流 | 更高吞吐需求另行评估 |
| 缓存 | 依据真实丢包率和队列压力确定缓存及模组配置 | 不以逻辑分析缓存需求决定首版 BOM |
| 产品化 | 天线布局、ESD、状态指示、唯一序列号、预烧与恢复通路 | 外壳、固件更新与量产测试完善 |
| 数字与工业总线 | 不列为首版 Wi-Fi 配件必选项；UART/Modbus 使用已有接口 | 逻辑采样、SPI/I²C、RS485/CAN 可用独立适配器或扩展板 |

首版固件可以只报告 `features: ["wifi"]`、`logicChannels: 0`、`sampleRates: []`、`maxSamples: 0`、`pinout: {}`。EBP 主机已有对应能力检查，无需虚报串口或逻辑采样能力。

S3 提供 Wi-Fi 2.4 GHz 和 **BLE**，不支持经典蓝牙 BR/EDR。[Espressif 产品页](https://www.espressif.com/en/products/socs/esp32-s3)、[Bluetooth 概述](https://docs.espressif.com/projects/esp-idf/en/v5.2/esp32s3/api-guides/bluetooth.html)。

Wi-Fi 混杂模式能向应用交付管理/数据等帧；回调应快速复制到队列，避免执行 USB 写入或 JSON 编码。[ESP-IDF Sniffer](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/api-guides/wifi-driver/wifi-modes.html)。只接收当前信道，不覆盖 5/6 GHz，不承诺自动解密受保护载荷。

Wi-Fi 与 BLE 共用射频，两个软件任务不等于两个并行接收器。[射频共存说明](https://docs.espressif.com/projects/esp-idf/en/v5.1/esp32s3/api-guides/coexist.html)。

BLE 扫描报告不是完整空口 PDU，通常没有空口 CRC、准确射频信道与连接跟踪。独立 sniffer 可以扩展；Nordic 官方支持 nRF52840 Dongle，但本仓库尚未集成其固件或协议。连接追踪、PHY 与解密限制需单独评估。[Nordic nRF Sniffer](https://www.nordicsemi.com/Products/Development-tools/nRF-Sniffer-for-Bluetooth-LE)。

## 免驱与出厂条件

- 应用 USB 使用 S3 原生 CDC，避免依赖另装 CH340/CP210x 驱动。标明数据接口。
- 正确 CDC 描述符、产品字符串 `EBED Probe`、唯一序列号；生产设备使用合法 VID/PID。
- Windows 根据兼容类 ID 加载 `usbser.sys`；描述符正确时无需自写 INF 或让用户安装 SDK。[Microsoft USB serial driver](https://learn.microsoft.com/en-us/windows-hardware/drivers/usbcon/usb-driver-installation-based-on-compatible-ids)。
- 应用 CDC 与 ROM 下载/USB Serial-JTAG 要区分。内置 PHY 的复用方式须在设计时确定，不能假定所有 USB/JTAG 功能同时运行。
- 出厂预烧、保留 Boot/Reset 恢复通路。签名更新与回滚为后续功能，当前没有自动刷写固件。

## 后续数字接口扩展：电气与引脚

D0–D7 是逻辑探头编号，实际 GPIO 随板卡修订版映射。避免占用 USB GPIO19/20、模组存储引脚和启动绑定位。PCB 尚未定稿，不强制指定实际 GPIO。

建议提供 GND、VTref、D0–D7。上电/断开/超时默认高阻；VTref 是目标参考电压，不等于目标供电输出。1.8/3.3 V 支持取决于前端电平转换器，不可由 GUI 虚构。S3 GPIO 不直接接 5 V，USB/探头应有 ESD、过压和电流保护。

I²C 必须有开漏和适当上拉，SPI 明确 CLK/MOSI/MISO/CS，UART 与目标交叉连接。RS485 经收发器，DE/RE 与发送移位完成由固件控制；端接/偏置按拓扑选择。共地或隔离方案按目标系统确定。

## 后续逻辑扩展：带宽与采样

S3 USB Full Speed 线路速率 12 Mbit/s，实际应用吞吐更低。[S3 资料](https://documentation.espressif.com/esp32-s3-mini-1_mini-1u_datasheet_en.html)、[USB 设备栈](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32s3/api-reference/peripherals/usb_device.html)。

| 模式 | 原始数据量 | 结论 |
| --- | --- | --- |
| 8 通道 × 1 MSa/s，1 byte/sample | 1 MB/s，8 Mbit/s | 接近 USB FS 范围；EBP/1 JSON 后不可承诺持续流 |
| 8 通道 × 10 MSa/s | 10 MB/s，80 Mbit/s | 超过 S3 USB 线路能力 |
| 32,768 点 × 8 通道 @ 1 MSa/s | 32 KiB，32.768 ms | 先缓存再上传，适合短时单次捕获 |

首版不承诺采样率。需同步外设/DMA 或独立采样芯片；FreeRTOS 轮询 GPIO 不是精确 MHz 分析仪。触发、通道、速率、深度经实测后写入能力。演示的 8 通道和 1/2 MSa/s 只供验证界面。

持续数十 MHz 需要采样协处理器/FPGA + 缓存 + 高速 USB。RLE 可压缩低变化率信号，但不能代替最坏情况预算。

## 实施与验收

首版配件：CDC/EBP 控制 → Wi-Fi 混杂队列与帧元数据 → USB 批量传输/丢包统计 → 断开和心跳超时停止采集 → 恢复通路、出厂预烧、量产测试。

首版验收：干净 Windows 插入识别；拔线/休眠；错误固件拒绝；当前信道与 RSSI/原始帧长度；丢包计数；长时间抓包；导出可解析的 PCAPNG。该验收独立于软件普通串口、网络与离线分析的发布验收。

后续 BLE、逻辑与总线扩展分别验证广播语义、采样时基、UART 时钟、SPI 四模式、I²C ACK/NACK/时钟拉伸、RS485 DE 收尾与高阻恢复。软件单元测试不能替代这些硬件验收。
