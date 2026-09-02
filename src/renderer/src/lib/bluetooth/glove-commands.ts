/**
 * 振动手套的纯工具与常量（协议无关部分）。
 *
 * 注意：自协议重构后，**指令字节的组装全部移到 `protocol/commands.ts`**（HDLC 帧 + 命令码），
 * 本文件不再包含任何旧版 4 字节指令（F9/FA/FB）的构建逻辑，只保留：
 * - 十六进制格式化 / 乐谱输入解析等纯函数；
 * - 参数范围常量（BPM / 拍号 / 强度 / 小节 / SRAM 容量 / EEPROM 分区）。
 */

/* ===================== 十六进制工具 ===================== */

/**
 * 将字节数组转为 "7E 03 01 10 00 8A 2B" 形式的字符串（日志显示用）。
 * 每个字节大写、两位十六进制、空格分隔。
 */
export function toHexString(bytes: Uint8Array | number[]): string {
  const arr = Array.from(bytes);
  return arr
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');
}

/* ===================== 乐谱输入解析 ===================== */

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

/* ===================== 存储容量常量 ===================== */

/** 乐谱: SRAM 最大指令条数（超过会被硬件丢弃）。 */
export const MAX_SRAM_COMMANDS = 32;

/** EEPROM 可选分区范围（0~7）。 */
export const EEPROM_PARTITION_MIN = 0;
export const EEPROM_PARTITION_MAX = 7;

/* ===================== 参数范围常量 ===================== */

/** BPM 设置范围。 */
export const BPM_MIN = 1;
export const BPM_MAX = 300;

/** 拍号预设选项（label 用于 UI 显示，beats 为每小节拍数，分母不参与编码）。 */
export const TIME_SIGNATURE_OPTIONS = [
  { label: '2/4', beats: 2 },
  { label: '3/4', beats: 3 },
  { label: '4/4', beats: 4 },
  { label: '6/8', beats: 6 },
] as const;

/** 马达强度设置范围（0~255，UI 限制 1~255）。 */
export const INTENSITY_MIN = 1;
export const INTENSITY_MAX = 255;
/** 手指编号范围（1~5，对应固件引脚索引 0~4）。 */
export const INTENSITY_FINGER_MIN = 1;
export const INTENSITY_FINGER_MAX = 5;

/** 小节跳转范围（1 基）。 */
export const JUMP_BAR_MIN = 1;
export const JUMP_BAR_MAX = 255;

/** 批量写入块大小（数据字节数/块，≤20）。 */
export const WRITE_BLOCK_SIZE = 20;
