/**
 * Keyflow 蓝牙协议 —— 命令定义与载荷组装。
 *
 * 协议版本：1
 *
 * CMD 空间分段（方向判定依据）：
 *   - 0x01~0x3F：命令段（App→设备 / 主机→从机）
 *   - 0x80~0xBF：响应/事件段（设备→App / 从机→主机）
 *
 * DST（目的节点）：
 *   - DST_PC = 0x01：PC/主机通道（模块 A）
 *   - DST_SLAVE = 0x02：从机通道（模块 B）
 *
 * 目标位（payload 首字节，TARGET_*）：
 *   - TARGET_LOCAL = 0：本地（主机/左手）
 *   - TARGET_SLAVE = 1：从机（右手）
 *
 * 所有载荷按小端（与 AVR/ARM 原生一致）。
 */

import { encodeFrame } from './frame';

/** 协议版本号。 */
export const PROTOCOL_VERSION = 1;

/* ===================== DST（目的节点） ===================== */
export const DST_PC = 0x01;
export const DST_SLAVE = 0x02;

/* ===================== 目标设备（应用层） ===================== */
export const TARGET_LOCAL = 0;
export const TARGET_SLAVE = 1;

/* ===================== 存储介质 ===================== */
export const STORAGE_SRAM = 0;
export const STORAGE_EEPROM = 1;

/* ===================== 错误码 ===================== */
export const ERR_OK = 0;
export const ERR_CRC = 1; // 校验失败
export const ERR_PARAM = 2; // 参数越界
export const ERR_STATE = 3; // 状态不允许
export const ERR_STORAGE = 4; // 存储失败
export const ERR_BUSY = 5; // 忙
export const ERR_GAP = 6; // 块序号缺口（批量写入）
export const ERR_ABORT = 7; // 会话被取消
export const ERR_TIMEOUT = 8; // 会话超时

/* ===================== 命令段（App→设备 / 主机→从机） ===================== */
export const CMD_HELLO = 0x01; // App->主机：payload=[protoVer][capability]
export const CMD_PING = 0x05; // 心跳请求
export const CMD_STOP = 0x10; // payload=[target]
export const CMD_PAUSE = 0x11; // payload=[target]
export const CMD_RESUME = 0x12; // payload=[target]
export const CMD_RESET = 0x13; // payload=[target]
export const CMD_SRAM_PLAY = 0x14; // payload=[target]
export const CMD_EEPROM_PLAY = 0x15; // payload=[target][partition]
export const CMD_CLEAR_SRAM = 0x16; // payload=[target]
export const CMD_CLEAR_EEPROM = 0x17; // payload=[target][partition]
export const CMD_JUMP_BAR = 0x18; // payload=[target][bar]
export const CMD_SET_MODE = 0x19; // payload=[target][mode] 0=单 1=双
export const CMD_SET_BPM = 0x1a; // payload=[target][bpm:2 LE]
export const CMD_SET_TIME_SIG = 0x1b; // payload=[target][beats]
export const CMD_SET_TPS = 0x1c; // payload=[target][tpsCode] 0=32 1=16 2=8
export const CMD_SET_INTENSITY = 0x1d; // payload=[target][pin][value]
export const CMD_WRITE_BEGIN = 0x20; // payload=[target][storage][partition][totalBytes:2 LE][batchCrc:2 LE]
export const CMD_WRITE_DATA = 0x21; // payload=[blockSeq][data:0..20]
export const CMD_WRITE_END = 0x22; // payload 空
export const CMD_WRITE_ABORT = 0x23; // payload 空
export const CMD_SYNC_REQ = 0x30; // 主机->从机：payload=[txn][t1:4 LE]
export const CMD_SYNC_OFFSET = 0x31; // 主机->从机：payload=[txn][offset:4 LE]
export const CMD_SET_ROLE = 0x32; // App->主机：payload=[roleByte] 配置角色并复位

/* ===================== 响应/事件段（设备→App / 从机→主机） ===================== */
export const CMD_HELLO_ACK = 0x81; // payload=[protoVer][capability][fwVer:2 LE][role]
export const CMD_ACK = 0x82; // 通用成功：payload=[status]
export const CMD_NAK = 0x83; // 通用失败：payload=[errCode]
export const CMD_PONG = 0x86; // payload=[statusFlags]
export const CMD_EVENT = 0x87; // payload=[eventCode][data...]
export const CMD_WRITE_DATA_ACK = 0x88; // payload=[blockSeq][status]
export const CMD_WRITE_RESULT = 0x89; // payload=[bytesWritten:2 LE][crcOk][status]
export const CMD_SYNC_REP = 0xb0; // 从机->主机：payload=[txn][t1:4][t2:4][t3:4]
export const CMD_SYNC_ACK = 0xb1; // 从机->主机：payload=[txn][status]

