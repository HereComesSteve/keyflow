妙享科技（深圳）有限公司

# MX-02P 一主四从透传 模块使用手册

Ver 0.0.3 

![image](https://cdn-mineru.openxlab.org.cn/result/2026-09-01/e174d823-ae1a-45f4-80ab-ccbb84a36d1e/9f3ee897483992ee7b5b96f81334d5b3f7983f0bb09ca09720545e30fbd163a5.jpg)


![image](https://cdn-mineru.openxlab.org.cn/result/2026-09-01/e174d823-ae1a-45f4-80ab-ccbb84a36d1e/ba6eda499663db535ecbc5c37893c79fbc6ff3a458e04acf50936725cec4d762.jpg)


Part Number:MX-02P 

## 版本历史:

<table><tr><td>版本号</td><td>发布日期</td><td>修订人</td><td>审核</td><td>说明</td></tr><tr><td>V0.0.1</td><td>2025.6.06</td><td>鲁奕星</td><td>洪德骏</td><td>初始版本</td></tr><tr><td>V0.0.2</td><td>2025.6.20</td><td>鲁奕星</td><td>洪德骏</td><td>新增了三条 AT 指令,详细内容请前往 AT 指令集查看</td></tr><tr><td>V0.0.3</td><td>2025.6.26</td><td>鲁奕星</td><td>洪德骏</td><td>修改了 link 脚的功能描述</td></tr></table>

注：

由于随着产品的硬件及软件的不断改进，本文档可能会有所更改，恕不另行告知，最终应以最新版的文档为准。

最新资料请移步至官网：www.newbitinfo.com 下载，或直接联系我司获取

本模块封装没有上传至嘉立创,请使用我们提供的模块封装!!!

## 目录

概述....2
模块特性....2
硬件特性....2
软件特性....2
模块出厂默认参数配置....3
封装尺寸脚位定义....3
模组封装尺寸....5
电气特性....5
AT指令集....6
AT指令详细说明....7
查询蓝牙模组地址码....7
设置蓝牙模组MAC地址....7
设置设备名称....7
查询设备名称....7
设置广播状态....8
查询广播状态....8
设置串口波特率....8
查询串口波特率....8
断开蓝牙连接....9
查询当前已连接的设备....9
修改广播间隔....9
查询广播间隔....10
读取软件版本....10
恢复出厂设置....10
软件复位....10
修改模组的发射功率....11
查询模组的发射功率....11
设置BLE主服务通道....11
查询BLE主服务通道....12
设置BLE读服务通道....12
查询BLE读服务通道....12
设置BLE写服务通道....13
查询BLE写服务通道....13
设置自定义广播数据....13
查询自定义广播数据....13
设置蓝牙扫描状态....14
连接指定MAC地址设备....14
保存设置自动重连MAC列表....15
自动重连设置....15
删除自动重连列表....16
扫描蓝牙自定义广播数据....16
设置蓝牙模组广播状态....17
设置蓝牙模组广播名称....17
设置蓝牙模组自定义广播数据....17
BLE协议说明(APP接口)....17
模块布局参考建议....18

妙享科技（深圳）有限公司

贴片生产注意事项....19
联系我们....19

## 概述

## 模块特性

MX-02P 模组是基于新一代蓝牙 SOC 芯片开发的低功耗蓝牙模组，具备快速开发的便捷性。该模块基于蓝牙智能固件与协议栈的支持，实现了与蓝牙 V5.3（Low Energy，LE 模式）协议的完全兼容性。此外，用户可利用芯片内置的 ARM Cortex-M4 嵌入式 32 位高性能单片机，开发各类应用程序。其主要应用领域包括智能穿戴设备、便携式医疗设备、运动健身设备、智能家居、消费电子产品以及工业控制系统等，能够满足低功耗、低时延、近距离无线数据通信的需求。MX-02P 透传模块为开发者提供了便利，使其无需深入了解低功耗蓝牙协议，即可通过类似串口通信的方式，开发支持低功耗蓝牙通信的智能产品。

本文档是 MX-02P 透传模块的使用说明文档，包括模块的主要功能、应用场景、使用方法、逻辑结构、硬件接口及各项指标特性。

## 硬件特性

模组封装：12mm*16.2mm（邮票孔）-18PIN

➢ 工作频段：2400MHz ~ 2483.5MHz

调制方式：GFSK

➢ 频偏：±20kHz

➢ 发射功率：-36dbm ~ +4dbm

➢ 接收灵敏度：支持最高-93dBm 接收灵敏度（1Mbps）

支持最高-90dBm 接收灵敏度（2Mbps）

数据接口：Uart

支持内部 RTC 实时时钟

超低功耗：功耗测试

➢ 工作电压：1.8V ~ 3.6V

➢ 工作温度： $-40^{\circ}C \sim +85^{\circ}C$ 

## 软件特性

支持全功能 BT5.3 协议

串口透明传输，无需任何蓝牙协议栈应用经验；

➢ 支持配合客户需求，量身定制专属软件；CPU 主频高达 64MHz，接口资源丰富

➢ 支持 AT 指令，丰富的指令集用于配置模块参数。

➢ 支持 AT 指令软件复位模组，获取 MAC 地址；

➢ 支持 AT 指令修改广播间隔，修改串口波特率，修改模组名；

支持连接四个从机的同时被一个主机连接。


模块出厂默认参数配置


<table><tr><td>参数</td><td>默认值</td></tr><tr><td>串口配置</td><td>115200bps</td></tr><tr><td>模块名称</td><td>NB-(MAC 地址)</td></tr><tr><td>广播间隔</td><td>200mS</td></tr><tr><td>连接间隔</td><td>30mS</td></tr><tr><td>发射功率</td><td>0dbm</td></tr><tr><td>BLE 主服务、读、写通道</td><td>FFF0/FFF1/FFF2</td></tr><tr><td>连接串口响应</td><td>+CONNECTED:TYPE, MAC\r\nTYP=1 表示连接设备为主端连接设备MAC 为连接设备对应的 MAC 地址\r\n 为 ASCII 码 0x0d 及 0x0a</td></tr><tr><td>断开连接串口响应</td><td>+DISCONN:TYPE, MAC\r\n</td></tr></table>

## 封装尺寸脚位定义

![image](https://cdn-mineru.openxlab.org.cn/result/2026-09-01/e174d823-ae1a-45f4-80ab-ccbb84a36d1e/73f1fa95a0f1965e6c3f638664d07f18dabfa619249e910feef1a5b2d0efc008.jpg)



图 1-模块引脚图



MX-02P 引脚定义


<table><tr><td>模块引脚序号</td><td>模块脚位名称</td><td>芯片脚位名称</td><td>输入/输出</td><td>功能说明</td></tr><tr><td>Pin1</td><td>ANT</td><td>ANT</td><td>-</td><td>外置天线引脚</td></tr><tr><td>Pin2</td><td>NND</td><td>GND</td><td>-</td><td>模组地 GND</td></tr><tr><td>Pin3</td><td>NC</td><td>P23</td><td>-</td><td>保留</td></tr><tr><td>Pin4</td><td>NC</td><td>P22</td><td>-</td><td>保留</td></tr><tr><td>Pin5</td><td>CDS</td><td>P21</td><td>I</td><td>低电平:不识别 AT 指令,所有数据都识别为透传数据;高电平:自动识别 AT 指令及透传数据。</td></tr><tr><td>Pin6</td><td>LINK</td><td>P01</td><td>0</td><td>连接状态指示引脚高电平:蓝牙未连接 低电平:蓝牙已连接</td></tr><tr><td>Pin7</td><td>I05</td><td>P00</td><td>I/O</td><td>保留</td></tr><tr><td>Pin8</td><td>RX</td><td>P07</td><td>I</td><td>UART 串口 RX 引脚</td></tr><tr><td>Pin9</td><td>TX</td><td>P08</td><td>0</td><td>UART 串口 TX 引脚</td></tr><tr><td>Pin10</td><td>VCC</td><td>VCC</td><td>-</td><td>模组电源引脚 3.3V</td></tr><tr><td>Pin11</td><td>GND</td><td>GND</td><td>-</td><td>模组地 GND</td></tr><tr><td>Pin12</td><td>RXD</td><td>P05</td><td>I/O</td><td>烧录串口</td></tr><tr><td>Pin13</td><td>TXD</td><td>P04</td><td>I/O</td><td>烧录串口</td></tr><tr><td>Pin14</td><td>复位引脚</td><td>RES</td><td>I</td><td>模组复位,低电平有效</td></tr><tr><td>Pin15</td><td>烧录使能引脚</td><td>BOOT</td><td>I</td><td>烧录使能引脚,低电平有效</td></tr><tr><td>Pin16</td><td>BRTS</td><td>P03</td><td>I</td><td>睡眠引脚高电平或悬空:模组进入睡眠模式低电平:模组退出睡眠模式如果不需要低功耗,可以直接接地在睡眠模式下,模组串口只能收数据,不能发数据MCU 可以通过 GPIO 控制模组进入或退出睡眠模式。</td></tr><tr><td>Pin17</td><td>NC</td><td>P02</td><td>-</td><td>保留</td></tr><tr><td>Pin18</td><td>NC</td><td>NC</td><td>-</td><td>保留</td></tr></table>

## 模组封装尺寸

模块为邮票半孔封装，如图 2 为模块尺寸。

![image](https://cdn-mineru.openxlab.org.cn/result/2026-09-01/e174d823-ae1a-45f4-80ab-ccbb84a36d1e/99e4f1cf4e21211e0f789eaffc88903f4a6a7f3ac95110e10346513ced1ff084.jpg)



图 2-模块尺寸图


![image](https://cdn-mineru.openxlab.org.cn/result/2026-09-01/e174d823-ae1a-45f4-80ab-ccbb84a36d1e/1de5b07e8b18f4c0d54f703a575578700dfa57b8f695d47cbe03daa1194420c8.jpg)


## 电气特性


绝对最大额定值


<table><tr><td>参数</td><td>最小值</td><td>最大值</td><td>单位</td></tr><tr><td>存储温度</td><td>-40</td><td>+105</td><td>°C</td></tr><tr><td>VDD</td><td>-0.3</td><td>3.9</td><td>V</td></tr><tr><td>其它管脚</td><td>-0.2</td><td>VDD+0.3≤3.9</td><td>V</td></tr></table>

## 推荐运行条件

<table><tr><td>参数</td><td>最小值</td><td>推荐值</td><td>最大值</td><td>单位</td></tr><tr><td>工作温度</td><td>-40</td><td>—</td><td>+85</td><td>°C</td></tr><tr><td>VDD</td><td>1.8</td><td>3.3</td><td>3.6</td><td>V</td></tr></table>

## AT 指令集

<table><tr><td>指令</td><td>指令描述</td></tr><tr><td>AT+MAC?\r\n</td><td>查询模块 MAC 地址</td></tr><tr><td>AT+MAC=MAC\r\n</td><td>设置模组 MAC 地址</td></tr><tr><td>AT+NAME=string\r\n</td><td>设置设备名称</td></tr><tr><td>AT+NAME?\r\n</td><td>查询设备名称</td></tr><tr><td>AT+ADV=NUM\r\n</td><td>设置广播状态</td></tr><tr><td>AT+ADV?\r\n</td><td>查询广播状态</td></tr><tr><td>AT+UART=NUM\r\n</td><td>设置波特率</td></tr><tr><td>AT+UART?\r\n</td><td>查询模组串口波特率</td></tr><tr><td>AT+DISCONN=NUM\r\n</td><td>断开蓝牙连接</td></tr><tr><td>AT+DEV?\r\n</td><td>查询当前已连接的设备</td></tr><tr><td>AT+AINTVL=NUM\r\n</td><td>修改广播间隔</td></tr><tr><td>AT+AINTVL?\r\n</td><td>查询广播间隔</td></tr><tr><td>AT+VER?\r\n</td><td>查询软件版本</td></tr><tr><td>AT+RESET=1\r\n</td><td>恢复出厂设置</td></tr><tr><td>AT+REBOOT=1\r\n</td><td>设置模组重启</td></tr><tr><td>AT+TXPOWER=NUM\r\n</td><td>修改模组的发射功率</td></tr><tr><td>AT+TXPOWER?</td><td>查询模组当前发射功率</td></tr><tr><td>AT+UUIDS=UUID\r\n</td><td>设置 BLE 主服务通道</td></tr><tr><td>AT+UUIDS?\r\n</td><td>查询 BLE 主服务通道</td></tr><tr><td>AT+UUIDN=UUID\r\n</td><td>设置 BLE 读服务通道</td></tr><tr><td>AT+UUIDN?\r\n</td><td>查询 BLE 读服务通道</td></tr><tr><td>AT+UUIDW=UUID\r\n</td><td>设置 BLE 写服务通道</td></tr><tr><td>AT+UUIDW?\r\n</td><td>查询 BLE 写服务通道</td></tr><tr><td>AT+AMDATA=HEX\r\n</td><td>设置自定义广播数据</td></tr><tr><td>AT+AMDATA?\r\n</td><td>查询自定义广播数据</td></tr><tr><td>AT+SCAN=\r\n</td><td>查询扫描蓝牙 4.0 BLE 设备</td></tr><tr><td>AT+CONN=\r\n</td><td>主动连接查询到的蓝牙 4.0 BLE 设备</td></tr><tr><td>AT+AUTO_CFG=X\r\n</td><td>自动重连设置</td></tr><tr><td>AT+AUTO_DEL\r\n</td><td>删除自动重连列表</td></tr><tr><td>AT+AUTO_MAC=\r\n</td><td>保存设置自动重连 MAC 列表</td></tr><tr><td>AT+SCAN_MANU=1\r\n</td><td>扫描查询附近蓝牙设备的广播自定义数据</td></tr><tr><td>AT+ADV_TMP=NUM\r\n</td><td>设置广播状态(立即生效,但设置内容掉电不保存)</td></tr><tr><td>AT+NAME_TMP=string\r\n</td><td>设置广播名称(立即生效,但设置内容掉电不保存)</td></tr><tr><td>AT+AMDATA_TMP=HEX\r\n</td><td>设置自定义广播数据(立即生效,但设置内容掉电不保存)</td></tr></table>


备注：\r\n为ASCII码0x0d及0x0a;



上电或重启成功的串口提示（+READY\r\n），HOST MCU 必须在收到此消息后，才能执行指令和数传的操作。


## AT 指令详细说明

## 查询蓝牙模组地址码

指令描述：查询蓝牙模组地址码

读/写：只读

指令代码：AT+MAC?\r\n

支持参数：N/A

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td>R</td><td>AT+MAC?\r\n</td><td>+MAC:000102030405\r\n</td><td>返回本机蓝牙地址码:00:01:02:03:04:05。</td></tr></table>

## 设置蓝牙模组 MAC 地址

指令描述：设置蓝牙模组地址码，重启后生效。

读/写：只写

指令代码：AT+MAC=MAC\r\n

支持参数：000000000000-FFFFFFFFFFFF

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td rowspan="2">W</td><td rowspan="2">AT+MAC=MAC\r\n</td><td>+MAC:OK\r\n</td><td>设置蓝牙 MAC 地址成功</td></tr><tr><td>+MAC:ERROR\r\n</td><td>设置蓝牙 MAC 地址失败</td></tr></table>

## 设置设备名称

指令描述：设置设备名称，立即生效。

读/写：只写

指令代码：AT+NAME=string\r\n

支持参数：用户自定义，总长度不超过 20 字节

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td rowspan="2">W</td><td rowspan="2">AT+NAME=string\r\n</td><td>OK\r\n</td><td>设置成功</td></tr><tr><td>ERROR\r\n</td><td>设置失败</td></tr></table>

## 查询设备名称

指令描述：查询设备名称

读/写：只读

指令代码：AT+NAME?\r\n

妙享科技（深圳）有限公司

支持参数：N/A

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td>R</td><td>AT+NAME?\r\n</td><td>+NAME: string\r\n</td><td>string 为当前 BLE 设备名称</td></tr></table>

## 设置广播状态

指令描述：设置设备蓝牙广播状态，立即生效。

读/写：只写

指令代码：AT+ADV=NUM\r\n

支持参数：0-关闭广播 1-开启广播

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td rowspan="2">W</td><td rowspan="2">AT+ADV=NUM\r\n</td><td>OK\r\n</td><td>设置成功</td></tr><tr><td>ERROR\r\n</td><td>设置失败</td></tr></table>

## 查询广播状态

指令描述：查询设备蓝牙广播状态.

读/写：只读

指令代码：AT+ADV?\r\n

支持参数：N/A

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td>R</td><td>AT+ADV?\r\n</td><td>+ADV: X\r\n</td><td>X=0 设备广播已关闭X=1 设备广播已开启</td></tr></table>

## 设置串口波特率

指令描述：设置设备波特率

读/写：只写

指令代码：AT+UART=NUM\r\n

支持参数：0:9600/1:14400/2:19200/3:38400/4:57600/5:115200/6:230400/7:460800/8:921600

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td rowspan="2">W</td><td rowspan="2">AT+UART=NUM\r\n</td><td>OK\r\n</td><td>设置成功</td></tr><tr><td>ERROR\r\n</td><td>设置失败</td></tr></table>

## 查询串口波特率

指令描述：查询设备串口波特率。

妙享科技（深圳）有限公司

读/写：只读

指令代码：AT+UART?\r\n

支持参数：N/A

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td>R</td><td>AT+UART?\r\n</td><td>+UART: NUM\r\n</td><td>0:9600; 1:14400;2:19200; 3:38400;4:57600; 5:115200;</td></tr></table>

## 断开蓝牙连接

指令描述：断开蓝牙连接

读/写：只写

指令代码：AT+DISCONN=NUM\r\n

支持参数：0-断开所有连接的从设备 1-主动断开与主机端设备的连接

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td>W</td><td>AT+DISCONN=NUM\r\n</td><td>+DISCONN: CONN TYP, MAC\r\n</td><td>CONN TYP=1 表示连接设备为主端连接设备MAC为连接设备对应的MAC地址本机与MAC设备断开连接</td></tr></table>

## 查询当前已连接的设备

指令描述：查询当前已连接的设备

读/写：只读

指令代码：AT+DEV?\r\n

支持参数：N/A

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td>R</td><td>AT+DEV?\r\n</td><td>+DEV:CONN TYP, MAC\r\n...</td><td>CONN TYP=1 表示连接设备为主端连接设备MAC 为连接设备对应的 MAC 地址</td></tr></table>

## 修改广播间隔

指令描述：修改广播间隔，重启后生效。

读/写：只写

指令代码：AT+AINTVL=NUM\r\n

支持参数：20-10000 单位毫秒

设置/响应：

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td rowspan="2">W</td><td rowspan="2">AT+AINTVL=NUM\r\n</td><td>OK\r\n</td><td>设置成功</td></tr><tr><td>ERROR\r\n</td><td>设置失败</td></tr></table>

## 查询广播间隔

指令描述：查询广播间隔

读/写：只读

指令代码：AT+AINTVL?

支持参数：N/A

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td>R</td><td>AT+AINTVL?\r\n</td><td>+AINTVL:NUM\r\n</td><td>读取参数的单位为毫秒</td></tr></table>

## 读取软件版本

指令描述：读取软件版本

读/写：只读

指令代码：AT+VER?\r\n

支持参数：N/A

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td>R</td><td>AT+VER?\r\n</td><td>+VER:V0.0.1\r\n</td><td>V0.0.1是软件版本号</td></tr></table>

## 恢复出厂设置

指令描述：设置恢复出厂设置，该指令重启生效，MAC 地址修改后不可恢复。

读/写：只写

指令代码：AT+RESET=1\r\n

支持参数：1

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td rowspan="2">W</td><td rowspan="2">AT+RESET=1\r\n</td><td>OK\r\n</td><td>设置成功</td></tr><tr><td>ERROR\r\n</td><td>设置失败</td></tr></table>

## 软件复位

指令描述：设置模组重启。

读/写：只写

妙享科技（深圳）有限公司

指令代码：AT+REBOOT=1\r\n

支持参数：1

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td rowspan="2">W</td><td rowspan="2">AT+REBOOT=1\r\n</td><td>OK\r\n+READY\r\n</td><td>设置成功</td></tr><tr><td>ERROR\r\n</td><td>设置失败</td></tr></table>

## 修改模组的发射功率

指令描述：设置模组的发射功率，重启后生效。

读/写：只写

指令代码：AT+TXPOWER=NUM\r\n

支持参数：-43/ -38/ -33/ -30/ -25/ -20/ -16/ -10/ -8/ -6/ -5/ -4/ -3/ -1/ 0/ 2/ 4/ 6/ 7/ 8/ 9/ 10

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td rowspan="2">W</td><td rowspan="2">AT+TXPOWER=NUM\r\n</td><td>OK\r\n</td><td>设置成功</td></tr><tr><td>ERROR\r\n</td><td>设置失败</td></tr></table>


备注：模块实际发射功率区间：-18dbm~4dbm 当参数小于-16时模块发射功率为-18dbm，当参数大于4时，模块发射功率为4dbm


## 查询模组的发射功率

指令描述：查询当前发射功率

读/写：只读

指令代码：AT+TXPOWER?

支持参数：N/A

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td>R</td><td>AT+TXPOWER?\r\n</td><td>+TXPOWER:NUM\r\n</td><td>读取参数为代号</td></tr></table>

## 设置 BLE 主服务通道

指令描述：设置 BLE 主服务通道，重启后生效。

读/写：只写

指令代码：AT+UUIDS=UUID\r\n

支持参数：16bit 格式或 128bit 格式的 UUID

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td rowspan="2">W</td><td rowspan="2">AT+UUIDS=UUID\r\n</td><td>OK\r\n</td><td>设置成功</td></tr><tr><td>ERROR\r\n</td><td>设置失败</td></tr></table>

备注：16bit 格式 UUID 示例：FFFO

128bit 格式 UUID 示例：11223344556677889900112233445566

## 查询 BLE 主服务通道

指令描述：查询 BLE 主服务通道

读/写：只读

指令代码：AT+UUIDS?\r\n

支持参数：N/A

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td>R</td><td>AT+UUIDS?\r\n</td><td>+UUIDS:UUID\r\n</td><td>UUID 取值,16bit 格式或 128bit 格式的 UUID</td></tr></table>

## 设置 BLE 读服务通道

指令描述：设置 BLE 读服务通道，重启后生效。

读/写：只写

指令代码：AT+UUIDN=UUID\r\n

支持参数：16bit 格式或 128bit 格式的 UUID

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td rowspan="2">W</td><td rowspan="2">AT+UUIDN=UUID\r\n</td><td>OK\r\n</td><td>设置成功</td></tr><tr><td>ERROR\r\n</td><td>设置失败</td></tr></table>


备注：16bit 格式 UUID 示例：FFF1


128bit 格式 UUID 示例：11223344556677889900112233445566

## 查询 BLE 读服务通道

指令描述：查询 BLE 读服务通道

读/写：只读

指令代码：AT+UUIDN?\r\n

支持参数：N/A

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td>R</td><td>AT+UUIDN?\r\n</td><td>+UUIDN:UUID\r\n</td><td>UUID 取值,16bit 格式或 128bit 格式的 UUID</td></tr></table>

## 设置 BLE 写服务通道

指令描述：设置 BLE 写服务通道，重启后生效。

读/写：只写

指令代码：AT+UUIDW=UUID\r\n

支持参数：16bit 格式或 128bit 格式的 UUID

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td rowspan="2">W</td><td rowspan="2">AT+UUIDW=UUID\r\n</td><td>OK\r\n</td><td>设置成功</td></tr><tr><td>ERROR\r\n</td><td>设置失败</td></tr></table>


备注：16bit 格式 UUID 示例：FFF2


128bit 格式 UUID 示例：11223344556677889900112233445566

## 查询 BLE 写服务通道

指令描述：查询 BLE 写服务通道

读/写：只读

指令代码：AT+UUID?\r\n

支持参数：N/A

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td>R</td><td>AT+UUIDW?\r\n</td><td>+UUIDW:UUID\r\n</td><td>UUID 取值,16bit 格式或 128bit 格式的 UUID</td></tr></table>

## 设置自定义广播数据

指令描述：设置自定义广播数据

读/写：只写

指令代码：AT+AMDATA=HEX\r\n

支持参数：用户自定义，HEX 为 0-29 字节长度的 HEX 数值，如设置广播数据为 5 个字节 “12345”，则对应格为 “AT+AMDATA=3132333435\r\n”

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td rowspan="2">W</td><td rowspan="2">AT+AMDATA=HEX\r\n</td><td>OK\r\n</td><td>设置成功</td></tr><tr><td>ERROR\r\n</td><td>设置失败</td></tr></table>

## 查询自定义广播数据

指令描述：查询自定义广播数据

读/写：只读

指令代码：AT+AMDATA?\r\n

妙享科技（深圳）有限公司

支持参数：N/A

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td>R</td><td>AT+AMDATA?\r\n</td><td>+AMDATA:HEX\r\n</td><td>设置成功</td></tr></table>


备注：自定义广播数据是存放在 BLE 广播协议里的 Manufacturer Specific Data 字段内。默认的广播数据为 8 个字节，前两个字节固定为 00 00，后 6 个字节为模块的 MAC 地址 (高字节在前)。


## 设置蓝牙扫描状态

指令描述：设置蓝牙扫描状态

读/写：只写

指令代码：AT+SCAN=<NUM> \r\n

支持参数：0-立即关闭扫描功能

1-开启扫描功能（扫描持续时间为 6S，6S 后停止扫描）。

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td>W</td><td>AT+SCAN=1\r\n</td><td>+SCAN:\r\n空格空格空格\r\n...+SCAN END\r\n</td><td></td></tr></table>


备注：扫描附近蓝牙设备，返回数据以“+SCAN:\r\n”开头，以“+SCAN END\r\n”结尾；中间重复


多条设备信息：<mac>空格<MAC TYP>空格<rssi>空格<DEVICE NAME>\r\n，扫描设备信息包括：MAC 地址、地址类型、RSSI 值、广播名称。（有些设备没有广播名称，所以扫描信息可能只有 MAC 地址，地址类型和 RSSI 值），<MAC TYP>地址类型，0-静态地址 1-随机地址

返回：+SCAN:\r\n，表示开启扫码。

返回：001B10F4DA0B 1 -35 NBEE\r\n，获取到的设备信息为 MAC 地址为 00:1B:10:F4:DA:OB，地址类型为随机

地址，RSSI 为-35dbm，设备名称为 NBEE。

返回：+SCAN END\r\n，表示停止扫码。

## 连接指定 MAC 地址设备

指令描述：设置蓝牙扫描状态

读/写：只写

指令代码：AT+CONN=<MAC>,<MAC TYP> \r\n

支持参数：000000000000-FFFFFFFFFFFF

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td>W</td><td>AT+CONN=,\r\n</td><td>+SCAN:\r\n空格空格空格\r\n...</td><td>成功连接地址类型为的目标设备,地址类型,0-静态地址1-随机地</td></tr></table>


妙享科技（深圳）有限公司


TEL:0755-23320814 

<table><tr><td rowspan="3"></td><td rowspan="3"></td><td>+SCAN END\r\n</td><td>址,值为0时,输入TYP参数可缺省,即输AT+CONN=\\r\n即可</td></tr><tr><td>+CONNECT TIMEOUT\r\n</td><td>连接超时</td></tr><tr><td>ERROR\r\n</td><td>MAC地址格式有误,连接失败</td></tr></table>

## 保存设置自动重连 MAC 列表

指令描述：保存设置自动重连 MAC 列表

读/写：只写

指令代码：AT+AUTO_MAC=<MAC>,<MAC TYP>\r\n

支持参数：000000000000-FFFFFFFFFFFF

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td rowspan="2">W</td><td rowspan="2">AT+AUTO_MAC=,\r\n</td><td>OK\r\n</td><td>使用 MAC 地址方式自动连接一个从设备,并且保存(只设置保存,不发起连接),地址类型,0-静态地址 1-随机地址,值为 0 时,输入 TYP 参数可缺省,即输入 AT+AUTO_MAC=\r\n即可</td></tr><tr><td>ERROR\r\n</td><td>设置失败</td></tr></table>


备注：支持保存四个自动重连设备的 MAC 地址


## 自动重连设置

指令描述：自动重连设置

读/写：只写

指令代码：AT+AUTO_CFG=<NUM>\r\n

支持参数：0：关闭自动重连

1: 开启自动重连

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td rowspan="2">R</td><td rowspan="2">AT+AUTO_CFG=\r\n</td><td>OK\r\n</td><td>设置成功</td></tr><tr><td>ERROR\r\n</td><td>设置失败</td></tr></table>

## 删除自动重连列表

指令描述：删除自动重连列表

读/写：只写

指令代码：AT+AUTO_DEL\r\n

支持参数：N/A

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td rowspan="2">W</td><td rowspan="2">AT+AUTO_DEL\r\n</td><td>OK\r\n</td><td>删除自动连接保存的所有 MAC 地址</td></tr><tr><td>ERROR\r\n</td><td>设置失败</td></tr></table>

## 扫描蓝牙自定义广播数据

指令描述：扫描蓝牙自定义广播内容

读/写：只写

指令代码：AT+SCAN_MANU=1\r\n

支持参数：1

设置/响应：

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td>W</td><td>AT+SCAN_MANU=1\r\n</td><td>+SCAN_MANU:\r\n空格空格空格\n...+SCAN END\r\n</td><td></td></tr></table>

## 设置蓝牙模组广播状态

指令描述：查询蓝牙模组第一个广播状态

读/写：只写读

指令代码：AT+ADV_TMP=NUM\r\n

支持参数：0-关闭广播 1-开启广播

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td rowspan="2">W</td><td rowspan="2">AT+ADV_TMP=NUM\r\n</td><td>OK\r\n</td><td>设置成功</td></tr><tr><td>ERROR\r\n</td><td>设置失败</td></tr></table>

## 设置蓝牙模组广播名称

指令描述：设置蓝牙模组第一个广播名称

读/写：只写

指令代码：AT+NAME_TMP=string\r\n

支持参数：用户自定义，总长度不超过 20 字节

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td rowspan="2">W</td><td rowspan="2">AT+NAME_TMP=NUM\r\n</td><td>OK\r\n</td><td>设置成功</td></tr><tr><td>ERROR\r\n</td><td>设置失败</td></tr></table>

## 设置蓝牙模组自定义广播数据

指令描述：设置蓝牙模组第一个自定义广播数据

读/写：只写

指令代码：AT+AMDATA_TMP=HEX\r\n

支持参数：用户自定义，HEX为0-29字节长度的HEX数值，如设置广播数据为5个字节“12345”，则对应格为“AT+AMDATA_TMP=3132333435\r\n”

设置/响应:

<table><tr><td>读/写</td><td>指令格式</td><td>响应</td><td>备注</td></tr><tr><td rowspan="2">W</td><td rowspan="2">AT+AMDATA_TMP=HEX\r\n</td><td>OK\r\n</td><td>设置成功</td></tr><tr><td>ERROR\r\n</td><td>设置失败</td></tr></table>

## BLE 协议说明(APP 接口)

透传数据通道【服务 UUID: 0xFFFO】

妙享科技（深圳）有限公司

![image](https://cdn-mineru.openxlab.org.cn/result/2026-09-01/e174d823-ae1a-45f4-80ab-ccbb84a36d1e/b6e383ca6fc7cd76c9e077f75eece4811a48cffa17930ff39b64d7a57dfa7349.jpg)


<table><tr><td>特征值 UUID</td><td>可执行的操作</td><td>默认值</td><td>备注</td></tr><tr><td>0xFFFF2</td><td>Write</td><td>无</td><td>写入的数据将会从串口 TX 输出</td></tr><tr><td>0xFFFF1</td><td>Notify</td><td>无</td><td>从串口 RX 输入的数据将会在此通道产生通知发给移动设备</td></tr></table>


说明：APP 通过 0xFFFF2 通道 将数据发送给 MCU：MCU 通过 0xFFFF1 通道将数据发送给 APP，用户也可通过 AT 指令对读写通道进行自定义。


## 模块布局参考建议

![image](https://cdn-mineru.openxlab.org.cn/result/2026-09-01/e174d823-ae1a-45f4-80ab-ccbb84a36d1e/02b638270deb998d22ef61bd686e6503c7ec832c2578779e4abdd6885e603e71.jpg)



Recommended location in X-Y plane



图 3-模块布局参考示意图


模块天线远离其他电路，下方不走线、不铺铜。

➢ 用户最终产品外壳靠近天线部分不能采用金属材质(包括含金属颗粒涂料的喷涂)。

模块的接入电源建议使用磁珠进行隔离。

请检查电源稳定性，电压不能大幅频繁波动。

➢ 器件接地要良好，减少寄生电感。

## 贴片生产注意事项

用户批量贴片时，回流焊温度不要超过 $245^{\circ}$ C，请参考图 4 温度曲线。

![image](https://cdn-mineru.openxlab.org.cn/result/2026-09-01/e174d823-ae1a-45f4-80ab-ccbb84a36d1e/c89b31ff1772a92d503348825a9030c4a5216422584bdc5e64fca850c5165b4b.jpg)



图 4-部件的焊接耐热性温度曲线(焊接点)


## 联系我们

妙享科技（深圳）有限公司

Tel: 0755-2332 0814 

地址：深圳市龙岗区布吉街道慢城四期1栋B座26F

Add:26F, Block B, 1, Slow City IV, Buji Street, Longgang District, Shenzhen 