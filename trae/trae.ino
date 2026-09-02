#include <SoftwareSerial.h>
#include <Wire.h>

// ================= 硬件引脚定义 =================
SoftwareSerial bt(2, 11);            // 蓝牙软串口 RX=2, TX=11
const int ledPins[] = {3, 5, 6, 9, 10};   // 5 个 LED（模拟马达）
const int numLeds = 5;

// ================= 模式配置（烧录时固定） =================
const bool IS_LEFT = 1;        // true=左手, false=右手（烧录时修改）
const bool IS_MASTER = 1;      // true=主, false=从（烧录时修改）

// ================= 乐谱存储（SRAM） =================
#define MAX_CMDS 32
uint8_t cmdTicks[MAX_CMDS];      // 节拍位置（0~255，单位 1/32 拍）
uint8_t cmdMotors[MAX_CMDS];     // 马达控制字节
uint16_t totalCmds = 0;

// ================= EEPROM 页写入 =================
#define EEPROM_PAGE_SIZE   64    // AT24C256 页大小
#define EEPROM_CACHE_SIZE  30    // Wire缓冲区限制：32-2=30字节数据
uint8_t eepromCache[EEPROM_CACHE_SIZE];
uint8_t eepromCacheLen = 0;

// ================= EEPROM 分区定义 =================
const uint16_t eepromBases[] = {
  0x0000, // 0: 临时区
  0x1000, // 1: 固定区第1首
  0x2000, // 2: 固定区第2首
  0x3000, // 3: 固定区第3首
  0x4000, // 4: 固定区第4首
  0x5000, // 5: 固定区第5首
  0x6000, // 6: 固定区第6首
  0x7000  // 7: 预留区
};
const uint16_t EEPROM_SECTION_SIZE = 0x1000; // 每个分区大小

// ================= 播放状态 =================
bool isPlaying = false;           // 是否正在播放
bool loopPlayback = true;         // 是否循环播放（默认 true）
bool isPause = false;             // 是否暂停
unsigned long pauseStartTime = 0; // 记录进入暂停的时刻
unsigned long totalPauseTime = 0; // 暂停累计时长
unsigned long sectionStartTime = 0; // 当前小节的起始毫秒
uint16_t currentCmdIndex = 0;     // 当前执行到的指令索引
uint8_t currentMotorState = 0;    // 当前所有马达的状态，用于暂停恢复

// ---- 单调绝对 tick 播放（时序优化）----
// 播放时间基准（sectionStartTime）只在播放开始/恢复/跳转时设置，播放中永不偏移。
// 每条指令的绝对 tick（从播放起点累计）预计算到 sramAbsTicks，调度只比较
// elapsedTicks >= 绝对tick，彻底避免旧"回绕时偏移时间"的无符号下溢缺陷
// （跨小节那一帧剩余指令会瞬间全部执行）。
uint32_t sramAbsTicks[MAX_CMDS];      // 每条 SRAM 指令的绝对 tick
uint8_t sramBarStartIndex[MAX_CMDS];  // 每个小节第一条指令的下标（最多 32 个）
uint8_t sramBarCount = 0;             // SRAM 乐谱的小节数
// 当前播放位置的小节起点（跳转后 = 目标小节起点）。调度时把 sramAbsTicks（全曲绝对）
// 减去它转成"相对当前播放位置"，配合 sectionStartTime 清零，避免跳转回退时间产生负数。
uint32_t sramPlayFromAbsTick = 0;

// ================= 运行时模式（可切换，不保存） =================
bool dualMode = 0;           // true=双手模式, false=单手模式（默认双手）

// ================= 乐谱目标设备 =================
const uint8_t TARGET_LOCAL = 0;   // 本地（左手/主机）
const uint8_t TARGET_SLAVE = 1;   // 从机（右手）
uint8_t scoreTarget = TARGET_LOCAL;  // 当前乐谱目标设备，默认左手

// ================= 从机状态管理（主机维护，非阻塞推断） =================
// 显式指定 uint8_t 底层类型，避免默认 int 占用 2 字节
enum SlaveState : uint8_t {
    SLAVE_IDLE,        // 空闲，可接收新乐谱
    SLAVE_RECEIVING,   // 正在接收乐谱数据
    SLAVE_READY,       // 乐谱已完整接收，可播放
    SLAVE_PLAYING,     // 正在播放
    SLAVE_PAUSED,      // 已暂停
    SLAVE_ERROR        // 通信异常或超时
};
SlaveState slaveState = SLAVE_IDLE;  // 从机状态（仅主机使用）

// ================= 马达强度设置（PWM） =================
// 引脚索引: 0=pin3, 1=pin5, 2=pin6, 3=pin9, 4=pin10
// 默认值128 (50%占空比)，通过 0xF9 0x25 指令动态调整
uint8_t motorIntensity[5] = {128, 128, 128, 128, 128};

// ================= 循环等待状态 =================
bool waitingLoop = false;         // 是否处于播放结束等待重启状态
unsigned long waitStartTime = 0;
uint8_t waitingLoopSource = 0;    // 等待的播放源：1=SRAM, 2=EEPROM
const unsigned long LOOP_DELAY_US = 500000;   // 500ms

// ================= EEPROM 播放状态 =================
bool eepromPlaying = false;           // 是否正在从 EEPROM 播放
uint16_t eepromReadBase = 0;          // 播放基地址（分区起始）
uint16_t eepromReadAddr = 0;          // 当前读取地址
uint8_t eepromCurTick = 0;            // 当前指令的节拍位置
uint8_t eepromCurMotor = 0;           // 当前指令的马达控制
uint8_t eepromLastTick = 0;           // 上一条指令的节拍位置（用于检测小节回绕）
uint32_t eepromAbsTick = 0;           // 当前指令的绝对 tick（从播放起点累计，单调递增）
bool eepromCmdReady = false;          // 当前指令缓存是否有效
unsigned long eepromSectionStart = 0; // EEPROM 播放的起始时刻（播放中不偏移）
unsigned long eepromPauseStart = 0;   // EEPROM 暂停时刻（与 isPause 配合）
unsigned long eepromTotalPause = 0;   // EEPROM 暂停累计时长

// ---- EEPROM 小节跳转映射 ----
#define MAX_BARS 128              // 支持跳转的最大小节数（内存限制，每小节 2 字节）
uint16_t eepromBarStartIndex[MAX_BARS]; // 每个小节第一条指令的 EEPROM 地址
uint8_t eepromBarCount = 0;       // EEPROM 乐谱的小节数

// ================= EEPROM 写入状态 =================
bool eepromWriting = false;           // 是否处于 EEPROM 写入模式
uint16_t eepromWriteAddr = 0;         // 当前 EEPROM 写入地址指针
uint16_t eepromWriteBase = 0;         // 当前 EEPROM 写入基地址

// ================= 节奏参数 =================
uint16_t bpm = 120;               // 默认 120 BPM
uint8_t beatsPerBar = 4;          // 默认 4/4 拍
uint8_t ticksPerBeat = 32;        // 每拍拆成 32 个 tick
uint32_t tickDurationUs;          // 每个 tick 的微秒数
uint32_t barDurationUs;   // 小节时长（微秒）
uint16_t totalTicksPerBar = 128;  // 每小节总 tick 数（Tm = beatsPerBar × ticksPerBeat），recalcTiming 更新

// ================= 校验控制 =================
bool enableXorCheck = false;  // true=开启校验, false=关闭校验（调试模式）

// ================= 双手模式同步变量 =================
bool timeSynced = false;
int32_t timeOffset = 0;
unsigned long lastSyncTime = 0;
const unsigned long SYNC_INTERVAL = 30000000UL;  // 【修复1】30秒，微秒
bool waitingForTimingReply = false;
unsigned long timingReplyTimeout = 0;
unsigned long dataPacketStartTime = 0;
const unsigned long DATA_PACKET_TIMEOUT = 100000UL;  // 【修复1】100ms，微秒