/* ===================== 事件码 ===================== */
export const EVT_DEVICE_READY = 0x01; // 设备就绪
export const EVT_SLAVE_LINK_LOST = 0x02; // 从机链路丢失
export const EVT_SLAVE_LINK_RESTORED = 0x03; // 从机链路恢复
export const EVT_SYNC_COMPLETE = 0x05; // 校时完成：payload=[bestRtt:2 LE][offset:4 LE]

/** 命令是否属于"命令段"（App→设备）。 */
export function isCommand(cmd: number): boolean {
  return cmd < 0x80;
}

/** 命令是否属于"响应/事件段"（设备→App）。 */
export function isResponse(cmd: number): boolean {
  return cmd >= 0x80;
}

/* ===================== 载荷组装辅助 ===================== */

function u8(...vals: number[]): Uint8Array {
  return Uint8Array.from(vals);
}

function u16le(v: number): [number, number] {
  return [v & 0xff, (v >> 8) & 0xff];
}

function u32le(v: number): [number, number, number, number] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
}

/* ===================== 命令组装（返回转义字节流） ===================== */

/**
 * 组装一个命令帧。
 * @param seq 帧序号
 * @param dst 目的节点（DST_PC / DST_SLAVE）
 * @param cmd 命令码
 * @param payload 载荷字节
 */
export function buildFrame(seq: number, dst: number, cmd: number, payload: Uint8Array): Uint8Array {
  return encodeFrame(seq, dst, cmd, payload);
}

/** HELLO：App→主机，请求连接握手。 */
export function buildHello(seq: number): Uint8Array {
  return encodeFrame(seq, DST_PC, CMD_HELLO, u8(PROTOCOL_VERSION, 0x00));
}

/** PING 心跳。 */
export function buildPing(seq: number, dst = DST_PC): Uint8Array {
  return encodeFrame(seq, dst, CMD_PING, new Uint8Array(0));
}

/** 播放/控制类命令（payload 首字节为目标位）。 */
export function buildControl(
  seq: number,
  cmd: number,
  dst: number,
  target: number,
  extra: number[] = []
): Uint8Array {
  return encodeFrame(seq, dst, cmd, u8(target, ...extra));
}

/** 乐谱写入会话：WRITE_BEGIN。 */
export function buildWriteBegin(
  seq: number,
  dst: number,
  target: number,
  storage: number,
  partition: number,
  totalBytes: number,
  batchCrc: number
): Uint8Array {
  const [t0, t1] = u16le(totalBytes);
  const [c0, c1] = u16le(batchCrc);
  return encodeFrame(seq, dst, CMD_WRITE_BEGIN, u8(target, storage, partition, t0, t1, c0, c1));
}

/** 乐谱写入会话：WRITE_DATA。blockSeq 从 0 开始。 */
export function buildWriteData(seq: number, dst: number, blockSeq: number, data: Uint8Array): Uint8Array {
  return encodeFrame(seq, dst, CMD_WRITE_DATA, u8(blockSeq, ...Array.from(data)));
}

/** 乐谱写入会话：WRITE_END。 */
export function buildWriteEnd(seq: number, dst: number): Uint8Array {
  return encodeFrame(seq, dst, CMD_WRITE_END, new Uint8Array(0));
}

/** 乐谱写入会话：WRITE_ABORT。 */
export function buildWriteAbort(seq: number, dst: number): Uint8Array {
  return encodeFrame(seq, dst, CMD_WRITE_ABORT, new Uint8Array(0));
}

/* ===================== 便捷语义指令（供 UI 调用） ===================== */

/** 目标设备对应的 DST。target='left' -> DST_PC，'right' -> DST_SLAVE。 */
export function dstForTarget(target: 'left' | 'right'): number {
  return target === 'left' ? DST_PC : DST_SLAVE;
}

/** 目标设备对应的目标位。 */
export function targetBitForTarget(target: 'left' | 'right'): number {
  return target === 'left' ? TARGET_LOCAL : TARGET_SLAVE;
}
