/**
 * 振动手套的硬件指令定义（4 字节十六进制）。
 *
 * 所有指令通过已连接的 Write 特性（0000fff2-...）以 writeValue 发送。
 * 指令格式固定为 F9 [cmd] [arg] 00。本文件只负责字节组装，不负责发送
 * （发送由 GloveController.sendCommand 完成）。
 */

/** 播放控制指令。 */
export const PLAYBACK_COMMANDS = {
  /** 停止播放。 */
  stop: [0xf9, 0x00, 0x00, 0x00],
  /** 暂停播放。 */
  pause: [0xf9, 0x01, 0x00, 0x00],
  /** 继续播放。 */
  resume: [0xf9, 0x02, 0x00, 0x00],
  /** 系统复位。 */
  reset: [0xf9, 0x03, 0x00, 0x00],
  /** 播放 SRAM 中的乐谱。 */
  sramPlay: [0xf9, 0x04, 0x00, 0x00],
};

/** 模式设置指令。 */
export const MODE_COMMANDS = {
  /** 切换为单手模式。 */
  singleHand: [0xf9, 0x20, 0x00, 0x00],
  /** 切换为双手模式。 */
  dualHand: [0xf9, 0x20, 0x01, 0x00],
};

/** 目标设备指令（单手模式专用）。 */
export const TARGET_COMMANDS = {
  /** 乐谱目标设为左手（主机）。 */
  left: [0xf9, 0x24, 0x00, 0x00],
  /** 乐谱目标设为右手（从机）。 */
  right: [0xf9, 0x24, 0x01, 0x00],
};

/** EEPROM 可选分区范围（0~7）。 */
export const EEPROM_PARTITION_MIN = 0;
export const EEPROM_PARTITION_MAX = 7;

/**
 * 组装 EEPROM 播放指令：F9 05 [分区] 00。
 * partition 会被限制到 0~7 范围内，防止越界字节。
 */
export function eepromPlayCommand(partition: number): number[] {
  const clamped = Math.max(
    EEPROM_PARTITION_MIN,
    Math.min(EEPROM_PARTITION_MAX, Math.trunc(partition))
  );
  return [0xf9, 0x05, clamped, 0x00];
}

/**
 * 将字节数组转为 "F9 04 00 00" 形式的字符串（日志显示用）。
 * 每个字节大写、两位十六进制、空格分隔。
 */
export function toHexString(bytes: number[]): string {
  return bytes
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');
}

/* ===================== 乐谱写入相关 ===================== */

/** 乐谱写入: 同步头字节。 */
export const SCORE_SYNC = 0xfb;
/** 乐谱写入: SRAM 最大指令条数（超过会被硬件丢弃）。 */
export const MAX_SRAM_COMMANDS = 32;

/** 清空 SRAM 乐谱: F9 10 00 00。 */
export const SRAM_CLEAR_COMMAND = [0xf9, 0x10, 0x00, 0x00];

/**
 * 清除 EEPROM 指定分区: F9 12 [分区] 00。
 * partition 会被限制到 0~7。
 */
export function eepromClearCommand(partition: number): number[] {
  const clamped = clampPartition(partition);
  return [0xf9, 0x12, clamped, 0x00];
}

/**
 * 进入 EEPROM 指定分区写入模式: F9 11 [分区] 00。
 * partition 会被限制到 0~7。
 */
export function eepromWriteInitCommand(partition: number): number[] {
  const clamped = clampPartition(partition);
  return [0xf9, 0x11, clamped, 0x00];
}

/**
 * 构建乐谱数据指令: FB [tick] [motor] [XOR]。
 * XOR = 0xFB ^ tick ^ motorCtrl。
 */
export function buildScoreCommand(tick: number, motorCtrl: number): number[] {
  return [SCORE_SYNC, tick, motorCtrl, SCORE_SYNC ^ tick ^ motorCtrl];
}

/** 乐谱写入结束标志: FB FF 00 04（校验固定 0x04, 不是 0xFB）。 */
export const SCORE_END_MARKER = [SCORE_SYNC, 0xff, 0x00, 0x04];

/** 乐谱输入解析结果。ok=false 时 reason 表示错误类型。 */
export type ScoreParseResult =
  | { ok: true; pairs: [number, number][] }
  | { ok: false; reason: 'empty' | 'odd' | 'invalid'; invalidToken?: string };

/**
 * 解析用户输入的纯数据（十六进制，空格/换行分隔），两两配对为 [tick, motorCtrl]。
 * 每个字节允许 1~2 位十六进制。奇数个字节或非法 hex 都返回错误。
 */
export function parseScoreInput(input: string): ScoreParseResult {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (tokens.length % 2 !== 0) {
    return { ok: false, reason: 'odd' };
  }
  const pairs: [number, number][] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (!/^[0-9a-fA-F]{1,2}$/.test(a)) {
      return { ok: false, reason: 'invalid', invalidToken: a };
    }
    if (!/^[0-9a-fA-F]{1,2}$/.test(b)) {
      return { ok: false, reason: 'invalid', invalidToken: b };
    }
    pairs.push([parseInt(a, 16), parseInt(b, 16)]);
  }
  return { ok: true, pairs };
}

/** 将分区号限制到 0~7。 */
function clampPartition(partition: number): number {
  return Math.max(EEPROM_PARTITION_MIN, Math.min(EEPROM_PARTITION_MAX, Math.trunc(partition)));
}

/* ===================== BPM / 拍号设置 ===================== */

/** BPM 设置范围。 */
export const BPM_MIN = 1;
export const BPM_MAX = 300;

/**
 * 构建 BPM 设置指令: FA [高8位] [低8位] 00。
 * 例: BPM=120 → 0x0078 → FA 00 78 00; BPM=300 → 0x012C → FA 01 2C 00。
 */
export function buildBpmCommand(bpm: number): number[] {
  return [0xfa, (bpm >> 8) & 0xff, bpm & 0xff, 0x00];
}

/** 拍号预设选项（label 用于 UI 显示，beats 为每小节拍数，分母不参与编码）。 */
export const TIME_SIGNATURE_OPTIONS = [
  { label: '2/4', beats: 2 },
  { label: '3/4', beats: 3 },
  { label: '4/4', beats: 4 },
  { label: '6/8', beats: 6 },
] as const;

/**
 * 构建拍号设置指令: F9 21 [beats<<4] 00。
 * 固件 case 0x21 只取高4位作为每小节拍数（beatsPerBar），低4位被忽略，固定填 0。
 * 例: 4/4 → 4 拍 → F9 21 40 00; 6/8 → 6 拍 → F9 21 60 00。
 */
export function buildTimeSignatureCommand(beats: number): number[] {
  return [0xf9, 0x21, (beats << 4) & 0xff, 0x00];
}
