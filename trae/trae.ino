/*
 * ============================================================================
 * Keyflow 智能手套固件（协议重构版 v2）
 *
 * 硬件拓扑：
 *   PC (Web Bluetooth) --BLE--> 蓝牙模块A(从) --UART--> Arduino UNO 主机(左手)
 *        Arduino UNO 主机 --UART(同线)--> 蓝牙模块B(主) --BLE--> 蓝牙模块C --> 从机(右手)
 *
 * 本固件按《蓝牙协议重构意见.md》重构：
 *   1. 帧格式改为 HDLC 风格统一变长帧 [0x7E][LEN][SEQ][DST][CMD][PAYLOAD][CRC16:2 LE]
 *      - 载荷区 0x7E/0x7D 字节填充转义，任何丢字节后最坏丢一帧即可重同步；
 *      - DST 目的节点（PC/主机=0x01、从机=0x02）解决主机 TX 共线广播到模块 A/B 的隔离问题；
 *      - CRC16/CCITT-FALSE 覆盖 LEN..PAYLOAD，全帧强制校验。
 *   2. 命令/响应模型：每条命令产生 ACK/NAK（携带原 SEQ），App 端超时重发；
 *   3. 批量写入会话 WRITE_BEGIN/WRITE_DATA/WRITE_END（块序号 + 独立 ACK + 缺口 GAP 重发）；
 *   4. 校时改为 8 轮 NTP 采样（取 RTT 最小一轮），删除 8000us 魔法常数，握手帧带事务序号；
 *   5. 链路心跳 PING/PONG：主机 5 秒空闲发 PING，连续 3 次无 PONG 判定从机断链并上报；
 *   6. 蓝牙改用 SoftwareSerial(2,11)；调试走硬件 UART Serial(0/1)（板载 USB 串口监视器）；
 *   7. 接收用环形解码状态机（主循环解帧，解析与执行分离）；
 *   8. EEPROM 写入去掉固定 delay(5)，改用 ACK 轮询自适应等待；
 *   9. 角色（左右手/主从）改为上电读 EEPROM 配置字节，可用指令运行时配置；
 *  10. 显式状态机 IDLE / WRITING / PLAYING / PAUSED / SYNCING，非法状态一律 NAK。
 *
 * 注意：当前 16MHz UNO 用 SoftwareSerial(2,11) 跑蓝牙 38400（协议层有 CRC+重传兜底）；
 *       未来 8MHz 自制板再把蓝牙挪回硬件 UART（8MHz + U2X 跑 38400 误差 0.16%）。
 * ============================================================================
 */

#include <SoftwareSerial.h>
#include <Wire.h>

/* ===================== 调试分级宏 =====================
 * DBG_LEVEL: 0=关闭 1=ERROR 2=WARN 3=INFO。量产构建置 0 全部编译掉。
 * 调试输出走硬件 UART Serial(0/1)（即板载 USB 串口监视器，115200）。
 */
#define DBG_LEVEL 3

SoftwareSerial bt(2, 11);  // 蓝牙模块：RX=2, TX=11（板载 USB 的 Serial 让位给调试监视器）

#if DBG_LEVEL >= 1
#define DBG_ERROR(...) do { Serial.print(F("[E] ")); Serial.print(__VA_ARGS__); } while (0)
#else
#define DBG_ERROR(...)
#endif
#if DBG_LEVEL >= 2
#define DBG_WARN(...) do { Serial.print(F("[W] ")); Serial.print(__VA_ARGS__); } while (0)
#else
#define DBG_WARN(...)
#endif
#if DBG_LEVEL >= 3
#define DBG_INFO(...) do { Serial.print(F("[I] ")); Serial.print(__VA_ARGS__); } while (0)
#else
#define DBG_INFO(...)
#endif

/* ===================== 硬件引脚 =====================
 * 蓝牙走 SoftwareSerial(2,11)；调试走硬件 UART Serial(0/1)（板载 USB 串口监视器）。
 */
const int ledPins[] = {3, 5, 6, 9, 10};   // 5 个马达（PWM）
const int numLeds = 5;

/* ===================== 协议常量 ===================== */
#define FRAME_FLAG     0x7E
#define FRAME_ESC      0x7D
#define FRAME_ESC_FLAG 0x5E
#define FRAME_ESC_ESC  0x5D

#define DST_PC    0x01
#define DST_SLAVE 0x02

#define TARGET_LOCAL 0
#define TARGET_SLAVE 1

#define STORAGE_SRAM   0
#define STORAGE_EEPROM 1

#define PROTO_VER 1

/* 命令段（App->设备 / 主机->从机） */
#define CMD_HELLO        0x01
#define CMD_PING         0x05
#define CMD_STOP         0x10
#define CMD_PAUSE        0x11
#define CMD_RESUME       0x12
#define CMD_RESET        0x13
#define CMD_SRAM_PLAY    0x14
#define CMD_EEPROM_PLAY  0x15
#define CMD_CLEAR_SRAM   0x16
#define CMD_CLEAR_EEPROM 0x17
#define CMD_JUMP_BAR     0x18
#define CMD_SET_MODE     0x19
#define CMD_SET_BPM      0x1A
#define CMD_SET_TIME_SIG 0x1B
#define CMD_SET_TPS      0x1C
#define CMD_SET_INTENSITY 0x1D
#define CMD_WRITE_BEGIN  0x20
#define CMD_WRITE_DATA   0x21
#define CMD_WRITE_END    0x22
#define CMD_WRITE_ABORT  0x23
#define CMD_SYNC_REQ     0x30
#define CMD_SYNC_OFFSET  0x31
#define CMD_SET_ROLE     0x32

/* 响应/事件段（设备->App / 从机->主机） */
#define CMD_HELLO_ACK      0x81
#define CMD_ACK            0x82
#define CMD_NAK            0x83
#define CMD_PONG           0x86
#define CMD_EVENT          0x87
#define CMD_WRITE_DATA_ACK 0x88
#define CMD_WRITE_RESULT   0x89
#define CMD_SYNC_REP       0xB0
#define CMD_SYNC_ACK       0xB1

/* 错误码 */
#define ERR_OK      0
#define ERR_CRC     1
#define ERR_PARAM   2
#define ERR_STATE   3
#define ERR_STORAGE 4
#define ERR_BUSY    5
#define ERR_GAP     6
#define ERR_ABORT   7
#define ERR_TIMEOUT 8

/* 事件码 */
#define EVT_DEVICE_READY        0x01
#define EVT_SLAVE_LINK_LOST     0x02
#define EVT_SLAVE_LINK_RESTORED 0x03
#define EVT_SYNC_COMPLETE       0x05

/* 帧长限制（未转义 ≤ 32） */
#define MAX_PAYLOAD 25
#define MAX_FRAME   32

/* ===================== 角色配置（EEPROM 存储） =====================
 * 上电读 AT24C256 高端配置块决定 IS_MASTER / IS_LEFT，避免改常量重烧。
 */
#define CONFIG_BASE   0x7F00
#define CONFIG_MAGIC1 'K'
#define CONFIG_MAGIC2 'F'
#define CONFIG_ROLE_ADDR      (CONFIG_BASE + 2)   // 0x7F02
#define CONFIG_VERSION_ADDR   (CONFIG_BASE + 3)   // 0x7F03
bool IS_MASTER = 0;   // true=主, false=从
bool IS_LEFT = 0;     // true=左手, false=右手

/* ===================== 乐谱存储（SRAM） ===================== */
#define MAX_CMDS 32
uint8_t cmdTicks[MAX_CMDS];
uint8_t cmdMotors[MAX_CMDS];
uint16_t totalCmds = 0;

/* ===================== EEPROM 分区定义 ===================== */
#define EEPROM_PAGE_SIZE 64
#define EEPROM_CACHE_SIZE 64
const uint16_t eepromBases[] = {
  0x0000, 0x1000, 0x2000, 0x3000,
  0x4000, 0x5000, 0x6000, 0x7000
};
const uint16_t EEPROM_SECTION_SIZE = 0x1000;

/* ===================== 播放状态 ===================== */
bool isPlaying = false;
bool loopPlayback = true;
bool isPause = false;
unsigned long pauseStartTime = 0;
unsigned long totalPauseTime = 0;
unsigned long sectionStartTime = 0;
uint16_t currentCmdIndex = 0;
uint8_t currentMotorState = 0;

uint32_t sramAbsTicks[MAX_CMDS];
uint8_t sramBarStartIndex[MAX_CMDS];
uint8_t sramBarCount = 0;
uint32_t sramPlayFromAbsTick = 0;

bool dualMode = 1;

/* 从机状态（主机维护） */
enum SlaveState : uint8_t { SLAVE_IDLE, SLAVE_RECEIVING, SLAVE_READY, SLAVE_PLAYING, SLAVE_PAUSED, SLAVE_ERROR };
SlaveState slaveState = SLAVE_IDLE;
unsigned long slaveLastFrameTime = 0;

/* 马达强度 */
uint8_t motorIntensity[5] = {128, 128, 128, 128, 128};

/* 循环等待 */
bool waitingLoop = false;
unsigned long waitStartTime = 0;
uint8_t waitingLoopSource = 0;
const unsigned long LOOP_DELAY_US = 500000UL;

/* EEPROM 播放状态 */
bool eepromPlaying = false;
uint16_t eepromReadBase = 0;
uint16_t eepromReadAddr = 0;
uint8_t eepromCurTick = 0;
uint8_t eepromCurMotor = 0;
uint8_t eepromLastTick = 0;
uint32_t eepromAbsTick = 0;
bool eepromCmdReady = false;
unsigned long eepromSectionStart = 0;
unsigned long eepromPauseStart = 0;
unsigned long eepromTotalPause = 0;
#define MAX_BARS 128
uint16_t eepromBarStartIndex[MAX_BARS];
uint8_t eepromBarCount = 0;

/* 节奏参数 */
uint16_t bpm = 120;
uint8_t beatsPerBar = 4;
uint8_t ticksPerBeat = 32;
uint32_t tickDurationUs;
uint32_t barDurationUs;
uint16_t totalTicksPerBar = 128;

/* ===================== EEPROM 写入缓存（非阻塞） ===================== */
uint8_t eepromCache[EEPROM_CACHE_SIZE];
uint8_t eepromCacheLen = 0;
bool eepromWriting = false;      // 是否处于写会话（接收状态）
uint16_t eepromWriteBase = 0;
uint16_t eepromWriteAddr = 0;
bool eepromWriteBusy = false;    // AT24C256 内部写周期中（ACK 轮询）

/* ===================== 设备状态机（显式） ===================== */
enum DeviceState : uint8_t {
  ST_IDLE, ST_WRITING, ST_PLAYING, ST_PAUSED, ST_SYNCING
};
DeviceState devState = ST_IDLE;