// ---- 校时状态机（主设备） ----
enum MasterTimingState {
  MT_IDLE,
  MT_WAIT_31,        // 已发0x30，等待0x31
  MT_WAIT_T_RECV,    // 已收0x31，等待从机发T_recv分包
  MT_WAIT_OFFSET_ACK // 已发offset，等待0x36确认
};
MasterTimingState masterTimingState = MT_IDLE;
uint32_t T_send = 0;
uint32_t T_recv = 0;
uint32_t T_back = 0;
uint8_t recvBuffer[4];
uint8_t recvIndex = 0;

// ---- 校时状态机（从设备） ----
enum SlaveTimingState {
  ST_IDLE,
  ST_WAIT_OFFSET      // 已发0x31，等待主设备发offset分包
};
SlaveTimingState slaveTimingState = ST_IDLE;
uint8_t offsetBuffer[4];
uint8_t offsetIndex = 0;
uint32_t slave_T_recv = 0;
// 新增：从设备超时控制
unsigned long slaveTimingTimeout = 0;      // 当前阶段开始等待的时间点
const unsigned long SLAVE_TIMING_TIMEOUT = 5000000UL;  // 【修复1】5秒，微秒
// 【校时补偿】从机收包→回包处理 + 蓝牙模组串行化固定时延（微秒），消除 RTT/2 过估导致从机提前
const int32_t TIMING_STATIC_COMP_US = 8000;

// ---- 分包接收状态（用于接收控制指令的执行时间） ----
bool expectingDataPacket = false;
uint8_t dataPacketType = 0;        // 0=播放, 1=暂停, 2=继续, 3=停止
uint32_t dataPacketValue = 0;
uint8_t dataPacketIndex = 0;
uint8_t dataPacketParam = 0;   // 播放源参数（由 0x40 指令传递）

// 未来动作（延迟执行的控制指令）
bool hasFutureAction = false;         // 是否有待执行的未来动作
unsigned long futureExecTime = 0;     // 未来执行时刻（本地时钟）
uint8_t futureActionCmd = 0;          // 未来动作类型
uint8_t futureActionParam = 0;        // 未来动作参数

// 每帧最多执行的播放指令数（防止 inner while 阻塞蓝牙接收）
const uint8_t MAX_CMDS_PER_FRAME = 16;

// ================= 函数声明 =================
void recalcTiming();
void startPlayback();
void stopPlayback();
void executeCommand(uint8_t motorCtrl);
void schedulePlayback();
void clearScore();
void storeScoreData(uint8_t beatPos, uint8_t motorCtrl);
void parseCommand(uint8_t *cmd);
void systemReset();
void playEepromPartition(uint8_t partition);
void eepromWriteByte(uint16_t addr, uint8_t data);
uint8_t eepromReadByte(uint16_t addr);
bool eepromFetchNext();
void eepromSchedule();

// 新增函数声明
void initBluetooth();
void handleMasterTasks();
void handleSlaveTasks();
void startTimingSync();
void applyOffset(int32_t offset);
void scheduleFutureAction(unsigned long execTime, uint8_t action, uint8_t param);
void checkFutureAction();
void forwardToSlave(uint8_t *cmd);
void switchMode(uint8_t mode);
void sendControlData(uint8_t actionType, uint32_t execTime,uint8_t param); // 发送控制数据分包给从机
void clearMasterTimingBuffers();
void clearSlaveTimingBuffers();
void eepromWritePage(uint16_t addr, uint8_t *data, uint8_t len);
void flushEepromCache();
unsigned long playbackAnchorTime();  // 播放起始时刻（含从设备校时偏移）
void setSlaveState(SlaveState newState);  // 调试：打印并更新从机状态

// ================= XOR 校验函数 =================
bool verifyXor(uint8_t sync, uint8_t b1, uint8_t b2, uint8_t b3) ;

// 【修复2】micros() 溢出安全：标准 uint32 无符号差比较，消除 int32 截断隐患
inline bool microsReached(unsigned long target) {
  return (uint32_t)(micros() - target) < 0x80000000UL;
}

// micros() 溢出安全：计算 elapsed 微秒
inline uint64_t microsElapsed(unsigned long start) {
  return (uint64_t)(micros() - start);
}

// ================= 计算时间参数 =================
void recalcTiming() {
  if (bpm == 0) bpm = 120;  // 防止除零
  uint32_t beatDurationUs = 60000000UL / bpm;
  tickDurationUs = beatDurationUs / ticksPerBeat;  // 修复：此前未赋值导致 tick 除零
  if (tickDurationUs == 0) tickDurationUs = 1;     // 防止除零
  barDurationUs = beatsPerBar * beatDurationUs;   // 微秒
  totalTicksPerBar = beatsPerBar * ticksPerBeat;  // 每小节总 tick 数（Tm），绝对 tick 换算用
}

// 【双手模式/从设备】播放锚点时刻：主设备用本地 micros，从设备叠加校时偏移
unsigned long playbackAnchorTime() {
  unsigned long t = micros();
  if (dualMode && !IS_MASTER) {
    // offset = slave - master_est → master_time = slave_local - offset
    int64_t adjusted = (int64_t)t - (int64_t)timeOffset;
    if (adjusted < 0) adjusted = 0;
    // 【修复3】上限钳位，防止 timeOffset 叠加后 uint32 溢出
    if (adjusted > UINT32_MAX) adjusted = UINT32_MAX;
    return (unsigned long)adjusted;
  }
  return t;
}

// ================= 蓝牙初始化（根据左右手设置名称） =================
void initBluetooth() {
  Serial.print(F("Bluetooth initialized as: "));
  Serial.println(IS_LEFT ? F("Glove_Left") : F("Glove_Right"));
  Serial.print(F("Role: "));
  Serial.println(IS_MASTER ? F("Master") : F("Slave"));
}

// ================= 开始播放（重置所有状态） =================
// 【SRAM内存播放】
void startPlayback() {
  Serial.println(F("startPlayback called"));
  // 清除循环等待状态，确保新播放立即响应
  waitingLoop = false;
  waitingLoopSource = 0;
  // [调试] 打印播放启动时的缓存指令总数
  Serial.print(F("[PLAY] totalCmds="));
  Serial.println(totalCmds);
  if (totalCmds == 0) return;

  // 预计算每条指令的绝对 tick（单调时间轴）与小节映射：
  // - 绝对 tick = 小节号 × totalTicksPerBar + 小节内 tick，tick 变小（回绕）表示跨小节
  // - sramBarStartIndex[bar] 记录每个小节第一条指令的下标，供 0x26 跳转使用
  uint32_t absT = cmdTicks[0];
  sramAbsTicks[0] = absT;
  sramBarCount = 0;
  sramBarStartIndex[0] = 0;
  for (uint16_t i = 1; i < totalCmds; i++) {
    if (cmdTicks[i] < cmdTicks[i - 1]) {
      // 跨小节：补上"本小节剩余部分 + 新小节内位置"
      absT += (uint32_t)totalTicksPerBar - cmdTicks[i - 1] + cmdTicks[i];
      sramBarCount++;
      if (sramBarCount < MAX_CMDS) sramBarStartIndex[sramBarCount] = i;
    } else {
      absT += cmdTicks[i] - cmdTicks[i - 1];
    }
    sramAbsTicks[i] = absT;
  }
  sramBarCount++;  // 小节总数 = 回绕次数 + 1
  sramPlayFromAbsTick = 0;  // 从头播放：播放位置 = 第 1 小节起点

  currentCmdIndex = 0;
  sectionStartTime = playbackAnchorTime();
  isPlaying = true;
  isPause = false;
  pauseStartTime = 0;
  totalPauseTime = 0;
  recalcTiming();
}

// ================= 停止播放 =================
void stopPlayback() {
  Serial.println(F("停止播放（旧播放被终止）"));
  isPlaying = false;
  waitingLoop = false;
  waitingLoopSource = 0;
  eepromPlaying = false;
  eepromCmdReady = false;
  eepromAbsTick = 0;   // 绝对 tick 归零（下次 playEepromPartition 重新累计）
  isPause = false;
  pauseStartTime = 0;
  totalPauseTime = 0;
  eepromPauseStart = 0;
  eepromTotalPause = 0;
  hasFutureAction = false;
  for (int i = 0; i < numLeds; i++) analogWrite(ledPins[i], 0);
  currentMotorState = 0;
}

