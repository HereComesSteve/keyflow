/**
 * Keyflow 蓝牙协议 —— 链路帧编解码（HDLC 风格）。
 *
 * 帧格式（未转义）：
 *   [0x7E] [LEN:1] [SEQ:1] [DST:1] [CMD:1] [PAYLOAD:0..N] [CRC16:2 LE]
 *
 * - 0x7E 为标志字节；载荷区（LEN..CRC）中出现的 0x7E / 0x7D 用字节填充转义：
 *     0x7E -> 0x7D 0x5E,  0x7D -> 0x7D 0x5D
 * - LEN = SEQ+DST+CMD+PAYLOAD 的长度（= 3 + N，不含标志与 CRC）
 * - DST 为目的节点：0x01=PC/主机（模块A通道），0x02=从机（模块B通道）。
 *   主机串口 TX 共线广播到模块 A/B，各节点只处理发往自己的 DST，从而隔离 PC 与从机流量。
 * - CRC16/CCITT-FALSE（多项式 0x1021，初值 0xFFFF，无反射），小端，覆盖 LEN..PAYLOAD。
 * - 最大未转义帧长 ≤ 32 字节 => 最大 PAYLOAD = 25 字节。
 *
 * 传输承载：
 * - UART（主机<->从机）与 BLE（App<->主机）都按"转义后字节流"传输；
 * - BLE 单次 writeValue 可携带帧的任意一段（≤MTU），接收端用 FrameParser 增量重组，
 *   因此帧分片对协议层完全透明。
 */

/** 标志字节（帧起始）。 */
export const FRAME_FLAG = 0x7e;
/** 转义字节。 */
export const FRAME_ESC = 0x7d;
/** 转义后的标志值（0x7E -> 0x7D 0x5E）。 */
export const FRAME_ESC_FLAG = 0x5e;
/** 转义后的转义值（0x7D -> 0x7D 0x5D）。 */
export const FRAME_ESC_ESC = 0x5d;

/** 未转义帧最大长度（UART 侧建议值）。 */
export const MAX_FRAME_LEN = 32;
/** 最大 PAYLOAD 长度（帧固定开销 7 字节：FLAG+LEN+SEQ+DST+CMD+CRC2）。 */
export const MAX_PAYLOAD = MAX_FRAME_LEN - 7; // = 25

/** 解帧后的协议帧。 */
export interface Frame {
  /** 帧序号（0~255 回绕），用于 ACK 匹配与丢帧检测。 */
  seq: number;
  /** 目的节点：DST_PC=0x01 / DST_SLAVE=0x02。 */
  dst: number;
  /** 命令码。 */
  cmd: number;
  /** 载荷。 */
  payload: Uint8Array;
}

/** 解帧结果。valid=false 表示 CRC 校验失败或长度非法（应丢弃）。 */
export interface DecodedFrame extends Frame {
  valid: boolean;
}

/**
 * CRC-16/CCITT-FALSE。
 * 多项式 0x1021，初值 0xFFFF，无反射、无异或输出。
 */