/* ===================== 校时（8 轮 NTP） ===================== */
bool timeSynced = false;
int32_t timeOffset = 0;   // offset = slave_local - master_est
const unsigned long SYNC_INTERVAL = 30000000UL;  // 30s
unsigned long lastSyncTime = 0;

/* 主设备 8 轮采样 */
#define SYNC_ROUNDS 8
bool syncing = false;          // 校时会话进行中
uint8_t syncTxn = 0;           // 事务序号（防陈旧帧）
uint8_t syncRound = 0;         // 当前轮次
uint32_t syncT1[SYNC_ROUNDS];
uint32_t syncT2[SYNC_ROUNDS];
uint32_t syncT3[SYNC_ROUNDS];
uint32_t syncT4[SYNC_ROUNDS];
uint32_t syncRtt[SYNC_ROUNDS];
unsigned long syncReqSentTime = 0;   // 本轮 SYNC_REQ 发送时刻
bool syncWaitRep = false;            // 等待 SYNC_REP
unsigned long syncWaitTimeout = 0;
const unsigned long SYNC_WAIT_TIMEOUT_US = 2000000UL;  // 2s
uint8_t syncRetries = 0;         // 本轮校时连续超时次数
#define SYNC_MAX_RETRIES 4       // 连续 4 次(≈8s)超时即放弃本次校时

/* 从设备校时状态 */
bool slaveSyncActive = false;   // 等待 offset
uint8_t slaveSyncTxn = 0;
unsigned long slaveSyncTimeout = 0;
const unsigned long SLAVE_SYNC_TIMEOUT_US = 5000000UL;

/* ===================== 心跳（主机->从机） ===================== */
const unsigned long HEARTBEAT_INTERVAL_US = 5000000UL;   // 空闲 5s
const uint8_t HEARTBEAT_MAX_MISS = 3;
unsigned long lastHeartbeatTime = 0;
uint8_t heartbeatMiss = 0;
bool awaitingPong = false;      // 本轮心跳 PING 已发出、等待从机 PONG
bool slaveLinkAlive = true;

/* ===================== 未来动作（双手同步播放） ===================== */
bool hasFutureAction = false;
unsigned long futureExecTime = 0;
uint8_t futureActionCmd = 0;
uint8_t futureActionParam = 0;

/* 控制指令时间戳分包（保留旧 0x40 机制并入统一帧） */
bool expectingDataPacket = false;
uint8_t dataPacketType = 0;
uint8_t dataPacketParam = 0;
uint32_t dataPacketValue = 0;
uint8_t dataPacketIndex = 0;
unsigned long dataPacketStartTime = 0;
const unsigned long DATA_PACKET_TIMEOUT = 100000UL;

/* 每帧最多执行指令数 */
const uint8_t MAX_CMDS_PER_FRAME = 16;

/* ===================== 帧解码器 ===================== */
// CRC16/CCITT-FALSE 前向声明：FrameDecoder::push 在类内联定义中调用它，
// 声明必须先于类定义（C++ 类作用域名称查找规则）。
uint16_t crc16(const uint8_t *data, uint16_t len);
struct FrameDecoder {
  uint8_t state;        // 0=idle 1=collecting
  uint8_t buf[MAX_FRAME + 8];  // 解转义后的 body+CRC
  uint8_t bufLen;
  uint8_t expectedLen;
  bool pendingEscaped;
  // 解码输出
  uint8_t seq, dst, cmd;
  uint8_t payload[MAX_PAYLOAD];
  uint8_t payloadLen;
  bool frameReady;

  void reset() {
    state = 0;
    bufLen = 0;
    expectedLen = 0;
    pendingEscaped = false;
    frameReady = false;
  }

  // 喂一个字节；返回 true 表示组装完一帧（frameReady=有效帧）
  bool feed(uint8_t b) {
    frameReady = false;
    if (state == 0) {
      if (b == FRAME_FLAG) {
        state = 1;
        bufLen = 0;
        expectedLen = 0;
        pendingEscaped = false;
      }
      return false;
    }
    // collecting
    if (b == FRAME_FLAG) {
      // 帧内撞见标志：丢前半帧，从新标志开始
      reset();
      state = 1;
      return false;
    }
    if (b == FRAME_ESC) {
      pendingEscaped = true;
      return false;
    }
    if (pendingEscaped) {
      pendingEscaped = false;
      if (b == FRAME_ESC_FLAG) return push(FRAME_FLAG);
      if (b == FRAME_ESC_ESC) return push(FRAME_ESC);
      reset();
      return false;
    }
    return push(b);
  }

  bool push(uint8_t b) {
    if (bufLen == 0) {
      if (b < 3 || b > MAX_PAYLOAD + 3) { reset(); return false; }
      expectedLen = b;
      buf[bufLen++] = b;
      return false;
    }
    if (bufLen >= sizeof(buf)) { reset(); return false; }
    buf[bufLen++] = b;
    if (bufLen >= expectedLen + 3) {
      // 组帧完成：校验 CRC（buf = [LEN][SEQ][DST][CMD][PAYLOAD][CRC_L][CRC_H]）
      uint16_t crc = crc16(buf, expectedLen + 1);
      uint8_t crcLow = buf[expectedLen + 1];
      uint8_t crcHigh = buf[expectedLen + 2];
      if (((crc >> 8) & 0xFF) == crcHigh && (crc & 0xFF) == crcLow) {
        seq = buf[1];
        dst = buf[2];
        cmd = buf[3];
        payloadLen = expectedLen - 3;
        for (uint8_t i = 0; i < payloadLen; i++) payload[i] = buf[4 + i];
        frameReady = true;
        reset();
        return true;
      }
      // CRC 失败：丢帧
      reset();
      return false;
    }
    return false;
  }
};
FrameDecoder decoder;

/* ===================== 转发缓冲 ===================== */
uint8_t txBuf[MAX_FRAME * 2 + 4];

/* ===================== 函数声明 ===================== */
uint16_t encodeFrame(uint8_t seq, uint8_t dst, uint8_t cmd, const uint8_t *payload, uint8_t n, uint8_t *out);
void sendFrame(uint8_t dst, uint8_t cmd, const uint8_t *payload, uint8_t n, uint8_t seq);
void sendAck(uint8_t seq, uint8_t status);
void sendNak(uint8_t seq, uint8_t err);
void sendEvent(uint8_t eventCode, const uint8_t *data, uint8_t n);

void recalcTiming();
void startPlayback();
void stopPlayback();
void executeCommand(uint8_t motorCtrl);
void schedulePlayback();
void clearScore();
void storeScoreData(uint8_t beatPos, uint8_t motorCtrl);
void playEepromPartition(uint8_t partition);
void eepromWriteByte(uint16_t addr, uint8_t data);
uint8_t eepromReadByte(uint16_t addr);
bool eepromFetchNext();
void eepromSchedule();
void flushEepromCache();
void pollEepromWrite();

void handleCommandFrame(uint8_t seq, uint8_t dst, uint8_t cmd, const uint8_t *payload, uint8_t n);
void handleSlaveResponse(uint8_t seq, uint8_t cmd, const uint8_t *payload, uint8_t n);
void forwardToSlave(uint8_t seq, uint8_t cmd, const uint8_t *payload, uint8_t n);
void forwardToPc(uint8_t seq, uint8_t cmd, const uint8_t *payload, uint8_t n);

void handleWriteBegin(uint8_t seq, const uint8_t *p, uint8_t n);
void handleWriteData(uint8_t seq, const uint8_t *p, uint8_t n);
void handleWriteEnd(uint8_t seq);
void writeSessionAbort(uint8_t err);

void startTimingSync();
void continueTimingSync();
void handleSyncReq(uint8_t seq, const uint8_t *p, uint8_t n);
void handleSyncOffset(uint8_t seq, const uint8_t *p, uint8_t n);
void applyOffset(int32_t offset);

void scheduleFutureAction(unsigned long execTime, uint8_t action, uint8_t param);
void checkFutureAction();
void sendControlData(uint8_t actionType, uint32_t execTime, uint8_t param);

bool microsReached(unsigned long target);
uint64_t microsElapsed(unsigned long start);
unsigned long playbackAnchorTime();
void setSlaveState(SlaveState newState);
void readRoleConfig();
void writeRoleConfig(uint8_t role);
void systemReset();

/* ===================== CRC-16/CCITT-FALSE ===================== */
uint16_t crc16(const uint8_t *data, uint16_t len) {
  uint16_t crc = 0xFFFF;
  for (uint16_t i = 0; i < len; i++) {
    crc ^= (uint16_t)data[i] << 8;
    for (uint8_t j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
    }
  }
  return crc;
}

/* ===================== 帧编码（转义） ===================== */
uint16_t encodeFrame(uint8_t seq, uint8_t dst, uint8_t cmd, const uint8_t *payload, uint8_t n, uint8_t *out) {
  // body = [LEN][SEQ][DST][CMD][PAYLOAD]（共 1 + (3+n) 字节），CRC 覆盖整个 body
  uint8_t body[MAX_FRAME + 4];
  body[0] = 3 + n;          // LEN = SEQ+DST+CMD+PAYLOAD
  body[1] = seq;
  body[2] = dst;
  body[3] = cmd;
  for (uint8_t i = 0; i < n; i++) body[4 + i] = payload[i];
  uint16_t crc = crc16(body, 4 + n);
  body[4 + n] = crc & 0xFF;
  body[5 + n] = (crc >> 8) & 0xFF;

  uint16_t olen = 0;
  out[olen++] = FRAME_FLAG;
  uint8_t total = 6 + n;   // 1(LEN) + (3+n) + 2(CRC)
  for (uint8_t i = 0; i < total; i++) {
    uint8_t b = body[i];
    if (b == FRAME_FLAG) { out[olen++] = FRAME_ESC; out[olen++] = FRAME_ESC_FLAG; }
    else if (b == FRAME_ESC) { out[olen++] = FRAME_ESC; out[olen++] = FRAME_ESC_ESC; }
    else out[olen++] = b;
  }
  return olen;
}

/* ===================== 发送（SoftwareSerial 广播，各节点按 DST 过滤） ===================== */
void sendFrame(uint8_t dst, uint8_t cmd, const uint8_t *payload, uint8_t n, uint8_t seq) {
  uint16_t len = encodeFrame(seq, dst, cmd, payload, n, txBuf);
  // SoftwareSerial TX 缓冲仅 64B，逐字节写、缓冲满就等待，防止超长帧截断丢尾
  for (uint16_t i = 0; i < len; i++) {
    while (!bt.write(txBuf[i])) {
      // 缓冲满，等待 UDR 腾出空间
    }
  }
  // 转发由块协议停等天然规避半双工碰撞。
}

void sendAck(uint8_t seq, uint8_t status) {
  uint8_t p[1] = {status};
  sendFrame(DST_PC, CMD_ACK, p, 1, seq);
}