// ================= 执行一条指令 =================
void executeCommand(uint8_t motorCtrl) {
  uint8_t onOff = (motorCtrl >> 7) & 0x01;
  uint8_t mask = motorCtrl & 0x1F;
  for (int i = 0; i < numLeds; i++) {
    if (mask & (1 << i)) {
      if (onOff) {
        // 使用 analogWrite 输出 PWM 强度
        analogWrite(ledPins[i], motorIntensity[i]);
        currentMotorState |= (1 << i);
      } else {
        // 关闭马达时输出 0
        analogWrite(ledPins[i], 0);
        currentMotorState &= ~(1 << i);
      }
    }
  }
}

// ================= SRAM 播放调度 =================
void schedulePlayback() {
  // 【EEPROM离线播放】进行中时 SRAM 调度器让路
  if (eepromPlaying) return;

  // 【SRAM内存播放】循环间隔等待
  if (waitingLoop) {
    if (microsElapsed(waitStartTime) >= LOOP_DELAY_US) {
      if (waitingLoopSource == 1) {
        // 【SRAM内存播放】循环重启
        startPlayback();
      } else if (waitingLoopSource == 2) {
        // 【EEPROM离线播放】循环重启（修复：使用完整微秒偏移，不再 /1000）
        eepromPlaying = true;
        eepromReadAddr = eepromReadBase;
        eepromCmdReady = false;
        eepromCurTick = 0;
        eepromCurMotor = 0;
        eepromLastTick = 0;
        eepromAbsTick = 0;   // 绝对 tick 归零（从头重播）
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

  // 【SRAM内存播放】暂停：熄灭输出并记录暂停起点
  if (isPause) {
    for (int i = 0; i < numLeds; i++) analogWrite(ledPins[i], 0);
    // 【修复5】从设备使用主机统一时间基准，禁止本地独立计时
    if (pauseStartTime == 0) pauseStartTime = playbackAnchorTime();
    return;
  }

  // 【SRAM内存播放】恢复：补偿暂停时长到 sectionStartTime
  if (pauseStartTime != 0 && !isPause) {
    // 【修复5】暂停补偿同样基于 anchor 时间基准
    totalPauseTime = playbackAnchorTime() - pauseStartTime;
    sectionStartTime += totalPauseTime;
    pauseStartTime = 0;
    totalPauseTime = 0;
    for (int i = 0; i < numLeds; i++) {
      analogWrite(ledPins[i], (currentMotorState & (1 << i)) ? motorIntensity[i] : 0);
    }
  }

  // 【修复5】播放进度完全跟随主机统一时间基准，从机禁止用本地 micros()
  unsigned long now = playbackAnchorTime();
  uint64_t elapsedUs = (uint64_t)(now - sectionStartTime);
  uint32_t elapsedTicks = elapsedUs / tickDurationUs;

  uint8_t cmdsThisFrame = 0;
  while (currentCmdIndex < totalCmds && cmdsThisFrame < MAX_CMDS_PER_FRAME) {
    // 单调绝对 tick 比较：elapsedTicks 从"当前播放位置起点"单调增长，
    // 指令位置 = 全曲绝对 tick − 当前位置小节起点（sramPlayFromAbsTick）。
    // 跳转时 sectionStartTime 清零 + 更新 sramPlayFromAbsTick，不再回退时间（无负数钳位）。
    if (elapsedTicks >= (uint32_t)(sramAbsTicks[currentCmdIndex] - sramPlayFromAbsTick)) {
      executeCommand(cmdMotors[currentCmdIndex]);
      currentCmdIndex++;
      cmdsThisFrame++;
    } else {
      break;
    }
    // 【修复6】内层循环刷新 anchor 时间（与 EEPROM 调度 eepromSchedule 保持一致）。
    // 同一帧处理多条指令时，每条都用最新时间判断，避免陈旧 now 导致提前/滞后执行。
    now = playbackAnchorTime();
    elapsedUs = (uint64_t)(now - sectionStartTime);
    elapsedTicks = elapsedUs / tickDurationUs;
  }

  if (currentCmdIndex >= totalCmds) {
    for (int i = 0; i < numLeds; i++) analogWrite(ledPins[i], 0);
    currentMotorState = 0;
    if (loopPlayback) {
      // 【SRAM内存播放】循环：进入间隔等待
      waitingLoop = true;
      waitingLoopSource = 1;
      waitStartTime = micros();
      isPlaying = false;
    } else {
      // 【SRAM内存播放】非循环：明确终止（修复：此前马达可能保持最后状态）
      isPlaying = false;
    }
  }
}

// ================= EEPROM 播放调度 =================
void eepromSchedule() {
  // 【SRAM内存播放】或循环等待期间，EEPROM 调度器让路
  if (isPlaying || waitingLoop) {
    if (eepromPlaying) Serial.println(F("EEPROM: blocked by SRAM/waiting"));
    return;
  }
  if (!eepromPlaying) return;

  // 【EEPROM离线播放】暂停
  if (isPause) {
    for (int i = 0; i < numLeds; i++) analogWrite(ledPins[i], 0);
    // 【修复5】从设备使用主机统一时间基准
    if (eepromPauseStart == 0) eepromPauseStart = playbackAnchorTime();
    return;
  }

  // 【EEPROM离线播放】恢复：补偿暂停时长
  if (eepromPauseStart != 0) {
    // 【修复5】暂停补偿基于 anchor 时间基准
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
      Serial.println(F("EEPROM: no valid data, stopping"));
      return;
    }
    eepromCmdReady = true;
  }

  // 【修复5】EEPROM 播放进度同样跟随主机统一时间基准
  unsigned long now = playbackAnchorTime();
  uint64_t elapsedUs = (uint64_t)(now - eepromSectionStart);
  uint32_t elapsedTicks = elapsedUs / tickDurationUs;

  uint8_t cmdsThisFrame = 0;
  while (cmdsThisFrame < MAX_CMDS_PER_FRAME) {
    // 单调绝对 tick 比较：eepromAbsTick 在 eepromFetchNext 时递增维护，
    // 时间基准 eepromSectionStart 播放中不偏移，无回绕下溢缺陷。
    if (elapsedTicks >= eepromAbsTick) {
      Serial.print(F("EEPROM exec: tick="));
      Serial.print(eepromCurTick);
      Serial.print(F(" motor=0x"));
      Serial.println(eepromCurMotor, HEX);
      executeCommand(eepromCurMotor);

      if (!eepromFetchNext()) {
        if (loopPlayback) {
          // 【EEPROM离线播放】循环：进入间隔等待
          for (int i = 0; i < numLeds; i++) analogWrite(ledPins[i], 0);
          currentMotorState = 0;
          eepromPlaying = false;
          waitingLoop = true;
          waitingLoopSource = 2;
          waitStartTime = micros();
          Serial.println(F("EEPROM: loop restart"));
        } else {
          // 【EEPROM离线播放】非循环：终止
          eepromPlaying = false;
          for (int i = 0; i < numLeds; i++) analogWrite(ledPins[i], 0);
          currentMotorState = 0;
          Serial.println(F("EEPROM: playback finished"));
          return;
        }
        break;
      } else {
        // 【修复5】内层循环刷新 anchor 时间
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

// ================= 清空乐谱缓冲区 =================
void clearScore() {
  Serial.println(F("清空乐谱缓冲区"));
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

// ================= 系统复位 =================
void systemReset() {
  Serial.println(F("系统复位"));
  // 刷写 EEPROM 缓存，防止数据丢失
  if (eepromWriting) {
    flushEepromCache();
  }
  stopPlayback();
  // 清空 SRAM 乐谱缓冲区
  totalCmds = 0;
  // 清空 EEPROM 相关状态
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
  // 清空播放状态
  isPause = false;
  pauseStartTime = 0;
  totalPauseTime = 0;
  waitingLoop = false;
  waitingLoopSource = 0;
  waitStartTime = 0;
  currentMotorState = 0;
  // 清空时间同步状态
  timeSynced = false;
  timeOffset = 0;
  hasFutureAction = false;
  clearMasterTimingBuffers();
  clearSlaveTimingBuffers();
  masterTimingState = MT_IDLE;
  slaveTimingState = ST_IDLE;
  expectingDataPacket = false;
  // 清空新增状态变量
  scoreTarget = TARGET_LOCAL;   // 重置目标设备为左手（主机）
  slaveState = SLAVE_IDLE;      // 重置从机状态
  // 重置马达强度为默认值 128 (50%占空比)
  for (int i = 0; i < 5; i++) {
    motorIntensity[i] = 128;
  }
  Serial.println(F("System reset done"));
}

// ================= 清空校时临时缓存（主设备） =================
void clearMasterTimingBuffers() {
  T_send = 0;
  T_recv = 0;
  T_back = 0;
  recvIndex = 0;
}

// ================= 清空校时临时缓存（从设备） =================
void clearSlaveTimingBuffers() {
  slave_T_recv = 0;
  offsetBuffer[0] = 0;
  offsetBuffer[1] = 0;
  offsetBuffer[2] = 0;
  offsetBuffer[3] = 0;
  offsetIndex = 0;
}

// ================= EEPROM 读写 =================
void eepromWriteByte(uint16_t addr, uint8_t data) {
  Wire.beginTransmission(0x50);
  Wire.write((uint8_t)(addr >> 8));
  Wire.write((uint8_t)(addr & 0xFF));
  Wire.write(data);
  Wire.endTransmission();
  delay(5);
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

bool eepromFetchNext() {
  // 需要至少 2 字节（tick + motor）
  if (eepromReadAddr + 2 > eepromReadBase + EEPROM_SECTION_SIZE) {
    Serial.println(F("EEPROM: reached partition end"));
    return false;
  }
  uint8_t tick = eepromReadByte(eepromReadAddr);
  uint8_t motor = eepromReadByte(eepromReadAddr + 1);
  Serial.print(F("EEPROM read: addr=0x"));
  Serial.print(eepromReadAddr, HEX);
  Serial.print(F(" tick="));
  Serial.print(tick);
  Serial.print(F(" motor=0x"));
  Serial.println(motor, HEX);
  if (tick == 0xFF && motor == 0x00) {
    Serial.println(F("EEPROM: end marker found"));
    return false;
  }
  // 单调绝对 tick 维护：与上一条指令 tick 比较，回绕（变小）表示跨小节。
  // 初始 eepromLastTick=0，第一条指令直接取自身 tick（tick<0 恒假）。
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

// 页写入：强制不跨 64 字节页边界（AT24C256 硬件要求）
void eepromWritePage(uint16_t addr, uint8_t *data, uint8_t len) {
    while (len > 0) {
        uint16_t pageOffset = addr % EEPROM_PAGE_SIZE;
        uint8_t spaceInPage = EEPROM_PAGE_SIZE - pageOffset;
        uint8_t chunk = (len <= spaceInPage) ? len : spaceInPage;

        Wire.beginTransmission(0x50);
        Wire.write((uint8_t)(addr >> 8));
        Wire.write((uint8_t)(addr & 0xFF));
        Wire.write(data, chunk);
        uint8_t result = Wire.endTransmission();
        if (result != 0) {
            Serial.print(F("I2C write error! code="));
            Serial.println(result);
        } else {
            Serial.println(F("I2C write OK"));
        }
        delay(5);

        addr += chunk;
        data += chunk;
        len -= chunk;
    }
}

void storeScoreData(uint8_t beatPos, uint8_t motorCtrl) {
  if (totalCmds < MAX_CMDS) {
    cmdTicks[totalCmds] = beatPos;
    cmdMotors[totalCmds] = motorCtrl;
    totalCmds++;
    // [调试] 打印 SRAM 乐谱缓存写入计数
    Serial.print(F("[STORE] scoreCmdCount="));
    Serial.println(totalCmds);
  } else {
    // 【修复4】缓冲区满时打印警告，提示指令丢弃
    Serial.println(F("警告：指令缓冲区已满，丢弃指令"));
  }
}

// ================= EEPROM 分区直接播放（0xF9 0x05） =================
// partition 直接对应 eepromBases 索引（0~7）
void playEepromPartition(uint8_t partition) {
  stopPlayback();
  isPause = false;
  pauseStartTime = 0;
  totalPauseTime = 0;
  eepromPauseStart = 0;
  eepromTotalPause = 0;
  if (partition <= 7) {
    eepromPlaying = true;
    eepromReadBase = eepromBases[partition];  // 直接对应分区号，无需偏移
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

    // 构建小节跳转映射：扫描分区，tick 回绕（变小）处为新小节第一条指令。
    // 每条指令 2 字节（tick+motor），哨兵 prevScanTick=0xFF 保证第一条算新小节。
    eepromBarCount = 0;
    uint16_t scanAddr = eepromReadBase;
    uint8_t prevScanTick = 0xFF;
    bool scanFirst = true;
    while (scanAddr + 2 <= eepromReadBase + EEPROM_SECTION_SIZE && eepromBarCount < MAX_BARS) {
      uint8_t t = eepromReadByte(scanAddr);
      uint8_t m = eepromReadByte(scanAddr + 1);
      if (t == 0xFF && m == 0x00) break;  // 结束标记
      if (scanFirst || t < prevScanTick) {
        eepromBarStartIndex[eepromBarCount++] = scanAddr;
      }
      prevScanTick = t;
      scanFirst = false;
      scanAddr += 2;
    }

    Serial.print(F("EEPROM play partition: "));
    Serial.println(partition);
  }
}

// ================= 双手模式：切换模式 =================
void switchMode(uint8_t mode) {
  Serial.println(F("切换模式"));
  // 停止当前播放，确保模式切换时所有播放状态被彻底清理
  stopPlayback();
  // ---- 模式切换时重置从机状态和目标设备 ----
  setSlaveState(SLAVE_IDLE);
  scoreTarget = TARGET_LOCAL;  // 重置目标设备为左手（主机）

  if (mode == 0) {
    dualMode = false;
    Serial.println(F("Switched to SINGLE mode"));
  } else {
    dualMode = true;
    Serial.println(F("Switched to DUAL mode"));
    // 【主设备】进入双手模式后发起校时，保证主从时间基准对齐
    if (IS_MASTER) {
      timeSynced = false;
      startTimingSync();
    }
  }
}

// ================= 双手模式：主设备发起校时（发送0x30） =================
void startTimingSync() {
  if (!dualMode || !IS_MASTER) return;
  if (masterTimingState != MT_IDLE) return;

  T_send = micros();
  uint8_t cmd[4] = {0xF9, 0x30, 0x00, 0xF9 ^ 0x30 ^ 0x00};
  bt.write(cmd, 4);

  masterTimingState = MT_WAIT_31;
  timingReplyTimeout = micros();  // 【修复1】统一 micros 时钟
  Serial.print(F("Timing sync sent (0x30), T_send="));
  Serial.println(T_send);
}

// ================= 双手模式：应用时间偏移（从设备） =================
void applyOffset(int32_t offset) {
  timeOffset = offset;
  timeSynced = true;
  lastSyncTime = micros();  // 【修复1】统一 micros 时钟
  Serial.print(F("Offset applied: "));
  Serial.print(offset);
  Serial.print(F(" us, master_anchor="));
  Serial.println(playbackAnchorTime());
}

// ================= 双手模式：调度未来动作 =================
void scheduleFutureAction(unsigned long execTime, uint8_t action, uint8_t param) {
  hasFutureAction = true;
  futureExecTime = execTime;
  futureActionCmd = action;
  futureActionParam = param;
}

// ================= 双手模式：检查并执行未来动作 =================
void checkFutureAction() {
  if (!hasFutureAction) return;
  // 修复：micros() 约 70 分钟溢出，用有符号差比较
  if (microsReached(futureExecTime)) {
    hasFutureAction = false;
    switch (futureActionCmd) {
      case 0x01:
        waitingLoop = false;        // 终止循环等待
        waitingLoopSource = 0;
        isPause = true;
        Serial.println(F("Future: PAUSE"));
        break;
      case 0x02: isPause = false; Serial.println(F("Future: RESUME")); break;
      case 0x03: stopPlayback(); Serial.println(F("Future: STOP")); break;
      case 0x04:
        // 0x04 仅负责 SRAM 播放（主流程只发 param=0），EEPROM 由 0x05 负责
        startPlayback();
        Serial.println(F("Future: PLAY"));
        break;
      case 0x05:
        playEepromPartition(futureActionParam);
        Serial.println(F("Future: EEPROM PLAY"));
        break;
      default: break;
    }
  }
}

// ================= 调试：打印并更新从机状态 =================
// 仅增加日志输出，不改变任何业务逻辑
void setSlaveState(SlaveState newState) {
  if (slaveState != newState) {
    Serial.print(F("[slaveState] "));
    Serial.print(slaveState);
    Serial.print(F(" -> "));
    Serial.println(newState);
  }
  slaveState = newState;
}

// ================= 转发指令到从设备（透传，非阻塞） =================
// 单手-右手模式和双手模式均使用此函数转发
void forwardToSlave(uint8_t *cmd) {
  // 仅主设备可转发，从设备直接返回
  if (!IS_MASTER) return;

  // ---- 转发日志 ----
  Serial.print(F("转发指令: 0x"));
  Serial.print(cmd[0], HEX);
  Serial.print(F(" 0x"));
  Serial.print(cmd[1], HEX);
  Serial.print(F(" 0x"));
  Serial.print(cmd[2], HEX);
  Serial.print(F(" 0x"));
  Serial.println(cmd[3], HEX);

  // ---- 乐谱数据转发时更新从机状态（非阻塞，从机端自行停止播放） ----
  if (cmd[0] == 0xFB) {
    // 从机收到 0xFB 会立即停止播放（优先级最高），主机无需阻塞等待
    setSlaveState(SLAVE_RECEIVING);
  }

  bt.write(cmd, 4);
}

// ================= 双手模式：发送控制数据分包（用于播放/暂停/继续/停止） =================
void sendControlData(uint8_t actionType, uint32_t execTime, uint8_t param) {
  // 【主设备】发送0x40（开始）+ 0x41（低16位）+ 0x42（高16位）
  uint8_t cmd0[4] = {0xF9, 0x40, actionType | (param << 4), param};
  bt.write(cmd0, 4);

  uint8_t cmd1[4] = {0xF9, 0x41, (uint8_t)(execTime & 0xFF), (uint8_t)((execTime >> 8) & 0xFF)};
  bt.write(cmd1, 4);

  uint8_t cmd2[4] = {0xF9, 0x42, (uint8_t)((execTime >> 16) & 0xFF), (uint8_t)((execTime >> 24) & 0xFF)};
  bt.write(cmd2, 4);
}

// ================= 双手模式：主设备任务 =================
void handleMasterTasks() {
  if (!dualMode || !IS_MASTER) return;

  if (expectingDataPacket) {
    // 【修复1】统一 microsElapsed 计算超时
    if (microsElapsed(dataPacketStartTime) > DATA_PACKET_TIMEOUT) {
      expectingDataPacket = false;
      dataPacketIndex = 0;
      Serial.println(F("Data packet timeout, reset"));
    }
  }
  // 【主设备】校时超时处理
  if (masterTimingState == MT_WAIT_31) {
    if (microsElapsed(timingReplyTimeout) > 3000000UL) {
      Serial.println(F("Timing timeout, retry"));
      clearMasterTimingBuffers();
      masterTimingState = MT_IDLE;
      startTimingSync();
      return;
    }
  } else if (masterTimingState == MT_WAIT_T_RECV || masterTimingState == MT_WAIT_OFFSET_ACK) {
    if (microsElapsed(timingReplyTimeout) > 5000000UL) {
      Serial.println(F("Timing data timeout, reset"));
      clearMasterTimingBuffers();
      masterTimingState = MT_IDLE;
      timeSynced = false;
    }
  }

  // 【主设备】定期发起校时（仅双手模式，30秒间隔）
  // 单手模式下不执行校时，无论 scoreTarget 是本地还是从机
  if (dualMode && (!timeSynced || microsElapsed(lastSyncTime) > SYNC_INTERVAL)) {
    if (masterTimingState == MT_IDLE) {
      startTimingSync();
    }
  }

  // ---- 从机状态超时监控（非阻塞） ----
  // 接收中超过 2 秒未完成，判定超时，重置状态
  static unsigned long slaveReceiveStartTime = 0;
  if (slaveState == SLAVE_RECEIVING) {
    if (slaveReceiveStartTime == 0) {
      slaveReceiveStartTime = micros();
    } else if (microsElapsed(slaveReceiveStartTime) > 2000000UL) {
      Serial.println(F("从机乐谱接收超时，重置状态"));
      setSlaveState(SLAVE_IDLE);
      slaveReceiveStartTime = 0;
    }
  } else {
    slaveReceiveStartTime = 0;
  }
}

// ================= 双手模式：从设备任务 =================
void handleSlaveTasks() {
  if (!dualMode || IS_MASTER) return;

  // 【从设备】校时超时处理
  if (slaveTimingState == ST_WAIT_OFFSET) {
    // 【修复1】统一 microsElapsed 计算超时
    if (microsElapsed(slaveTimingTimeout) > SLAVE_TIMING_TIMEOUT) {
      Serial.println(F("Slave timing timeout, reset"));
      uint8_t fail[4] = {0xF9, 0x37, 0x00, 0x00};
      bt.write(fail, 4);
      clearSlaveTimingBuffers();
      slaveTimingState = ST_IDLE;
      slaveTimingTimeout = 0;
    }
  }

  // 【从设备】控制分包接收超时
  if (expectingDataPacket) {
    // 【修复1】统一 microsElapsed 计算超时
    if (microsElapsed(dataPacketStartTime) > DATA_PACKET_TIMEOUT) {
      expectingDataPacket = false;
      dataPacketIndex = 0;
      Serial.println(F("Slave: data packet timeout, reset"));
    }
  }
}

// ================= XOR 校验函数 =================
bool verifyXor(uint8_t sync, uint8_t b1, uint8_t b2, uint8_t b3) {
    uint8_t calc = sync ^ b1 ^ b2;
    return (calc == b3);
}

// ================= 解析蓝牙指令=================
void parseCommand(uint8_t *cmd) {
  uint8_t sync = cmd[0];
  uint8_t b1 = cmd[1];
  uint8_t b2 = cmd[2];
  uint8_t b3 = cmd[3];

  if (sync == 0xF9) {
    // ---- 校时指令 ----
    if (b1 == 0x30) {
      // 【从设备】收到0x30：记录T_recv，回复0x31
      if (!IS_MASTER && dualMode) {
        slave_T_recv = micros();
        uint8_t reply[4] = {0xF9, 0x31, 0x00, 0x00};
        bt.write(reply, 4);
        uint32_t replySent = micros();
        slaveTimingState = ST_WAIT_OFFSET;
        slaveTimingTimeout = micros();  // 【修复1】统一 micros 时钟
        uint32_t recvVal = slave_T_recv;
        uint8_t pkt1[4] = {0xF9, 0x32, (uint8_t)(recvVal & 0xFF), (uint8_t)((recvVal >> 8) & 0xFF)};
        uint8_t pkt2[4] = {0xF9, 0x33, (uint8_t)((recvVal >> 16) & 0xFF), (uint8_t)((recvVal >> 24) & 0xFF)};
        bt.write(pkt1, 4);
        bt.write(pkt2, 4);
        Serial.print(F("Slave: T_recv="));
        Serial.print(slave_T_recv);
        Serial.print(F(" reply_latency="));
        Serial.println(replySent - slave_T_recv);
      }
      return;
    }

    if (b1 == 0x31) {
      // 【主设备】收到0x31：记录T_back
      if (IS_MASTER && dualMode && masterTimingState == MT_WAIT_31) {
        T_back = micros();
        masterTimingState = MT_WAIT_T_RECV;
        recvIndex = 0;
        timingReplyTimeout = micros();  // 【修复1】统一 micros 时钟
        Serial.println(F("Master: received 0x31, waiting for T_recv"));
      }
      return;
    }

    if (b1 == 0x32) {
      if (IS_MASTER && dualMode && masterTimingState == MT_WAIT_T_RECV) {
        if (recvIndex == 0) {
          uint16_t low = b2 | ((uint16_t)b3 << 8);
          T_recv = low;
          recvIndex = 1;
        }
      }
    }

    if (b1 == 0x33) {
      if (IS_MASTER && dualMode && masterTimingState == MT_WAIT_T_RECV) {
        if (recvIndex == 1) {
          uint16_t high = b2 | ((uint16_t)b3 << 8);
          T_recv |= ((uint32_t)high << 16);
          uint32_t RTT = T_back - T_send;  // unsigned 减法，micros 溢出安全
          uint32_t oneWay = RTT / 2;
          // offset = slave_clock - master_estimated；与 localExec=master+offset、anchor=slave-offset 一致
          int32_t offset = (int32_t)(T_recv - (T_send + oneWay));
          offset += TIMING_STATIC_COMP_US;
          Serial.print(F("Sync RTT="));
          Serial.print(RTT);
          Serial.print(F(" oneWay="));
          Serial.print(oneWay);
          Serial.print(F(" T_send="));
          Serial.print(T_send);
          Serial.print(F(" T_recv="));
          Serial.print(T_recv);
          Serial.print(F(" offset="));
          Serial.println(offset);
          timeSynced = true;
          lastSyncTime = micros();  // 【修复1】统一 micros 时钟
          masterTimingState = MT_WAIT_OFFSET_ACK;
          timingReplyTimeout = micros();  // 【修复1】统一 micros 时钟
          uint32_t offVal = (uint32_t)offset;
          uint8_t pkt1[4] = {0xF9, 0x34, (uint8_t)(offVal & 0xFF), (uint8_t)((offVal >> 8) & 0xFF)};
          uint8_t pkt2[4] = {0xF9, 0x35, (uint8_t)((offVal >> 16) & 0xFF), (uint8_t)((offVal >> 24) & 0xFF)};
          bt.write(pkt1, 4);
          bt.write(pkt2, 4);
          recvIndex = 0;
        }
      }
    }

    if (b1 == 0x34) {
      if (!IS_MASTER && dualMode && slaveTimingState == ST_WAIT_OFFSET) {
        if (offsetIndex == 0) {
          offsetBuffer[0] = b2;
          offsetBuffer[1] = b3;
          offsetIndex = 1;
        }
      }
    }

    if (b1 == 0x35) {
      if (!IS_MASTER && dualMode && slaveTimingState == ST_WAIT_OFFSET) {
        if (offsetIndex == 1) {
          offsetBuffer[2] = b2;
          offsetBuffer[3] = b3;
          int32_t offset = (int32_t)((uint32_t)offsetBuffer[0] | ((uint32_t)offsetBuffer[1] << 8) |
                                     ((uint32_t)offsetBuffer[2] << 16) | ((uint32_t)offsetBuffer[3] << 24));
          applyOffset(offset);
          slaveTimingState = ST_IDLE;
          slaveTimingTimeout = 0;
          offsetIndex = 0;
          clearSlaveTimingBuffers();
          uint8_t ack[4] = {0xF9, 0x36, 0x00, 0x00};
          bt.write(ack, 4);
        }
      }
    }

    if (b1 == 0x36) {
      // 【主设备】收到确认，校时完成
      if (IS_MASTER && dualMode && masterTimingState == MT_WAIT_OFFSET_ACK) {
        clearMasterTimingBuffers();
        masterTimingState = MT_IDLE;
        Serial.println(F("Timing handshake complete"));
      }
      return;
    }

    if (b1 == 0x37) {
      // 【从设备】报告校时失败
      if (IS_MASTER && dualMode) {
        Serial.println(F("Master: slave timing failure reported"));
        clearMasterTimingBuffers();
        masterTimingState = MT_IDLE;
        timeSynced = false;
      }
      return;
    }

    // ---- 控制指令分包接收（从设备） ----
    if (b1 == 0x40) {
      if (!IS_MASTER && dualMode) {
        expectingDataPacket = true;
        dataPacketType = b2 & 0x0F;
        dataPacketParam = (b2 >> 4) & 0x0F;
        dataPacketValue = 0;
        dataPacketIndex = 0;
        dataPacketStartTime = micros();  // 【修复1】统一 micros 时钟
      }
      return;
    }

    if (b1 == 0x41) {
      if (!IS_MASTER && dualMode && expectingDataPacket) {
        if (dataPacketIndex == 0) {
          dataPacketValue = b2 | ((uint32_t)b3 << 8);
          dataPacketIndex = 1;
        }
      }
    }

    if (b1 == 0x42) {
      if (!IS_MASTER && dualMode && expectingDataPacket) {
        if (dataPacketIndex == 1) {
          uint32_t high = b2 | ((uint32_t)b3 << 8);
          dataPacketValue |= (high << 16);
          expectingDataPacket = false;
          uint8_t action = dataPacketType;
          uint8_t internalAction = 0;
          uint8_t param = 0;
          switch (action) {
            case 0: internalAction = 0x04; param = dataPacketParam; break;  // SRAM 播放
            case 1: internalAction = 0x01; param = 0; break;               // 暂停
            case 2: internalAction = 0x02; param = 0; break;               // 继续
            case 3: internalAction = 0x03; param = 0; break;               // 停止
            case 4: internalAction = 0x05; param = dataPacketParam; break;  // EEPROM 分区播放
            default: return;
          }
          // 【从设备】主设备绝对时刻 + 校时偏移 = 本地执行时刻
          int64_t localExecTime = (int64_t)dataPacketValue + (int64_t)timeOffset;
          if (localExecTime < 0) {
            localExecTime = 0;
          }
          scheduleFutureAction((unsigned long)localExecTime, internalAction, param);
          Serial.print(F("Slave: scheduled control action "));
          Serial.println(internalAction);
        }
      }
      return;
    }

    // ---- 控制指令 ----
    switch (b1) {
      case 0x00: // 停止
        if (IS_MASTER) {
          if (dualMode) {
            // 双手模式：本地延迟执行 + 同步转发给从机（附时间戳）
            unsigned long execTime = micros() + 200000ULL;
            scheduleFutureAction(execTime, 0x03, 0);
            sendControlData(3, execTime, 0);
            setSlaveState(SLAVE_IDLE);
          } else if (scoreTarget == TARGET_LOCAL) {
            // 单手-左手：本地执行
            stopPlayback();
          } else {
            // 单手-右手：转发给从机
            forwardToSlave(cmd);
            setSlaveState(SLAVE_IDLE);
          }
        } else {
          stopPlayback();
        }
        break;
      case 0x01: // 暂停
        Serial.println(F("暂停"));
        if (IS_MASTER) {
          if (dualMode) {
            // 双手模式：本地延迟执行 + 同步转发
            unsigned long execTime = micros() + 200000ULL;
            scheduleFutureAction(execTime, 0x01, 0);
            sendControlData(1, execTime, 0);
            setSlaveState(SLAVE_PAUSED);
          } else if (scoreTarget == TARGET_LOCAL) {
            // 单手-左手：本地执行
            waitingLoop = false;      // 终止循环等待
            waitingLoopSource = 0;
            isPause = true;
          } else {
            // 单手-右手：转发给从机
            forwardToSlave(cmd);
            setSlaveState(SLAVE_PAUSED);
          }
        } else {
          // 从机：本地执行
          waitingLoop = false;        // 终止循环等待
          waitingLoopSource = 0;
          isPause = true;
        }
        break;
      case 0x02: // 继续
        Serial.println(F("继续"));
        if (IS_MASTER) {
          if (dualMode) {
            // 双手模式：本地延迟执行 + 同步转发
            unsigned long execTime = micros() + 200000ULL;
            scheduleFutureAction(execTime, 0x02, 0);
            sendControlData(2, execTime, 0);
            setSlaveState(SLAVE_PLAYING);
          } else if (scoreTarget == TARGET_LOCAL) {
            // 单手-左手：本地执行
            isPause = false;
          } else {
            // 单手-右手：转发给从机
            forwardToSlave(cmd);
            setSlaveState(SLAVE_PLAYING);
          }
        } else {
          isPause = false;
        }
        break;
      case 0x03: // 系统复位
        if (IS_MASTER) {
          if (dualMode) {
            // 双手模式：本地立即执行 + 同步转发
            systemReset();
            forwardToSlave(cmd);
            setSlaveState(SLAVE_IDLE);
          } else if (scoreTarget == TARGET_LOCAL) {
            // 单手-左手：本地执行
            systemReset();
          } else {
            // 单手-右手：转发给从机
            forwardToSlave(cmd);
            setSlaveState(SLAVE_IDLE);
          }
        } else {
          // 从机：本地执行
          systemReset();
        }
        break;
      case 0x04: // SRAM 播放（仅支持 b2=0）
        if (b2 != 0) {
          Serial.println(F("0x04 仅支持 SRAM (b2=0)，EEPROM 请使用 0x05"));
          break;
        }
        Serial.println(F("SRAM播放"));
        if (IS_MASTER) {
          if (dualMode) {
            // 双手模式：本地延迟执行 + 同步转发（播放预留 500ms 缓冲）
            unsigned long execTime = micros() + 500000ULL;
            scheduleFutureAction(execTime, 0x04, 0);
            sendControlData(0, execTime, 0);
            setSlaveState(SLAVE_PLAYING);
          } else if (scoreTarget == TARGET_LOCAL) {
            // 单手-左手：本地执行
            startPlayback();
          } else {
            // 单手-右手：转发给从机
            forwardToSlave(cmd);
            setSlaveState(SLAVE_PLAYING);
          }
        } else {
          startPlayback();
        }
        break;
      case 0x05: // EEPROM 分区播放（b2 直接对应分区号 0~7）
        if (b2 > 7) {
          Serial.println(F("0x05 分区号超出范围 (0~7)"));
          break;
        }
        Serial.print(F("EEPROM播放分区: ")); Serial.println(b2);
        if (IS_MASTER) {
          if (dualMode) {
            // 双手模式：本地延迟执行 + 同步转发（播放预留 500ms 缓冲）
            unsigned long execTime = micros() + 500000ULL;
            scheduleFutureAction(execTime, 0x05, b2);
            sendControlData(4, execTime, b2);
            setSlaveState(SLAVE_PLAYING);
          } else if (scoreTarget == TARGET_LOCAL) {
            // 单手-左手：本地执行
            playEepromPartition(b2);
          } else {
            // 单手-右手：转发给从机
            forwardToSlave(cmd);
            setSlaveState(SLAVE_PLAYING);
          }
        } else {
          playEepromPartition(b2);
        }
        break;
      case 0x10:
        clearScore();
        // 与 0x12 一致：双手模式或目标为从机时转发，保证从机 SRAM 同步清空
        if (IS_MASTER && (dualMode || scoreTarget == TARGET_SLAVE)) {
          forwardToSlave(cmd);
        }
        break;
      case 0x11:
        if (b2 <= 7) {
          if (eepromWriting) flushEepromCache();
          eepromWriting = true;
          eepromWriteBase = eepromBases[b2];
          eepromWriteAddr = eepromWriteBase;
          eepromCacheLen = 0;
          Serial.print(F("EEPROM write mode: partition "));
          Serial.println(b2);
        }
        // 双手模式或目标为从机时转发
        if (IS_MASTER && (dualMode || scoreTarget == TARGET_SLAVE)) {
          forwardToSlave(cmd);
        }
        break;
      case 0x12:
        if (b2 <= 7) {
          if (eepromWriting) {
            flushEepromCache();
            eepromWriting = false;
          }
          uint16_t base = eepromBases[b2];
          uint8_t endMark[2] = {0xFF, 0x00};
          eepromWritePage(base, endMark, 2);
          Serial.print(F("EEPROM partition "));
          Serial.print(b2);
          Serial.println(F(" cleared (end marker written)"));
        } else {
          Serial.println(F("Invalid partition number"));
        }
        // 双手模式或目标为从机时转发
        if (IS_MASTER && (dualMode || scoreTarget == TARGET_SLAVE)) {
          forwardToSlave(cmd);
        }
        break;
      // ---- 统一目标设备切换指令（全场景通用） ----
      // 0xF9 0x24 0x00 0x00 → 目标=左手(主机)
      // 0xF9 0x24 0x01 0x00 → 目标=右手(从机)
      case 0x24:
        if (b2 == 0x00) {
          scoreTarget = TARGET_LOCAL;
          Serial.println(F("目标设备: 左手(主机)"));
        } else if (b2 == 0x01) {
          scoreTarget = TARGET_SLAVE;
          Serial.println(F("目标设备: 右手(从机)"));
        }
        break;
      case 0x20:
        switchMode(b2);
        // 模式是左右手全局状态：单/双手模式都必须转发给从机，保证主从模式一致。
        // 特别是"单手→双手"切换时若按 dualMode 条件转发，切换前 dualMode 仍为 false
        // 会漏转发，导致从机收不到校时、主从模式不一致。
        if (IS_MASTER) {
          forwardToSlave(cmd);
        }
        break;
      case 0x21:
        beatsPerBar = (b2 >> 4) & 0x0F;
        if (beatsPerBar == 0) beatsPerBar = 4;
        recalcTiming();
        // 双手模式或目标为从机时转发
        if (IS_MASTER && (dualMode || scoreTarget == TARGET_SLAVE)) {
          forwardToSlave(cmd);
        }
        break;
      case 0x22:
        if (b2 == 0) ticksPerBeat = 32;
        else if (b2 == 1) ticksPerBeat = 16;
        else if (b2 == 2) ticksPerBeat = 8;
        recalcTiming();
        // 双手模式或目标为从机时转发
        if (IS_MASTER && (dualMode || scoreTarget == TARGET_SLAVE)) {
          forwardToSlave(cmd);
        }
        break;
      case 0x25: // 马达强度设置
        {
          uint8_t pinIndex = b2;
          if (pinIndex < 5) {
            motorIntensity[pinIndex] = b3;
            Serial.print(F("马达强度: pin"));
            Serial.print(pinIndex);
            Serial.print(F("="));
            Serial.println(b3);
          } else {
            Serial.println(F("0x25 引脚索引超出范围 (0~4)"));
          }
          // 强度指令只在显式目标为从机（右手）时转发：双手模式下不自动转发，
          // 保证左右手强度可以各自独立设置（选左手→本地执行，选右手→转发给右手）。
          if (IS_MASTER && scoreTarget == TARGET_SLAVE) {
            forwardToSlave(cmd);
          }
        }
        break;
      case 0x26: // 小节跳转（b2 = 1 基小节号）
        {
          // 跳到指定小节第一条指令，从该小节 tick=0 开始播放。
          // 双手模式或目标为从机时转发（从机本地执行同样的跳转）。
          if (IS_MASTER && (dualMode || scoreTarget == TARGET_SLAVE)) {
            forwardToSlave(cmd);
          }
          uint8_t targetBar = b2;  // 1 基
          if (targetBar < 1) {
            Serial.println(F("0x26 小节号从 1 开始"));
            break;
          }
          // ---- SRAM 播放中：跳转 SRAM 乐谱 ----
          if (isPlaying && !eepromPlaying) {
            if (targetBar > sramBarCount) {
              Serial.println(F("0x26 SRAM 小节号超出范围"));
              break;
            }
            currentCmdIndex = sramBarStartIndex[targetBar - 1];
            // 起始小节偏移方案：不回退时间（避免上电时长不足时负数钳位），
            // 而是记录"播放位置的小节起点"并把时间清零重新数。
            sramPlayFromAbsTick = (uint32_t)(targetBar - 1) * totalTicksPerBar;
            unsigned long nowUs = playbackAnchorTime();
            sectionStartTime = nowUs;
            // 保持暂停状态：若在暂停中，仅把暂停起点更新为当前时刻，
            // 使恢复补偿（sectionStartTime += totalPause）只补"跳转后到恢复"的时长。
            if (isPause) {
              pauseStartTime = nowUs;
            }
            // 跳转 = 重新开始播放：熄灭当前所有灯，避免跳转前亮的灯残留
            for (int i = 0; i < numLeds; i++) analogWrite(ledPins[i], 0);
            currentMotorState = 0;
            Serial.print(F("0x26 SRAM 跳转到小节 "));
            Serial.println(targetBar);
            break;
          }
          // ---- EEPROM 播放中：跳转 EEPROM 乐谱 ----
          if (eepromPlaying) {
            if (targetBar > eepromBarCount) {
              Serial.println(F("0x26 EEPROM 小节号超出范围"));
              break;
            }
            eepromReadAddr = eepromBarStartIndex[targetBar - 1];
            eepromCmdReady = false;  // 让调度器重新取指令
            eepromLastTick = 0;      // 防误判回绕
            // 起始小节偏移方案：eepromAbsTick 从 0 相对累加（fetch 时维护），
            // 时间基准清零（elapsedTicks 也从 0 数），不回退时间，无负数钳位。
            eepromAbsTick = 0;
            unsigned long nowUs = playbackAnchorTime();
            eepromSectionStart = nowUs;
            // 保持暂停状态：若在暂停中，仅把暂停起点更新为当前时刻，
            // 使恢复补偿（eepromSectionStart += eepromTotalPause）只补"跳转后到恢复"的时长。
            if (isPause) {
              eepromPauseStart = nowUs;
            }
            // 跳转 = 重新开始播放：熄灭当前所有灯，避免跳转前亮的灯残留
            for (int i = 0; i < numLeds; i++) analogWrite(ledPins[i], 0);
            currentMotorState = 0;
            Serial.print(F("0x26 EEPROM 跳转到小节 "));
            Serial.println(targetBar);
            break;
          }
          Serial.println(F("0x26 无播放中，忽略跳转"));
        }
        break;
      default: break;
    }
  } else if (sync == 0xFA) {
    // BPM
    uint16_t newBpm = (b1 << 8) | b2;
    if (newBpm >= 1 && newBpm <= 300) {
      bpm = newBpm;
      recalcTiming();
      // 双手模式或单手-右手模式，转发 BPM 给从机
      if (IS_MASTER && (dualMode || scoreTarget == TARGET_SLAVE)) forwardToSlave(cmd);
    }
  } else if (sync == 0xFB) {
    // ---- XOR 校验：仅乐谱数据有校验，校验失败则丢弃 ----
    if (enableXorCheck){
      if (!verifyXor(sync, b1, b2, b3)) {
        Serial.println(F("乐谱数据校验失败，丢弃"));
        return;
      }
    }
    Serial.println(F("乐谱数据"));

    if (IS_MASTER) {
      // ---- 主机：根据 scoreTarget 决定乐谱保存目标 ----
      if (scoreTarget == TARGET_LOCAL) {
        // 目标设备为本地（左手）：主机本地保存
        if (eepromWriting) {
          // 【EEPROM离线播放】写入缓存
          if (eepromCacheLen + 2 > EEPROM_CACHE_SIZE) {
            flushEepromCache();
          }
          eepromCache[eepromCacheLen++] = b1;
          eepromCache[eepromCacheLen++] = b2;
          if (b1 == 0xFF && b2 == 0x00) {
            flushEepromCache();
            eepromWriting = false;
            Serial.print(F("EEPROM writing finished. Bytes written: "));
            Serial.println(eepromWriteAddr - eepromWriteBase);
          }
        } else {
          // 【SRAM内存播放】存入缓冲区
          storeScoreData(b1, b2);
        }
      } else {
        // 目标设备为从机（右手）：主机转发给从机，透传保留原始 b3 校验字节
        // [调试] 打印主机转发的乐谱数据包完整内容
        Serial.print(F("[M->S] 0xFB转发: b1=0x"));
        Serial.print(b1, HEX);
        Serial.print(F(" b2=0x"));
        Serial.print(b2, HEX);
        Serial.print(F(" b3=0x"));
        Serial.println(b3, HEX);
        forwardToSlave(cmd);
        // 主机推断从机状态：收到结束标志则为就绪，否则为接收中
        if (b1 == 0xFF && b2 == 0x00) {
          setSlaveState(SLAVE_READY);
        }
      }
    } else {
      // ---- 从机：直接保存乐谱数据 ----
      // [调试] 打印从机接收的乐谱数据包完整内容
      Serial.print(F("[S<-M] 0xFB接收: b1=0x"));
      Serial.print(b1, HEX);
      Serial.print(F(" b2=0x"));
      Serial.print(b2, HEX);
      Serial.print(F(" b3=0x"));
      Serial.println(b3, HEX);
      // 从机指令执行优先级：收到乐谱数据必须立即停止当前播放
      if (isPlaying || eepromPlaying || waitingLoop) {
        stopPlayback();
        Serial.println(F("从机: 收到乐谱，停止当前播放"));
      }
      if (isPause) {
        isPause = false;
      }

      if (eepromWriting) {
        // 【EEPROM离线播放】写入缓存
        if (eepromCacheLen + 2 > EEPROM_CACHE_SIZE) {
          flushEepromCache();
        }
        eepromCache[eepromCacheLen++] = b1;
        eepromCache[eepromCacheLen++] = b2;
        if (b1 == 0xFF && b2 == 0x00) {
          flushEepromCache();
          eepromWriting = false;
          Serial.print(F("EEPROM writing finished. Bytes written: "));
          Serial.println(eepromWriteAddr - eepromWriteBase);
        }
      } else {
        // 【SRAM内存播放】存入缓冲区
        storeScoreData(b1, b2);
      }
    }
  }
}

// ================= 初始化 =================
void setup() {
  for (int i = 0; i < numLeds; i++) {
    pinMode(ledPins[i], OUTPUT);
    analogWrite(ledPins[i], 0);
  }
  Serial.begin(9600);  // 修复：必须先初始化 Serial 再打印
  bt.begin(9600);
  Wire.begin();
  Wire.beginTransmission(0x50);
  if (Wire.endTransmission() == 0) {
    Serial.println(F("EEPROM found at 0x50"));
  } else {
    Serial.println(F("EEPROM NOT found at 0x50!"));
  }
  initBluetooth();
  recalcTiming();
  clearScore();
  Serial.print(F("Glove ready: "));
  Serial.println(IS_LEFT ? F("LEFT") : F("RIGHT"));
  Serial.print(F("Mode: "));
  Serial.println(dualMode ? F("DUAL") : F("SINGLE"));
  Serial.print(F("Role: "));
  Serial.println(IS_MASTER ? F("MASTER") : F("SLAVE"));
}

// ================= 主循环 =================
void loop() {
  static uint8_t rxBuf[4];
  static uint8_t step = 0;
  static unsigned long lastRxTime = 0;

  while (bt.available()) {
    uint8_t b = bt.read();
    lastRxTime = micros();  // 【修复1】统一 micros 时钟

    if (step == 0) {
      if (b == 0xF9 || b == 0xFA || b == 0xFB) {
        rxBuf[0] = b;
        step = 1;
      }
    } else {
      rxBuf[step] = b;
      step++;
      if (step == 4) {
        parseCommand(rxBuf);
        step = 0;
      }
    }
  }

  // 【修复1】蓝牙帧接收超时 50ms → 50000UL 微秒
  if (step != 0 && microsElapsed(lastRxTime) > 50000UL) {
    step = 0;
  }

  if (dualMode) {
    if (IS_MASTER) handleMasterTasks();
    else handleSlaveTasks();
  }

  checkFutureAction();
  eepromSchedule();
  schedulePlayback();
}