export function crc16(data: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/**
 * 组装并转义一个协议帧。
 * @param seq 帧序号
 * @param dst 目的节点
 * @param cmd 命令码
 * @param payload 载荷（长度不得超过 MAX_PAYLOAD）
 * @returns 可直接写入链路（BLE/UART）的转义字节流（以 0x7E 开头）
 */
export function encodeFrame(
  seq: number,
  dst: number,
  cmd: number,
  payload: Uint8Array
): Uint8Array {
  if (payload.length > MAX_PAYLOAD) {
    throw new Error(
      `payload too long: ${payload.length} > MAX_PAYLOAD ${MAX_PAYLOAD} (cmd=0x${cmd.toString(16)})`
    );
  }
  const len = 3 + payload.length; // LEN = SEQ+DST+CMD+PAYLOAD
  // body = [LEN][SEQ][DST][CMD][PAYLOAD]（共 1+len 字节），CRC 覆盖整个 body
  const body = new Uint8Array(1 + len + 2); // LEN + (SEQ/DST/CMD/PAYLOAD) + CRC
  body[0] = len;
  body[1] = seq & 0xff;
  body[2] = dst & 0xff;
  body[3] = cmd & 0xff;
  body.set(payload, 4);
  const crc = crc16(body.subarray(0, 1 + len));
  body[1 + len] = crc & 0xff;
  body[2 + len] = (crc >> 8) & 0xff;

  // 字节填充转义（LEN..CRC 全部参与转义）
  const escaped: number[] = [FRAME_FLAG];
  for (let i = 0; i < body.length; i++) {
    const b = body[i];
    if (b === FRAME_FLAG) {
      escaped.push(FRAME_ESC, FRAME_ESC_FLAG);
    } else if (b === FRAME_ESC) {
      escaped.push(FRAME_ESC, FRAME_ESC_ESC);
    } else {
      escaped.push(b);
    }
  }
  return Uint8Array.from(escaped);
}

/**
 * 增量帧解析器（状态机）。
 *
 * 输入为链路字节流（BLE notify 数据或 UART 读取），可能一次到达 0..n 字节、
 * 也可能一帧被切成多段到达。内部维护解转义缓冲与 CRC 校验，
 * 每组装完一帧即返回该帧，并立即准备好接收下一帧；丢字节后最坏丢一帧即可重同步。
 *
 * 状态转移：
 *   idle --见 0x7E--> collecting
 *   collecting: 解转义收 body；按 LEN 预知长度；收满 LEN+2 后校验 CRC，产出帧回 idle。
 *   任何非法状态（长度越界 / 非法转义 / 帧内撞见标志）→ 回 idle，丢弃当前半帧。
 */
export class FrameParser {
  private state: 'idle' | 'collecting' = 'idle';
  /** 解转义后的 body+CRC 缓冲。 */
  private buf: number[] = [];
  /** 期望的 body 长度（来自 LEN 字节）。 */
  private expectedLen = 0;
  /** 上一字节是转义符，本字节决定真实值。 */
  private pendingEscaped = false;

  /**
   * 喂入一段字节，返回本次累积产出的完整帧列表。
   */
  feed(data: Uint8Array): DecodedFrame[] {
    const frames: DecodedFrame[] = [];
    for (let i = 0; i < data.length; i++) {
      const frame = this.feedByte(data[i]);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  /** 喂入单个字节，若恰好组装完一帧则返回该帧，否则返回 null。 */
  feedByte(b: number): DecodedFrame | null {
    if (this.state === 'idle') {
      if (b === FRAME_FLAG) {
        this.state = 'collecting';
        this.buf = [];
        this.expectedLen = 0;
        this.pendingEscaped = false;
      }
      return null;
    }

    // ---- collecting ----
    if (b === FRAME_FLAG) {
      // 帧内撞见标志：前一帧截断/损坏，丢弃并从该标志开始新帧
      this.reset();
      this.state = 'collecting';
      return null;
    }
    if (b === FRAME_ESC) {
      this.pendingEscaped = true;
      return null;
    }
    if (this.pendingEscaped) {
      this.pendingEscaped = false;
      if (b === FRAME_ESC_FLAG) {
        return this.pushByte(FRAME_FLAG);
      } else if (b === FRAME_ESC_ESC) {
        return this.pushByte(FRAME_ESC);
      }
      // 非法转义序列：放弃当前帧
      this.reset();
      return null;
    }
    return this.pushByte(b);
  }

  /** 压入一个解转义后的原始字节；若恰好凑齐一帧则返回该帧。 */
  private pushByte(b: number): DecodedFrame | null {
    if (this.buf.length === 0) {
      // 首字节为 LEN
      if (b < 3 || b > MAX_PAYLOAD + 3) {
        this.reset();
        return null;
      }
      this.expectedLen = b;
      this.buf.push(b);
      return null;
    }
    this.buf.push(b);
    // body 总长 = 1(LEN) + expectedLen + 2(CRC)
    if (this.buf.length >= this.expectedLen + 3) {
      const full = Uint8Array.from(this.buf);
      const len = full[0];
      const body = full.subarray(0, len + 1); // LEN..PAYLOAD
      const crcLow = full[len + 1];
      const crcHigh = full[len + 2];
      const expectedCrc = (crcHigh << 8) | crcLow;
      const calcCrc = crc16(body);
      const valid = calcCrc === expectedCrc;
      const frame: DecodedFrame = {
        seq: full[1],
        dst: full[2],
        cmd: full[3],
        payload: full.subarray(4, len + 1),
        valid,
      };
      this.reset();
      return valid ? frame : null;
    }
    return null;
  }

  private reset(): void {
    this.state = 'idle';
    this.buf = [];
    this.expectedLen = 0;
    this.pendingEscaped = false;
  }
}

/**
 * 便捷函数：对完整（或分片）字节流做一次解析，返回所有完整帧。
 * 适合单元测试与一次性校验场景；生产路径直接使用 FrameParser 类增量 feed。
 */
export function parseFramesStream(chunks: Uint8Array[]): DecodedFrame[] {
  const parser = new FrameParser();
  const out: DecodedFrame[] = [];
  for (const chunk of chunks) {
    out.push(...parser.feed(chunk));
  }
  return out;
}