void sendNak(uint8_t seq, uint8_t err) {
  uint8_t p[1] = {err};
  sendFrame(DST_PC, CMD_NAK, p, 1, seq);
}

void sendEvent(uint8_t eventCode, const uint8_t *data, uint8_t n) {
  uint8_t p[MAX_PAYLOAD];
  p[0] = eventCode;
  for (uint8_t i = 0; i < n; i++) p[1 + i] = data[i];
  sendFrame(DST_PC, CMD_EVENT, p, 1 + n, 0);  // seq=0：事件无对应请求
}

/* ===================== 时间工具 ===================== */
inline bool microsReached(unsigned long target) {
  return (uint32_t)(micros() - target) < 0x80000000UL;
}
inline uint64_t microsElapsed(unsigned long start) {
  return (uint64_t)(micros() - start);
}

/* ===================== 计算时间参数 ===================== */
void recalcTiming() {
  if (bpm == 0) bpm = 120;
  uint32_t beatDurationUs = 60000000UL / bpm;
  tickDurationUs = beatDurationUs / ticksPerBeat;
  if (tickDurationUs == 0) tickDurationUs = 1;
  barDurationUs = beatsPerBar * beatDurationUs;
  totalTicksPerBar = beatsPerBar * ticksPerBeat;
}

/* 播放锚点：从设备叠加校时偏移 */
unsigned long playbackAnchorTime() {
  unsigned long t = micros();
  if (dualMode && !IS_MASTER) {
    int64_t adjusted = (int64_t)t - (int64_t)timeOffset;
    if (adjusted < 0) adjusted = 0;
    if (adjusted > UINT32_MAX) adjusted = UINT32_MAX;
    return (unsigned long)adjusted;
  }
  return t;
}

/* ===================== EEPROM 读写（ACK 轮询非阻塞） ===================== */
void eepromWriteByte(uint16_t addr, uint8_t data) {
  Wire.beginTransmission(0x50);
  Wire.write((uint8_t)(addr >> 8));
  Wire.write((uint8_t)(addr & 0xFF));
  Wire.write(data);
  Wire.endTransmission();
  // ACK 轮询：等待设备就绪，替代固定 delay(5)
  unsigned long t0 = micros();
  while (microsElapsed(t0) < 10000UL) {
    Wire.beginTransmission(0x50);
    Wire.write((uint8_t)(addr >> 8));
    Wire.write((uint8_t)(addr & 0xFF));
    if (Wire.endTransmission() == 0) break;
    delayMicroseconds(100);
  }
}

uint8_t eepromReadByte(uint16_t addr) {
  Wire.beginTransmission(0x50);
  Wire.write((uint8_t)(addr >> 8));
  Wire.write((uint8_t)(addr & 0xFF));
  Wire.endTransmission();
  Wire.requestFrom((uint8_t)0x50, (uint8_t)1);
  if (Wire.available()) return Wire.read();
  return 0x00;
}

/* 页写入：强制不跨 64 字节页边界，Wire 单次 ≤30 字节 */
void eepromWritePage(uint16_t addr, const uint8_t *data, uint8_t len) {
  while (len > 0) {
    uint16_t pageOffset = addr % EEPROM_PAGE_SIZE;
    uint8_t spaceInPage = EEPROM_PAGE_SIZE - pageOffset;
    uint8_t chunk = (len <= spaceInPage) ? len : spaceInPage;
    if (chunk > 30) chunk = 30;
    Wire.beginTransmission(0x50);
    Wire.write((uint8_t)(addr >> 8));
    Wire.write((uint8_t)(addr & 0xFF));
    Wire.write(data, chunk);
    Wire.endTransmission();
    // ACK 轮询等待内部写周期结束
    unsigned long t0 = micros();
    while (microsElapsed(t0) < 10000UL) {
      Wire.beginTransmission(0x50);
      Wire.write((uint8_t)(addr >> 8));
      Wire.write((uint8_t)(addr & 0xFF));
      if (Wire.endTransmission() == 0) break;
      delayMicroseconds(100);
    }
    addr += chunk;
    data += chunk;
    len -= chunk;
  }
}

/* 把写缓存按页写入 EEPROM（同步 + ACK 轮询；块协议停等间隙内执行） */
void flushEepromCache() {
  if (eepromCacheLen == 0) return;
  uint16_t pageOffset = eepromWriteAddr % EEPROM_PAGE_SIZE;
  uint16_t spaceInPage = EEPROM_PAGE_SIZE - pageOffset;
  if (eepromCacheLen <= spaceInPage) {
    eepromWritePage(eepromWriteAddr, eepromCache, eepromCacheLen);
    eepromWriteAddr += eepromCacheLen;
  } else {
    eepromWritePage(eepromWriteAddr, eepromCache, spaceInPage);
    eepromWriteAddr += spaceInPage;
    uint16_t remaining = eepromCacheLen - spaceInPage;
    eepromWritePage(eepromWriteAddr, eepromCache + spaceInPage, remaining);
    eepromWriteAddr += remaining;
  }
  eepromCacheLen = 0;
}

/* 主循环轮询：目前 flush 为同步 ACK 轮询，此处保留接口便于未来异步化 */
void pollEepromWrite() {
  // 预留：若实现真正异步写队列，在此推进
}

/* ===================== 播放内核（保留自旧版） ===================== */
void startPlayback() {
  waitingLoop = false;
  waitingLoopSource = 0;
  if (totalCmds == 0) return;

  uint32_t absT = cmdTicks[0];
  sramAbsTicks[0] = absT;
  sramBarCount = 0;
  sramBarStartIndex[0] = 0;
  for (uint16_t i = 1; i < totalCmds; i++) {
    if (cmdTicks[i] < cmdTicks[i - 1]) {
      absT += (uint32_t)totalTicksPerBar - cmdTicks[i - 1] + cmdTicks[i];
      sramBarCount++;
      if (sramBarCount < MAX_CMDS) sramBarStartIndex[sramBarCount] = i;
    } else {
      absT += cmdTicks[i] - cmdTicks[i - 1];
    }
    sramAbsTicks[i] = absT;
  }
  sramBarCount++;
  sramPlayFromAbsTick = 0;

  currentCmdIndex = 0;
  sectionStartTime = playbackAnchorTime();
  isPlaying = true;
  isPause = false;
  pauseStartTime = 0;
  totalPauseTime = 0;
  recalcTiming();
}

void stopPlayback() {
  isPlaying = false;
  waitingLoop = false;
  waitingLoopSource = 0;
  eepromPlaying = false;
  eepromCmdReady = false;
  eepromAbsTick = 0;
  isPause = false;
  pauseStartTime = 0;
  totalPauseTime = 0;
  eepromPauseStart = 0;
  eepromTotalPause = 0;
  hasFutureAction = false;
  for (int i = 0; i < numLeds; i++) analogWrite(ledPins[i], 0);
  currentMotorState = 0;
  if (devState == ST_PLAYING || devState == ST_PAUSED) devState = ST_IDLE;
}

void executeCommand(uint8_t motorCtrl) {
  uint8_t onOff = (motorCtrl >> 7) & 0x01;
  uint8_t mask = motorCtrl & 0x1F;
  for (int i = 0; i < numLeds; i++) {
    if (mask & (1 << i)) {
      if (onOff) {
        analogWrite(ledPins[i], motorIntensity[i]);
        currentMotorState |= (1 << i);
      } else {
        analogWrite(ledPins[i], 0);
        currentMotorState &= ~(1 << i);
      }
    }
  }
}

void schedulePlayback() {
  if (eepromPlaying) return;

  if (waitingLoop) {
    if (microsElapsed(waitStartTime) >= LOOP_DELAY_US) {
      if (waitingLoopSource == 1) {
        startPlayback();
      } else if (waitingLoopSource == 2) {
        eepromPlaying = true;
        eepromReadAddr = eepromReadBase;
        eepromCmdReady = false;
        eepromCurTick = 0;
        eepromCurMotor = 0;
        eepromLastTick = 0;
        eepromAbsTick = 0;
        eepromSectionStart = playbackAnchorTime();
        eepromPauseStart = 0;
        eepromTotalPause = 0;
      }
      waitingLoop = false;
      waitingLoopSource = 0;
    }
    return;
  }

  if (!isPlaying && !isPause) return;

  if (isPause) {
    for (int i = 0; i < numLeds; i++) analogWrite(ledPins[i], 0);
    if (pauseStartTime == 0) pauseStartTime = playbackAnchorTime();
    return;
  }

  if (pauseStartTime != 0 && !isPause) {
    totalPauseTime = playbackAnchorTime() - pauseStartTime;
    sectionStartTime += totalPauseTime;
    pauseStartTime = 0;
    totalPauseTime = 0;
    for (int i = 0; i < numLeds; i++) {
      analogWrite(ledPins[i], (currentMotorState & (1 << i)) ? motorIntensity[i] : 0);
    }
  }

  unsigned long now = playbackAnchorTime();
  uint64_t elapsedUs = (uint64_t)(now - sectionStartTime);
  uint32_t elapsedTicks = elapsedUs / tickDurationUs;

  uint8_t cmdsThisFrame = 0;
  while (currentCmdIndex < totalCmds && cmdsThisFrame < MAX_CMDS_PER_FRAME) {
    if (elapsedTicks >= (uint32_t)(sramAbsTicks[currentCmdIndex] - sramPlayFromAbsTick)) {
      executeCommand(cmdMotors[currentCmdIndex]);
      currentCmdIndex++;
      cmdsThisFrame++;
    } else {
      break;
    }
    now = playbackAnchorTime();
    elapsedUs = (uint64_t)(now - sectionStartTime);
    elapsedTicks = elapsedUs / tickDurationUs;
  }

  if (currentCmdIndex >= totalCmds) {
    for (int i = 0; i < numLeds; i++) analogWrite(ledPins[i], 0);
    currentMotorState = 0;
    if (loopPlayback) {
      waitingLoop = true;
      waitingLoopSource = 1;
      waitStartTime = micros();
      isPlaying = false;
    } else {
      isPlaying = false;
      devState = ST_IDLE;
    }
  }
}

void eepromSchedule() {
  if (isPlaying || waitingLoop) {
    if (eepromPlaying) DBG_INFO(F("EEPROM: blocked by SRAM/waiting\r\n"));
    return;
  }
  if (!eepromPlaying) return;

  if (isPause) {
    for (int i = 0; i < numLeds; i++) analogWrite(ledPins[i], 0);
    if (eepromPauseStart == 0) eepromPauseStart = playbackAnchorTime();
    return;
  }

  if (eepromPauseStart != 0) {
    eepromTotalPause = playbackAnchorTime() - eepromPauseStart;
    eepromSectionStart += eepromTotalPause;
    eepromPauseStart = 0;
    eepromTotalPause = 0;
    for (int i = 0; i < numLeds; i++) {
      analogWrite(ledPins[i], (currentMotorState & (1 << i)) ? motorIntensity[i] : 0);
    }
  }

  if (!eepromCmdReady) {
    if (!eepromFetchNext()) {
      eepromPlaying = false;
      devState = ST_IDLE;
      return;
    }
    eepromCmdReady = true;
  }

  unsigned long now = playbackAnchorTime();
  uint64_t elapsedUs = (uint64_t)(now - eepromSectionStart);
  uint32_t elapsedTicks = elapsedUs / tickDurationUs;

  uint8_t cmdsThisFrame = 0;
  while (cmdsThisFrame < MAX_CMDS_PER_FRAME) {
    if (elapsedTicks >= eepromAbsTick) {
      executeCommand(eepromCurMotor);
      if (!eepromFetchNext()) {
        if (loopPlayback) {
          for (int i = 0; i < numLeds; i++) analogWrite(ledPins[i], 0);
          currentMotorState = 0;
          eepromPlaying = false;
          waitingLoop = true;
          waitingLoopSource = 2;
          waitStartTime = micros();
        } else {
          eepromPlaying = false;
          for (int i = 0; i < numLeds; i++) analogWrite(ledPins[i], 0);
          currentMotorState = 0;
          devState = ST_IDLE;
          return;
        }
        break;
      } else {
        now = playbackAnchorTime();
        elapsedUs = (uint64_t)(now - eepromSectionStart);
        elapsedTicks = elapsedUs / tickDurationUs;
        cmdsThisFrame++;
      }
    } else {
      break;
    }
  }
}

void clearScore() {
  if (isPlaying) {
    isPlaying = false;
    pauseStartTime = 0;
    totalPauseTime = 0;
  }
  if (waitingLoop && waitingLoopSource == 1) {
    waitingLoop = false;
    waitingLoopSource = 0;
  }
  totalCmds = 0;
}

void storeScoreData(uint8_t beatPos, uint8_t motorCtrl) {
  if (totalCmds < MAX_CMDS) {
    cmdTicks[totalCmds] = beatPos;
    cmdMotors[totalCmds] = motorCtrl;
    totalCmds++;
  } else {
    DBG_WARN(F("SRAM buffer full, drop\r\n"));
  }
}

bool eepromFetchNext() {
  if (eepromReadAddr + 2 > eepromReadBase + EEPROM_SECTION_SIZE) return false;
  uint8_t tick = eepromReadByte(eepromReadAddr);
  uint8_t motor = eepromReadByte(eepromReadAddr + 1);
  if (tick == 0xFF && motor == 0x00) return false;
  if (tick < eepromLastTick) {
    eepromAbsTick += (uint32_t)totalTicksPerBar - eepromLastTick + tick;
  } else {
    eepromAbsTick += (uint32_t)tick - eepromLastTick;
  }
  eepromLastTick = tick;
  eepromCurTick = tick;
  eepromCurMotor = motor;
  eepromReadAddr += 2;
  return true;
}

void playEepromPartition(uint8_t partition) {
  stopPlayback();
  isPause = false;
  pauseStartTime = 0;
  totalPauseTime = 0;
  eepromPauseStart = 0;
  eepromTotalPause = 0;
  if (partition <= 7) {
    eepromPlaying = true;
    eepromReadBase = eepromBases[partition];
    eepromReadAddr = eepromReadBase;
    eepromCmdReady = false;
    eepromCurTick = 0;
    eepromCurMotor = 0;
    eepromLastTick = 0;
    eepromAbsTick = 0;
    eepromSectionStart = playbackAnchorTime();
    eepromPauseStart = 0;
    eepromTotalPause = 0;
    isPause = false;

    eepromBarCount = 0;
    uint16_t scanAddr = eepromReadBase;
    uint8_t prevScanTick = 0xFF;
    bool scanFirst = true;
    while (scanAddr + 2 <= eepromReadBase + EEPROM_SECTION_SIZE && eepromBarCount < MAX_BARS) {
      uint8_t t = eepromReadByte(scanAddr);
      uint8_t m = eepromReadByte(scanAddr + 1);
      if (t == 0xFF && m == 0x00) break;
      if (scanFirst || t < prevScanTick) {
        eepromBarStartIndex[eepromBarCount++] = scanAddr;
      }
      prevScanTick = t;
      scanFirst = false;
      scanAddr += 2;
    }
  }
}

void setSlaveState(SlaveState newState) {
  if (slaveState != newState) {
#if DBG_LEVEL >= 3
    DBG_INFO(F("[slaveState] "));
    Serial.print((int)slaveState);
    Serial.print(F(" -> "));
    Serial.println((int)newState);
#endif
  }
  slaveState = newState;
}

/* ===================== 角色配置 ===================== */
void readRoleConfig() {
  uint8_t m1 = eepromReadByte(CONFIG_BASE);
  uint8_t m2 = eepromReadByte(CONFIG_BASE + 1);
  uint8_t ver = eepromReadByte(CONFIG_VERSION_ADDR);
  if (m1 == CONFIG_MAGIC1 && m2 == CONFIG_MAGIC2 && ver == 1) {
    uint8_t role = eepromReadByte(CONFIG_ROLE_ADDR);
    IS_MASTER = (role & 0x01) != 0;
    IS_LEFT = (role & 0x02) != 0;
  } else {
    // 编译默认（IS_MASTER/IS_LEFT 由顶部宏定义，这里保留默认值并写回）
    uint8_t role = (IS_MASTER ? 1 : 0) | (IS_LEFT ? 2 : 0);
    eepromWriteByte(CONFIG_BASE, CONFIG_MAGIC1);
    eepromWriteByte(CONFIG_BASE + 1, CONFIG_MAGIC2);
    eepromWriteByte(CONFIG_ROLE_ADDR, role);
    eepromWriteByte(CONFIG_VERSION_ADDR, 1);
  }
#if DBG_LEVEL >= 3
  DBG_INFO(F("Role cfg: MASTER="));
  Serial.print(IS_MASTER ? F("Y") : F("N"));
  Serial.print(F(" LEFT="));
  Serial.println(IS_LEFT ? F("Y") : F("N"));
#endif
}

void writeRoleConfig(uint8_t role) {
  eepromWriteByte(CONFIG_BASE, CONFIG_MAGIC1);
  eepromWriteByte(CONFIG_BASE + 1, CONFIG_MAGIC2);
  eepromWriteByte(CONFIG_ROLE_ADDR, role);
  eepromWriteByte(CONFIG_VERSION_ADDR, 1);
}

/* ===================== 系统复位 ===================== */
void systemReset() {
  if (eepromWriting) flushEepromCache();
  stopPlayback();
  totalCmds = 0;
  eepromCacheLen = 0;
  eepromWriting = false;
  eepromWriteAddr = 0;
  eepromWriteBase = 0;
  eepromPlaying = false;
  eepromCmdReady = false;
  eepromReadBase = 0;
  eepromReadAddr = 0;
  eepromCurTick = 0;
  eepromCurMotor = 0;
  eepromLastTick = 0;
  eepromSectionStart = 0;
  eepromPauseStart = 0;
  eepromTotalPause = 0;
  isPause = false;
  pauseStartTime = 0;
  totalPauseTime = 0;
  waitingLoop = false;
  waitingLoopSource = 0;
  waitStartTime = 0;
  currentMotorState = 0;
  timeSynced = false;
  timeOffset = 0;
  hasFutureAction = false;
  expectingDataPacket = false;
  slaveState = SLAVE_IDLE;
  for (int i = 0; i < 5; i++) motorIntensity[i] = 128;
  devState = ST_IDLE;
}

/* ===================== 未来动作（双手同步播放） ===================== */
void scheduleFutureAction(unsigned long execTime, uint8_t action, uint8_t param) {
  hasFutureAction = true;
  futureExecTime = execTime;
  futureActionCmd = action;
  futureActionParam = param;
}

void checkFutureAction() {
  if (!hasFutureAction) return;
  if (microsReached(futureExecTime)) {
    hasFutureAction = false;
    switch (futureActionCmd) {
      case 0x01: waitingLoop = false; waitingLoopSource = 0; isPause = true; devState = ST_PAUSED; break;
      case 0x02: isPause = false; devState = ST_PLAYING; break;
      case 0x03: stopPlayback(); break;
      case 0x04: startPlayback(); devState = ST_PLAYING; break;
      case 0x05: playEepromPartition(futureActionParam); devState = ST_PLAYING; break;
      default: break;
    }
  }
}

/* 主机：向从机发送控制数据（播放/暂停/继续/停止 + 绝对执行时刻） */
void sendControlData(uint8_t actionType, uint32_t execTime, uint8_t param) {
  uint8_t p0[2] = {actionType, param};
  sendFrame(DST_SLAVE, 0x40, p0, 2, 0);  // 用 0x40 保留指令：从机侧兼容处理
  uint8_t p1[4] = {(uint8_t)(execTime & 0xFF), (uint8_t)((execTime >> 8) & 0xFF),
                   (uint8_t)((execTime >> 16) & 0xFF), (uint8_t)((execTime >> 24) & 0xFF)};
  sendFrame(DST_SLAVE, 0x41, p1, 4, 0);
}

/* ===================== 转发 ===================== */
void forwardToSlave(uint8_t seq, uint8_t cmd, const uint8_t *payload, uint8_t n) {
  if (!IS_MASTER) return;
  sendFrame(DST_SLAVE, cmd, payload, n, seq);  // 保持原 SEQ，从机响应以此匹配
}

void forwardToPc(uint8_t seq, uint8_t cmd, const uint8_t *payload, uint8_t n) {
  sendFrame(DST_PC, cmd, payload, n, seq);
}

/* ===================== 校时：主机发起（8 轮 NTP） ===================== */
void startTimingSync() {
  if (!dualMode || !IS_MASTER) return;
  if (devState == ST_WRITING) return;   // 写会话期间禁止校时
  if (syncing) return;
  syncing = true;
  syncRound = 0;
  syncRetries = 0;
  syncTxn++;
  syncWaitRep = false;
  devState = ST_SYNCING;
  continueTimingSync();
}

void continueTimingSync() {
  if (!syncing) return;
  // 发送本轮 SYNC_REQ（带事务号 + t1）
  syncT1[syncRound] = micros();
  syncReqSentTime = syncT1[syncRound];
  uint8_t p[5];
  p[0] = syncTxn;
  for (uint8_t i = 0; i < 4; i++) p[1 + i] = (syncT1[syncRound] >> (i * 8)) & 0xFF;
  sendFrame(DST_SLAVE, CMD_SYNC_REQ, p, 5, 0);
  syncWaitRep = true;
  syncWaitTimeout = micros();
}

/* 主机：处理从机 SYNC_REP */
void handleSyncRep(const uint8_t *p, uint8_t n) {
  if (!syncing || !syncWaitRep) return;
  if (n < 9) return;
  uint8_t txn = p[0];
  if (txn != syncTxn) return;  // 陈旧帧，丢弃
  uint32_t t1 = 0, t2 = 0, t3 = 0;
  for (uint8_t i = 0; i < 4; i++) t1 |= (uint32_t)p[1 + i] << (i * 8);
  for (uint8_t i = 0; i < 4; i++) t2 |= (uint32_t)p[5 + i] << (i * 8);
  for (uint8_t i = 0; i < 4; i++) t3 |= (uint32_t)p[9 + i] << (i * 8);
  syncT2[syncRound] = t2;
  syncT3[syncRound] = t3;
  syncT4[syncRound] = micros();
  uint32_t rtt = (syncT4[syncRound] - syncT1[syncRound]) - (t3 - t2);
  syncRtt[syncRound] = rtt;
#if DBG_LEVEL >= 3
  DBG_INFO(F("Sync RTT["));
  Serial.print(syncRound);
  Serial.print(F("]="));
  Serial.println(rtt);
#endif

  syncRound++;
  syncWaitRep = false;
  if (syncRound >= SYNC_ROUNDS) {
    // 选 RTT 最小一轮
    uint8_t best = 0;
    uint32_t bestRtt = syncRtt[0];
    for (uint8_t i = 1; i < SYNC_ROUNDS; i++) {
      if (syncRtt[i] < bestRtt) { bestRtt = syncRtt[i]; best = i; }
    }
    // offset = ((t2-t1) + (t3-t4)) / 2
    int32_t offset = (int32_t)(((int64_t)(syncT2[best] - syncT1[best]) + (int64_t)(syncT3[best] - syncT4[best])) / 2);
    timeOffset = offset;
    timeSynced = true;
    lastSyncTime = micros();
    // 下发 offset 给从机
    uint8_t p2[5];
    p2[0] = syncTxn;
    for (uint8_t i = 0; i < 4; i++) p2[1 + i] = (uint32_t)((uint32_t)offset >> (i * 8)) & 0xFF;
    sendFrame(DST_SLAVE, CMD_SYNC_OFFSET, p2, 5, 0);
    syncing = false;
    if (devState == ST_SYNCING) devState = ST_IDLE;
    // 上报校时完成事件（带 bestRtt + offset）
    uint8_t ev[6];
    ev[0] = bestRtt & 0xFF;
    ev[1] = (bestRtt >> 8) & 0xFF;
    for (uint8_t i = 0; i < 4; i++) ev[2 + i] = ((uint32_t)offset >> (i * 8)) & 0xFF;
    sendEvent(EVT_SYNC_COMPLETE, ev, 6);
#if DBG_LEVEL >= 3
    DBG_INFO(F("Sync done bestRtt="));
    Serial.print(bestRtt);
    Serial.print(F(" offset="));
    Serial.println(offset);
#endif
  } else {
    // 下一轮
    delay(10);
    continueTimingSync();
  }
}

/* 从机：处理 SYNC_REQ */
void handleSyncReq(uint8_t seq, const uint8_t *p, uint8_t n) {
  if (!dualMode) return;
  if (n < 5) return;
  uint8_t txn = p[0];
  uint32_t t1 = 0;
  for (uint8_t i = 0; i < 4; i++) t1 |= (uint32_t)p[1 + i] << (i * 8);
  uint32_t t2 = micros();
  uint32_t t3 = micros();
  uint8_t rep[13];
  rep[0] = txn;
  for (uint8_t i = 0; i < 4; i++) rep[1 + i] = (t1 >> (i * 8)) & 0xFF;
  for (uint8_t i = 0; i < 4; i++) rep[5 + i] = (t2 >> (i * 8)) & 0xFF;
  for (uint8_t i = 0; i < 4; i++) rep[9 + i] = (t3 >> (i * 8)) & 0xFF;
  sendFrame(DST_PC, CMD_SYNC_REP, rep, 13, seq);
  slaveSyncActive = true;
  slaveSyncTxn = txn;
  slaveSyncTimeout = micros();
}

/* 从机：处理 SYNC_OFFSET */
void handleSyncOffset(uint8_t seq, const uint8_t *p, uint8_t n) {
  if (n < 5) return;
  uint8_t txn = p[0];
  int32_t offset = 0;
  for (uint8_t i = 0; i < 4; i++) offset |= (uint32_t)p[1 + i] << (i * 8);
  applyOffset(offset);
  slaveSyncActive = false;
  uint8_t ack[2] = {txn, ERR_OK};
  sendFrame(DST_PC, CMD_SYNC_ACK, ack, 2, seq);
}

void applyOffset(int32_t offset) {
  timeOffset = offset;
  timeSynced = true;
  lastSyncTime = micros();
#if DBG_LEVEL >= 3
  DBG_INFO(F("Offset applied: "));
  Serial.println(offset);
#endif
}

/* ===================== 心跳（主机->从机） ===================== */
void handleHeartbeat() {
  if (!IS_MASTER || !dualMode) return;
  if (microsElapsed(lastHeartbeatTime) < HEARTBEAT_INTERVAL_US) return;
  lastHeartbeatTime = micros();
  if (devState == ST_WRITING) return;  // 写会话期间不打扰
  // 每轮都重发 PING：上一轮 PONG 未回（awaitingPong）则先计一次 miss。
  // 若只在 awaitingPong==false 时发 PING，断电期那次 PING 丢失后 await 卡死，
  // 从机恢复也收不到新 PING，miss 无限上涨且永不恢复。
  if (awaitingPong) {
    heartbeatMiss++;
    checkSlaveLink();
  }
  awaitingPong = true;
  sendFrame(DST_SLAVE, CMD_PING, NULL, 0, 0);
}

void handleSlavePong() {
  awaitingPong = false;
  if (heartbeatMiss > 0) {
    DBG_INFO(F("Slave link restored\r\n"));
    uint8_t ev[0];
    sendEvent(EVT_SLAVE_LINK_RESTORED, ev, 0);
  }
  heartbeatMiss = 0;
  slaveLinkAlive = true;
}

void checkSlaveLink() {
  if (!IS_MASTER) return;
  if (heartbeatMiss >= HEARTBEAT_MAX_MISS && slaveLinkAlive) {
    slaveLinkAlive = false;
    DBG_WARN(F("Slave link LOST\r\n"));
    stopPlayback();
    uint8_t ev[0];
    sendEvent(EVT_SLAVE_LINK_LOST, ev, 0);
  }
}

/* ===================== 批量写入会话 ===================== */
struct WriteSession {
  bool active;
  uint8_t dst;          // 目标节点
  uint8_t target;
  uint8_t storage;      // SRAM / EEPROM
  uint8_t partition;
  uint16_t totalBytes;
  uint16_t received;
  uint16_t batchCrc;    // 期望整批 CRC
  uint8_t expectedBlock; // 期望块序号
  unsigned long lastDataTime;
};
WriteSession wsession;
uint8_t lastWriteTarget = TARGET_LOCAL;  // 写会话目标（WRITE_BEGIN 记录，DATA/END/ABORT 复用）
/* 最近一次写会话相关帧的时间（本地+转发均更新）。
 * 从机收满数据即回 WRITE_RESULT（早于 App 发 WRITE_END），故不能靠 devState 判断会话边界；
 * 心跳/校时以此为准：写流量静默 2s 内不发起，避免 SYNC/PING 帧与写会话尾帧碰撞。 */
unsigned long lastWriteTrafficUs = 0;
inline bool writeTrafficRecent() {
  return wsession.active || microsElapsed(lastWriteTrafficUs) < 2000000UL;
}

const unsigned long WRITE_TIMEOUT_US = 3000000UL;  // 3s 会话超时

void beginWriteSession(uint8_t seq, const uint8_t *p, uint8_t n) {
  // payload = [target][storage][partition][totalBytes:2 LE][batchCrc:2 LE]
  if (n < 7) { sendNak(seq, ERR_PARAM); return; }
  uint8_t target = p[0];
  uint8_t storage = p[1];
  uint8_t partition = p[2];
  uint16_t totalBytes = p[3] | ((uint16_t)p[4] << 8);
  uint16_t batchCrc = p[5] | ((uint16_t)p[6] << 8);
  if (storage != STORAGE_SRAM && storage != STORAGE_EEPROM) { sendNak(seq, ERR_PARAM); return; }
  if (storage == STORAGE_EEPROM && partition > 7) { sendNak(seq, ERR_PARAM); return; }
  if (storage == STORAGE_SRAM && totalBytes > MAX_CMDS * 2) { sendNak(seq, ERR_PARAM); return; }
  if (devState == ST_WRITING) { sendNak(seq, ERR_BUSY); return; }

  // 停止播放并清理
  stopPlayback();
  if (storage == STORAGE_EEPROM) {
    if (eepromWriting) flushEepromCache();
    eepromWriting = true;
    eepromWriteBase = eepromBases[partition];
    eepromWriteAddr = eepromWriteBase;
    eepromCacheLen = 0;
    // 清分区头（结束标志）
    uint8_t endMark[2] = {0xFF, 0x00};
    eepromWritePage(eepromWriteBase, endMark, 2);
  } else {
    clearScore();
  }

  wsession.active = true;
  wsession.dst = target == TARGET_SLAVE ? DST_SLAVE : DST_PC;
  wsession.target = target;
  wsession.storage = storage;
  wsession.partition = partition;
  wsession.totalBytes = totalBytes;
  wsession.received = 0;
  wsession.batchCrc = batchCrc;
  wsession.expectedBlock = 0;
  wsession.lastDataTime = micros();
  syncing = false;  // 掐断进行中的校时：SYNC 帧与写数据帧会在半双工总线上碰撞
  devState = ST_WRITING;
  sendAck(seq, ERR_OK);
}

void handleWriteData(uint8_t seq, const uint8_t *p, uint8_t n) {
  if (!wsession.active) {
    // Bug C 兼容：整批已收满（finishWriteSession 已执行、active=false）后，
    // 广播总线回环可能让同一数据块再次到达。此时宽容回 ACK（数据其实已写入），
    // 避免 App 把"已完成"误判为 NAK 失败。
    if (wsession.received >= wsession.totalBytes && n >= 1) {
      uint8_t ack[2] = {p[0], ERR_OK};
      sendFrame(DST_PC, CMD_WRITE_DATA_ACK, ack, 2, seq);
      return;
    }
    sendNak(seq, ERR_STATE);
    return;
  }
  if (n < 1) { sendNak(seq, ERR_PARAM); return; }
  uint8_t blockSeq = p[0];
  uint8_t dlen = n - 1;
  wsession.lastDataTime = micros();
  lastWriteTrafficUs = micros();

  if (blockSeq != wsession.expectedBlock) {
    // 缺口：请求重发期望块
    uint8_t ack[2] = {wsession.expectedBlock, ERR_GAP};
    sendFrame(DST_PC, CMD_WRITE_DATA_ACK, ack, 2, seq);
    return;
  }

  // 写入数据
  if (wsession.storage == STORAGE_SRAM) {
    for (uint8_t i = 0; i + 1 < dlen; i += 2) {
      storeScoreData(p[1 + i], p[1 + i + 1]);
    }
  } else {
    if (eepromCacheLen + dlen > EEPROM_CACHE_SIZE) flushEepromCache();
    for (uint8_t i = 0; i < dlen; i++) eepromCache[eepromCacheLen++] = p[1 + i];
    if (eepromCacheLen >= EEPROM_CACHE_SIZE) flushEepromCache();
  }
  wsession.received += dlen;
  wsession.expectedBlock++;

  uint8_t ack[2] = {blockSeq, ERR_OK};
  sendFrame(DST_PC, CMD_WRITE_DATA_ACK, ack, 2, seq);

  // 收满：校验整批 CRC 并回 WRITE_RESULT
  if (wsession.received >= wsession.totalBytes) {
    finishWriteSession();
  }
}

void finishWriteSession() {
  // 半双工广播总线防碰撞：从机刚发完 WRITE_DATA_ACK，主机紧接着转发它到 PC（约 6ms+）。
  // 若本帧（WRITE_RESULT）紧跟发出，两帧会在总线上碰撞丢失（SRAM 写尤其明显，
  // 因 EEPROM 路径有慢速 I2C 回读天然错开）。此处先等待总线静默，让主机转发完再发。
  delay(20);
  if (wsession.storage == STORAGE_EEPROM) {
    flushEepromCache();
    eepromWriting = false;
    uint16_t written = eepromWriteAddr - eepromWriteBase;
    // 计算整批 CRC（需从 EEPROM 回读数据？不，批量 CRC 由 App 计算，设备回读验证）
    // 回读验证：读取 written 字节计算 CRC
    uint16_t calcCrc = 0;
    {
      uint16_t crc = 0xFFFF;
      for (uint16_t a = 0; a < written; a++) {
        uint8_t d = eepromReadByte(eepromWriteBase + a);
        crc ^= (uint16_t)d << 8;
        for (uint8_t j = 0; j < 8; j++) crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
      }
      calcCrc = crc;
    }
    bool crcOk = (calcCrc == wsession.batchCrc);
    uint8_t res[4] = {written & 0xFF, (written >> 8) & 0xFF, crcOk ? 1 : 0, crcOk ? ERR_OK : ERR_CRC};
    sendFrame(DST_PC, CMD_WRITE_RESULT, res, 4, 0);
  } else {
    // SRAM
    uint16_t written = wsession.received;
    // 计算 SRAM 数据的整批 CRC
    uint16_t crc = 0xFFFF;
    for (uint16_t i = 0; i < totalCmds; i++) {
      uint8_t d1 = cmdTicks[i];
      uint8_t d2 = cmdMotors[i];
      crc ^= (uint16_t)d1 << 8;
      for (uint8_t j = 0; j < 8; j++) crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
      crc ^= (uint16_t)d2 << 8;
      for (uint8_t j = 0; j < 8; j++) crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
    }
    bool crcOk = (crc == wsession.batchCrc);
    uint8_t res[4] = {written & 0xFF, (written >> 8) & 0xFF, crcOk ? 1 : 0, crcOk ? ERR_OK : ERR_CRC};
    sendFrame(DST_PC, CMD_WRITE_RESULT, res, 4, 0);
  }
  wsession.active = false;
  devState = ST_IDLE;
}

void handleWriteEnd(uint8_t seq) {
  // Bug B 兼容：已收满 totalBytes 时 finishWriteSession() 已执行（active=false 且回 WRITE_RESULT），
  // App 随后发的 WRITE_END 应直接 ACK，避免误报 ERR_STATE。
  if (!wsession.active && wsession.received >= wsession.totalBytes) {
    // 防碰撞：刚发完 WRITE_RESULT，主机可能仍在转发它到 PC；立即发 ACK 会与转发帧在总线上碰撞丢失。
    delay(20);
    sendAck(seq, ERR_OK);
    return;
  }
  if (!wsession.active) { sendNak(seq, ERR_STATE); return; }
  // 若未收满则强制收尾（以当前数据为准）；已收满走 finishWriteSession
  if (wsession.received < wsession.totalBytes) {
    finishWriteSession();
  }
  sendAck(seq, ERR_OK);
}

void writeSessionAbort(uint8_t err) {
  if (wsession.active) {
    if (wsession.storage == STORAGE_EEPROM) {
      flushEepromCache();
      eepromWriting = false;
    }
    wsession.active = false;
    devState = ST_IDLE;
    sendNak(0, err);
  }
}

void checkWriteTimeout() {
  if (wsession.active && microsElapsed(wsession.lastDataTime) > WRITE_TIMEOUT_US) {
    DBG_WARN(F("Write session timeout, abort\r\n"));
    writeSessionAbort(ERR_TIMEOUT);
  }
}

/* ===================== 控制指令处理 ===================== */
void execStop() {
  if (IS_MASTER) {
    if (dualMode) {
      unsigned long execTime = micros() + 200000ULL;
      scheduleFutureAction(execTime, 0x03, 0);
      sendControlData(3, execTime, 0);
      setSlaveState(SLAVE_IDLE);
      devState = ST_IDLE;
    } else {
      stopPlayback();
    }
  } else {
    stopPlayback();
  }
}

void execPause() {
  if (IS_MASTER) {
    if (dualMode) {
      unsigned long execTime = micros() + 200000ULL;
      scheduleFutureAction(execTime, 0x01, 0);
      sendControlData(1, execTime, 0);
      setSlaveState(SLAVE_PAUSED);
      devState = ST_PAUSED;
    } else {
      waitingLoop = false;
      waitingLoopSource = 0;
      isPause = true;
      devState = ST_PAUSED;
    }
  } else {
    waitingLoop = false;
    waitingLoopSource = 0;
    isPause = true;
    devState = ST_PAUSED;
  }
}

void execResume() {
  if (IS_MASTER) {
    if (dualMode) {
      unsigned long execTime = micros() + 200000ULL;
      scheduleFutureAction(execTime, 0x02, 0);
      sendControlData(2, execTime, 0);
      setSlaveState(SLAVE_PLAYING);
      devState = ST_PLAYING;
    } else {
      isPause = false;
      devState = ST_PLAYING;
    }
  } else {
    isPause = false;
    devState = ST_PLAYING;
  }
}

void execSramPlay() {
  if (IS_MASTER) {
    if (dualMode) {
      unsigned long execTime = micros() + 500000ULL;
      scheduleFutureAction(execTime, 0x04, 0);
      sendControlData(0, execTime, 0);
      setSlaveState(SLAVE_PLAYING);
      devState = ST_PLAYING;
    } else {
      startPlayback();
      devState = ST_PLAYING;
    }
  } else {
    startPlayback();
    devState = ST_PLAYING;
  }
}

void execEepromPlay(uint8_t partition) {
  if (partition > 7) { sendNak(0, ERR_PARAM); return; }
  if (IS_MASTER) {
    if (dualMode) {
      unsigned long execTime = micros() + 500000ULL;
      scheduleFutureAction(execTime, 0x05, partition);
      sendControlData(4, execTime, partition);
      setSlaveState(SLAVE_PLAYING);
      devState = ST_PLAYING;
    } else {
      playEepromPartition(partition);
      devState = ST_PLAYING;
    }
  } else {
    playEepromPartition(partition);
    devState = ST_PLAYING;
  }
}

/* ===================== 命令帧分发 ===================== */
void handleCommandFrame(uint8_t seq, uint8_t dst, uint8_t cmd, const uint8_t *payload, uint8_t n) {
  // 若为写会话中收到非写入命令，拒绝（防干扰）
  if (wsession.active && cmd != CMD_WRITE_DATA && cmd != CMD_WRITE_END && cmd != CMD_WRITE_ABORT) {
    sendNak(seq, ERR_BUSY);
    return;
  }

  // 写命令族（WRITE_BEGIN/DATA/END/ABORT）的目标设备由 WRITE_BEGIN 唯一决定：
  // - WRITE_BEGIN 载荷首字节是 target，写入 lastWriteTarget；
  // - WRITE_DATA 载荷首字节是 blockSeq（不是 target），block1 恰好==TARGET_SLAVE
  //   会被误判为发给从机；且写从机时主机会话不激活（BEGIN 仅转发），
  //   因此 DATA/END/ABORT 统一复用 lastWriteTarget 判定，不再看 payload[0]。
  if (cmd == CMD_WRITE_BEGIN) {
    lastWriteTarget = (n >= 1) ? payload[0] : TARGET_LOCAL;
  }
  bool toSlave = false;
  if (cmd == CMD_WRITE_BEGIN || cmd == CMD_WRITE_DATA || cmd == CMD_WRITE_END || cmd == CMD_WRITE_ABORT) {
    toSlave = (lastWriteTarget == TARGET_SLAVE);
  } else {
    uint8_t target = n >= 1 ? payload[0] : TARGET_LOCAL;
    toSlave = (target == TARGET_SLAVE);
  }

  switch (cmd) {
    case CMD_HELLO:
      // 连接握手：重置心跳链路状态（App 重连时重新评估从机在线性）
      lastHeartbeatTime = 0;
      awaitingPong = false;
      heartbeatMiss = 0;
      slaveLinkAlive = true;
      // 回 HELLO_ACK
      {
        uint8_t p[5];
        p[0] = PROTO_VER;
        p[1] = 0x00;  // capability 保留
        p[2] = 1; p[3] = 0;  // fw version 1.0
        p[4] = (IS_MASTER ? 1 : 0) | (IS_LEFT ? 2 : 0);
        sendFrame(DST_PC, CMD_HELLO_ACK, p, 5, seq);
        // 设备就绪事件
        uint8_t ev[0];
        sendEvent(EVT_DEVICE_READY, ev, 0);
      }
      break;
    case CMD_PING:
      {
        uint8_t flags = devState;
        sendFrame(DST_PC, CMD_PONG, &flags, 1, seq);
      }
      break;
    case CMD_STOP:
      if (IS_MASTER && !dualMode && toSlave) { forwardToSlave(seq, cmd, payload, n); setSlaveState(SLAVE_IDLE); }
      else { execStop(); sendAck(seq, ERR_OK); }
      break;
    case CMD_PAUSE:
      if (IS_MASTER && !dualMode && toSlave) { forwardToSlave(seq, cmd, payload, n); setSlaveState(SLAVE_PAUSED); }
      else { execPause(); sendAck(seq, ERR_OK); }
      break;
    case CMD_RESUME:
      if (IS_MASTER && !dualMode && toSlave) { forwardToSlave(seq, cmd, payload, n); setSlaveState(SLAVE_PLAYING); }
      else { execResume(); sendAck(seq, ERR_OK); }
      break;
    case CMD_RESET:
      if (IS_MASTER && !dualMode && toSlave) { forwardToSlave(seq, cmd, payload, n); setSlaveState(SLAVE_IDLE); }
      else { systemReset(); sendAck(seq, ERR_OK); }
      break;
    case CMD_SRAM_PLAY:
      if (IS_MASTER && !dualMode && toSlave) { forwardToSlave(seq, cmd, payload, n); setSlaveState(SLAVE_PLAYING); }
      else { execSramPlay(); sendAck(seq, ERR_OK); }
      break;
    case CMD_EEPROM_PLAY:
      if (n < 2) { sendNak(seq, ERR_PARAM); break; }
      if (IS_MASTER && !dualMode && toSlave) { forwardToSlave(seq, cmd, payload, n); setSlaveState(SLAVE_PLAYING); }
      else { execEepromPlay(payload[1]); sendAck(seq, ERR_OK); }
      break;
    case CMD_CLEAR_SRAM:
      if (IS_MASTER && (dualMode || toSlave)) forwardToSlave(seq, cmd, payload, n);
      clearScore();
      sendAck(seq, ERR_OK);
      break;
    case CMD_CLEAR_EEPROM:
      if (n < 2) { sendNak(seq, ERR_PARAM); break; }
      if (payload[1] > 7) { sendNak(seq, ERR_PARAM); break; }
      if (IS_MASTER && (dualMode || toSlave)) forwardToSlave(seq, cmd, payload, n);
      if (!toSlave || !IS_MASTER) {
        if (eepromWriting) { flushEepromCache(); eepromWriting = false; }
        uint8_t endMark[2] = {0xFF, 0x00};
        eepromWritePage(eepromBases[payload[1]], endMark, 2);
      }
      sendAck(seq, ERR_OK);
      break;
    case CMD_JUMP_BAR:
      if (n < 2) { sendNak(seq, ERR_PARAM); break; }
      if (IS_MASTER && (dualMode || toSlave)) forwardToSlave(seq, cmd, payload, n);
      {
        uint8_t targetBar = payload[1];
        if (isPlaying && !eepromPlaying) {
          if (targetBar < 1 || targetBar > sramBarCount) { sendNak(seq, ERR_PARAM); break; }
          currentCmdIndex = sramBarStartIndex[targetBar - 1];
          sramPlayFromAbsTick = (uint32_t)(targetBar - 1) * totalTicksPerBar;
          unsigned long nowUs = playbackAnchorTime();
          sectionStartTime = nowUs;
          if (isPause) pauseStartTime = nowUs;
          for (int i = 0; i < numLeds; i++) analogWrite(ledPins[i], 0);
          currentMotorState = 0;
        } else if (eepromPlaying) {
          if (targetBar < 1 || targetBar > eepromBarCount) { sendNak(seq, ERR_PARAM); break; }
          eepromReadAddr = eepromBarStartIndex[targetBar - 1];
          eepromCmdReady = false;
          eepromLastTick = 0;
          eepromAbsTick = 0;
          unsigned long nowUs = playbackAnchorTime();
          eepromSectionStart = nowUs;
          if (isPause) eepromPauseStart = nowUs;
          for (int i = 0; i < numLeds; i++) analogWrite(ledPins[i], 0);
          currentMotorState = 0;
        } else {
          sendNak(seq, ERR_STATE);
          break;
        }
      }
      sendAck(seq, ERR_OK);
      break;
    case CMD_SET_MODE:
      if (n < 2) { sendNak(seq, ERR_PARAM); break; }
      if (IS_MASTER) forwardToSlave(seq, cmd, payload, n);  // 模式全局，总是转发
      stopPlayback();
      setSlaveState(SLAVE_IDLE);
      if (payload[1] == 0) {
        dualMode = false;
      } else {
        dualMode = true;
        if (IS_MASTER) { timeSynced = false; startTimingSync(); }
      }
      sendAck(seq, ERR_OK);
      break;
    case CMD_SET_BPM:
      if (n < 3) { sendNak(seq, ERR_PARAM); break; }
      {
        uint16_t newBpm = payload[1] | ((uint16_t)payload[2] << 8);
        if (newBpm < 1 || newBpm > 300) { sendNak(seq, ERR_PARAM); break; }
        bpm = newBpm;
        recalcTiming();
        if (IS_MASTER && (dualMode || toSlave)) forwardToSlave(seq, cmd, payload, n);
      }
      sendAck(seq, ERR_OK);
      break;
    case CMD_SET_TIME_SIG:
      if (n < 2) { sendNak(seq, ERR_PARAM); break; }
      beatsPerBar = payload[1];
      if (beatsPerBar == 0) beatsPerBar = 4;
      recalcTiming();
      if (IS_MASTER && (dualMode || toSlave)) forwardToSlave(seq, cmd, payload, n);
      sendAck(seq, ERR_OK);
      break;
    case CMD_SET_TPS:
      if (n < 2) { sendNak(seq, ERR_PARAM); break; }
      if (payload[1] == 0) ticksPerBeat = 32;
      else if (payload[1] == 1) ticksPerBeat = 16;
      else if (payload[1] == 2) ticksPerBeat = 8;
      else { sendNak(seq, ERR_PARAM); break; }
      recalcTiming();
      if (IS_MASTER && (dualMode || toSlave)) forwardToSlave(seq, cmd, payload, n);
      sendAck(seq, ERR_OK);
      break;
    case CMD_SET_INTENSITY:
      if (n < 3) { sendNak(seq, ERR_PARAM); break; }
      if (payload[1] >= 5) { sendNak(seq, ERR_PARAM); break; }
      motorIntensity[payload[1]] = payload[2];
      if (IS_MASTER && toSlave) forwardToSlave(seq, cmd, payload, n);
      sendAck(seq, ERR_OK);
      break;
    case CMD_WRITE_BEGIN:
      // 目标为从机时由主机转发
      if (IS_MASTER && toSlave) {
        // 转发写会话：掐断进行中的校时并标记写流量（心跳/校时静默门控，
        // 避免 SYNC 帧与写数据帧在半双工广播总线上碰撞）。
        syncing = false;
        lastWriteTrafficUs = micros();
        forwardToSlave(seq, cmd, payload, n);
      } else {
        beginWriteSession(seq, payload, n);
      }
      break;
    case CMD_WRITE_DATA:
      // 目标为从机（写右手）时由主机转发；否则本地写入
      if (IS_MASTER && toSlave) {
        lastWriteTrafficUs = micros();
        forwardToSlave(seq, cmd, payload, n);
      } else {
        handleWriteData(seq, payload, n);
      }
      break;
    case CMD_WRITE_END:
      if (IS_MASTER && toSlave) {
        lastWriteTrafficUs = micros();
        forwardToSlave(seq, cmd, payload, n);
      } else {
        handleWriteEnd(seq);
      }
      break;
    case CMD_WRITE_ABORT:
      if (IS_MASTER && toSlave) {
        lastWriteTrafficUs = micros();
        forwardToSlave(seq, cmd, payload, n);
      } else {
        writeSessionAbort(ERR_ABORT);
      }
      break;
    case CMD_SYNC_REQ:
      // 主机收到 App 的校时请求？App 不发，忽略；从机走 handleSyncReq
      break;
    case CMD_SET_ROLE:
      if (n >= 1) {
        writeRoleConfig(payload[0]);
        sendAck(seq, ERR_OK);
        // 复位生效
        delay(50);
        void (*resetFunc)(void) = 0;
        resetFunc();
      } else {
        sendNak(seq, ERR_PARAM);
      }
      break;
    default:
      sendNak(seq, ERR_PARAM);
      break;
  }
}

/* ===================== 从机响应处理（主机收到从机回的响应） ===================== */
void handleSlaveResponse(uint8_t seq, uint8_t cmd, const uint8_t *payload, uint8_t n) {
  if (!IS_MASTER) return;
  switch (cmd) {
    case CMD_SYNC_REP:
      handleSyncRep(payload, n);
      break;
    case CMD_SYNC_ACK:
      // 校时 offset 已应用，忽略
      break;
    case CMD_PONG:
      // 只认主机发往从机的 PING(seq=0) 的回传 PONG；App 心跳 PONG 会被透传模块
      // 回环到本机 RX，若不按 seq 滤除，会把 awaitingPong 反复清零导致断链检测失效。
      if (seq == 0) handleSlavePong();
      break;
    case CMD_WRITE_DATA_ACK:
    case CMD_WRITE_RESULT:
      // 写会话响应：标记写流量（WRITE_RESULT 早于 App 的 WRITE_END 到达，
      // 不能据此恢复校时/心跳，须等流量静默）。
      lastWriteTrafficUs = micros();
      // 转发给 PC（App 匹配）
      forwardToPc(seq, cmd, payload, n);
      break;
    case CMD_ACK:
    case CMD_NAK:
    case CMD_HELLO_ACK:
      // 转发给 PC（App 匹配）
      forwardToPc(seq, cmd, payload, n);
      break;
    default:
      forwardToPc(seq, cmd, payload, n);
      break;
  }
}

/* ===================== 从机命令执行（从机收到 DST_SLAVE 命令） ===================== */
void handleSlaveCommand(uint8_t seq, uint8_t cmd, const uint8_t *payload, uint8_t n) {
  // 从机只处理发给自己的命令段
  if (wsession.active && cmd != CMD_WRITE_DATA && cmd != CMD_WRITE_END && cmd != CMD_WRITE_ABORT) {
    sendNak(seq, ERR_BUSY);
    return;
  }

  switch (cmd) {
    case CMD_PING:
      {
        uint8_t flags = devState;
        sendFrame(DST_PC, CMD_PONG, &flags, 1, seq);
      }
      break;
    case CMD_HELLO:
      {
        uint8_t p[5];
        p[0] = PROTO_VER;
        p[1] = 0x00;
        p[2] = 1; p[3] = 0;
        p[4] = (IS_MASTER ? 1 : 0) | (IS_LEFT ? 2 : 0);
        sendFrame(DST_PC, CMD_HELLO_ACK, p, 5, seq);
      }
      break;
    case CMD_STOP: execStop(); sendAck(seq, ERR_OK); break;
    case CMD_PAUSE: execPause(); sendAck(seq, ERR_OK); break;
    case CMD_RESUME: execResume(); sendAck(seq, ERR_OK); break;
    case CMD_RESET: systemReset(); sendAck(seq, ERR_OK); break;
    case CMD_SRAM_PLAY: execSramPlay(); sendAck(seq, ERR_OK); break;
    case CMD_EEPROM_PLAY:
      if (n < 2) { sendNak(seq, ERR_PARAM); break; }
      execEepromPlay(payload[1]);
      sendAck(seq, ERR_OK);
      break;
    case CMD_CLEAR_SRAM: clearScore(); sendAck(seq, ERR_OK); break;
    case CMD_CLEAR_EEPROM:
      if (n < 2) { sendNak(seq, ERR_PARAM); break; }
      if (payload[1] > 7) { sendNak(seq, ERR_PARAM); break; }
      if (eepromWriting) { flushEepromCache(); eepromWriting = false; }
      {
        uint8_t endMark[2] = {0xFF, 0x00};
        eepromWritePage(eepromBases[payload[1]], endMark, 2);
      }
      sendAck(seq, ERR_OK);
      break;
    case CMD_JUMP_BAR:
      if (n < 2) { sendNak(seq, ERR_PARAM); break; }
      {
        uint8_t targetBar = payload[1];
        if (isPlaying && !eepromPlaying) {
          if (targetBar < 1 || targetBar > sramBarCount) { sendNak(seq, ERR_PARAM); break; }
          currentCmdIndex = sramBarStartIndex[targetBar - 1];
          sramPlayFromAbsTick = (uint32_t)(targetBar - 1) * totalTicksPerBar;
          unsigned long nowUs = playbackAnchorTime();
          sectionStartTime = nowUs;
          if (isPause) pauseStartTime = nowUs;
          for (int i = 0; i < numLeds; i++) analogWrite(ledPins[i], 0);
          currentMotorState = 0;
        } else if (eepromPlaying) {
          if (targetBar < 1 || targetBar > eepromBarCount) { sendNak(seq, ERR_PARAM); break; }
          eepromReadAddr = eepromBarStartIndex[targetBar - 1];
          eepromCmdReady = false;
          eepromLastTick = 0;
          eepromAbsTick = 0;
          unsigned long nowUs = playbackAnchorTime();
          eepromSectionStart = nowUs;
          if (isPause) eepromPauseStart = nowUs;
          for (int i = 0; i < numLeds; i++) analogWrite(ledPins[i], 0);
          currentMotorState = 0;
        } else {
          sendNak(seq, ERR_STATE);
          break;
        }
      }
      sendAck(seq, ERR_OK);
      break;
    case CMD_SET_MODE:
      if (n < 2) { sendNak(seq, ERR_PARAM); break; }
      stopPlayback();
      if (payload[1] == 0) dualMode = false;
      else dualMode = true;
      sendAck(seq, ERR_OK);
      break;
    case CMD_SET_BPM:
      if (n < 3) { sendNak(seq, ERR_PARAM); break; }
      {
        uint16_t newBpm = payload[1] | ((uint16_t)payload[2] << 8);
        if (newBpm < 1 || newBpm > 300) { sendNak(seq, ERR_PARAM); break; }
        bpm = newBpm;
        recalcTiming();
      }
      sendAck(seq, ERR_OK);
      break;
    case CMD_SET_TIME_SIG:
      if (n < 2) { sendNak(seq, ERR_PARAM); break; }
      beatsPerBar = payload[1];
      if (beatsPerBar == 0) beatsPerBar = 4;
      recalcTiming();
      sendAck(seq, ERR_OK);
      break;
    case CMD_SET_TPS:
      if (n < 2) { sendNak(seq, ERR_PARAM); break; }
      if (payload[1] == 0) ticksPerBeat = 32;
      else if (payload[1] == 1) ticksPerBeat = 16;
      else if (payload[1] == 2) ticksPerBeat = 8;
      else { sendNak(seq, ERR_PARAM); break; }
      recalcTiming();
      sendAck(seq, ERR_OK);
      break;
    case CMD_SET_INTENSITY:
      if (n < 3) { sendNak(seq, ERR_PARAM); break; }
      if (payload[1] >= 5) { sendNak(seq, ERR_PARAM); break; }
      motorIntensity[payload[1]] = payload[2];
      sendAck(seq, ERR_OK);
      break;
    case CMD_WRITE_BEGIN: beginWriteSession(seq, payload, n); break;
    case CMD_WRITE_DATA: handleWriteData(seq, payload, n); break;
    case CMD_WRITE_END: handleWriteEnd(seq); break;
    case CMD_WRITE_ABORT: writeSessionAbort(ERR_ABORT); break;
    case CMD_SYNC_REQ: handleSyncReq(seq, payload, n); break;
    case CMD_SYNC_OFFSET: handleSyncOffset(seq, payload, n); break;
    default: sendNak(seq, ERR_PARAM); break;
  }
}

/* 兼容旧 0x40/0x41 控制分包（从机） */
void handleLegacyControlPacket(uint8_t cmd, const uint8_t *payload, uint8_t n) {
  if (cmd == 0x40) {
    if (n >= 2) {
      expectingDataPacket = true;
      dataPacketType = payload[0] & 0x0F;
      dataPacketParam = (payload[0] >> 4) & 0x0F;
      if (payload[1] != 0) dataPacketParam = payload[1];
      dataPacketValue = 0;
      dataPacketIndex = 0;
      dataPacketStartTime = micros();
    }
  } else if (cmd == 0x41) {
    if (expectingDataPacket && n >= 4) {
      for (uint8_t i = 0; i < 4; i++) dataPacketValue |= (uint32_t)payload[i] << (i * 8);
      expectingDataPacket = false;
      uint8_t action = dataPacketType;
      uint8_t internalAction = 0;
      uint8_t param = dataPacketParam;
      switch (action) {
        case 0: internalAction = 0x04; break;  // SRAM 播放
        case 1: internalAction = 0x01; break;  // 暂停
        case 2: internalAction = 0x02; break;  // 继续
        case 3: internalAction = 0x03; break;  // 停止
        case 4: internalAction = 0x05; break;  // EEPROM 分区播放
        default: return;
      }
      int64_t localExecTime = (int64_t)dataPacketValue + (int64_t)timeOffset;
      if (localExecTime < 0) localExecTime = 0;
      scheduleFutureAction((unsigned long)localExecTime, internalAction, param);
    }
  }
}

/* ===================== 初始化 ===================== */
void setup() {
  for (int i = 0; i < numLeds; i++) {
    pinMode(ledPins[i], OUTPUT);
    analogWrite(ledPins[i], 0);
  }

  // 板载 USB 串口监视器（调试输出，115200）
  Serial.begin(115200);

  // 蓝牙 SoftwareSerial：38400
  bt.begin(38400);

  Wire.begin();
  {
    Wire.beginTransmission(0x50);
    if (Wire.endTransmission() == 0) DBG_INFO(F("EEPROM found at 0x50\r\n"));
    else DBG_ERROR(F("EEPROM NOT found at 0x50!\r\n"));
  }

  readRoleConfig();
  recalcTiming();
  clearScore();
  decoder.reset();
  wsession.active = false;
  devState = ST_IDLE;

#if DBG_LEVEL >= 3
  DBG_INFO(F("Glove ready: "));
  Serial.println(IS_LEFT ? F("LEFT") : F("RIGHT"));
  DBG_INFO(F("Role: "));
  Serial.println(IS_MASTER ? F("MASTER") : F("SLAVE"));
#endif
}

/* ===================== 主循环 ===================== */
void loop() {
  // ---- 接收并解帧（蓝牙 SoftwareSerial） ----
  while (bt.available()) {
    uint8_t b = bt.read();
    if (decoder.feed(b)) {
      // 组装完一帧
      uint8_t seq = decoder.seq;
      uint8_t dst = decoder.dst;
      uint8_t cmd = decoder.cmd;
      uint8_t pl[MAX_PAYLOAD];
      uint8_t n = decoder.payloadLen;
      for (uint8_t i = 0; i < n; i++) pl[i] = decoder.payload[i];

      if (IS_MASTER) {
        // 主机：命令段来自 PC（DST_PC 本地 / DST_SLAVE 转发）；响应段来自从机
        if (cmd < 0x80) {
          if (dst == DST_SLAVE) {
            // PC 发来的、指定目标从机的命令：转发
            if (cmd >= 0x30 && cmd <= 0x3F) {
              // 校时类命令仅主从内部用，PC 不应直接发；忽略
            } else {
              forwardToSlave(seq, cmd, pl, n);
            }
          } else {
            // 0x40/0x41 旧控制分包（本机产生？不，主机不发给自己；兼容处理）
            if (cmd == 0x40 || cmd == 0x41) {
              // 主机不应收到自己的包，忽略
            } else {
              handleCommandFrame(seq, dst, cmd, pl, n);
            }
          }
        } else {
          // 响应段：从机回的
          handleSlaveResponse(seq, cmd, pl, n);
        }
      } else {
        // 从机：只处理 DST_SLAVE 的命令段；忽略其他（DST_PC / 响应段）
        if (dst == DST_SLAVE && cmd < 0x80) {
          if (cmd == 0x40 || cmd == 0x41) {
            handleLegacyControlPacket(cmd, pl, n);
          } else if (cmd == CMD_SYNC_REQ || cmd == CMD_SYNC_OFFSET) {
            handleSlaveCommand(seq, cmd, pl, n);
          } else {
            handleSlaveCommand(seq, cmd, pl, n);
          }
        }
      }
    }
  }

  // ---- 后台任务 ----
  pollEepromWrite();

  // 校时：周期发起（主机，双手模式，避开写会话及写流量静默期）
  if (dualMode && IS_MASTER) {
    const bool scoreBusy = wsession.active || writeTrafficRecent();
    if (!scoreBusy && !syncing &&
        (!timeSynced || microsElapsed(lastSyncTime) > SYNC_INTERVAL)) {
      startTimingSync();
    }
  }
  // 校时等待超时（从机不可达时避免 2s 死循环刷帧）
  if (syncing && syncWaitRep && microsElapsed(syncWaitTimeout) > SYNC_WAIT_TIMEOUT_US) {
    syncWaitRep = false;
    if (++syncRetries >= SYNC_MAX_RETRIES) {
      DBG_WARN(F("Sync give up, slave unreachable\r\n"));
      syncing = false;
      syncRetries = 0;
      devState = ST_IDLE;
    } else {
      continueTimingSync();  // 重试当前轮
    }
  }
  // 从机校时超时
  if (!IS_MASTER && slaveSyncActive && microsElapsed(slaveSyncTimeout) > SLAVE_SYNC_TIMEOUT_US) {
    slaveSyncActive = false;
  }

  // 心跳：写流量静默期不发 PING（半双工总线上 PING/PONG 易与写会话帧碰撞；
  // 静默期跳过整个心跳调度，miss 计数不会被误累加）
  if (!writeTrafficRecent()) {
    handleHeartbeat();
    checkSlaveLink();
  }

  // 写会话超时
  checkWriteTimeout();

  checkFutureAction();
  eepromSchedule();
  schedulePlayback();
}
