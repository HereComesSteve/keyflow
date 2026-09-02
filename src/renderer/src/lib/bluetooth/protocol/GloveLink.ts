/**
 * Keyflow 蓝牙协议 —— 链路层（App 侧）。
 *
 * 职责：
 * - 持有 Write / Notify 两个 BLE 特征；
 * - 将协议帧转义字节流分片（≤20B/次）写入 Write 特征，串行化 + 帧间不交错；
 * - 订阅 Notify，把设备→App 字节流喂给 FrameParser 增量解帧；
 * - 请求/响应模型：发命令登记 pending（按 SEQ 匹配），等待 ACK/NAK/专用响应，
 *   超时重发（默认 300ms × 最多 3 次）；
 * - 批量写入会话：WRITE_BEGIN → N×WRITE_DATA（停等 ACK，GAP 即重发）→ WRITE_END，
 *   通过缓存最近 WRITE_RESULT 提供最终写入结果；
 * - 心跳：周期 PING→PONG，用于维持/检测协议层链路健康。
 *
 * 本模块与 UI 完全解耦；UI 只通过 GloveController 暴露的高层 API 交互。
 */

import { FrameParser, DecodedFrame, encodeFrame } from './frame';
import {
  CMD_ACK,
  CMD_NAK,
  CMD_PONG,
  CMD_EVENT,
  CMD_WRITE_DATA_ACK,
  CMD_WRITE_RESULT,
  CMD_WRITE_BEGIN,
  CMD_WRITE_DATA,
  CMD_WRITE_END,
  CMD_WRITE_ABORT,
  ERR_OK,
  ERR_GAP,
  DST_PC,
  buildPing,
  buildWriteEnd,
  buildWriteAbort,
} from './commands';

/** BLE 单次写入最大字节（默认 MTU 23，ATT 头 3 字节，安全取 20）。 */
const BLE_WRITE_CHUNK = 20;

/** 设备→App 帧的类型回调。 */
export interface GloveLinkCallbacks {
  /** 收到设备主动事件（EVT_*）。 */
  onEvent?: (eventCode: number, data: Uint8Array) => void;
  /** 收到任意响应/事件帧。 */
  onResponse?: (frame: DecodedFrame) => void;
}

/** 链路层选项。 */
export interface GloveLinkOptions {
  /** 等待响应的超时（ms）。默认 300。 */
  ackTimeoutMs?: number;
  /** 最多重发次数。默认 3。 */
  maxRetries?: number;
  /** 心跳间隔（ms）。默认 5000。 */
  pingIntervalMs?: number;
  /** 连续多少次心跳无响应判定链路异常。默认 3。 */
  pingFailThreshold?: number;
}

/** 批量写入会话的结果。 */
export interface WriteSessionResult {
  /** 设备实际写入的字节数（不含结束标志）。 */
  bytesWritten: number;
  /** 整批 CRC 是否校验通过。 */
  crcOk: boolean;
  /** 最终状态码（ERR_*）。 */
  status: number;
  /** 发送的块数。 */
  blocksSent: number;
  /** 触发的重发次数。 */
  retries: number;
  /** 耗时（ms）。 */
  elapsedMs: number;
}

/** 请求-响应挂起条目。 */
interface PendingRequest {
  seq: number;
  resolve: (frame: DecodedFrame) => void;
  reject: (err: Error) => void;
  /** 有效响应命令集合（如发 HELLO 期待 HELLO_ACK/NAK）。 */
  acceptCmds: Set<number>;
  attempts: number;
  timer: ReturnType<typeof setTimeout>;
  /** 重发用：帧的转义字节流。 */
  encoded: Uint8Array;
}

export class GloveLink {
  private writeChar: BluetoothRemoteGATTCharacteristic | null = null;
  private notifyChar: BluetoothRemoteGATTCharacteristic | null = null;
  private parser = new FrameParser();
  private sendSeq = 0;
  private pending = new Map<number, PendingRequest>();
  private writeChain: Promise<void> = Promise.resolve();
  private callbacks: GloveLinkCallbacks;
  private opts: Required<GloveLinkOptions>;
  private connected = false;

  // 心跳
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingFailCount = 0;

  // 最近一次 WRITE_RESULT（缓存）
  private lastWriteResult: WriteSessionResult | null = null;
  private writeResultWaiters: Array<(r: WriteSessionResult) => void> = [];

  constructor(callbacks: GloveLinkCallbacks = {}, opts: GloveLinkOptions = {}) {
    this.callbacks = callbacks;
    this.opts = {
      ackTimeoutMs: opts.ackTimeoutMs ?? 300,
      maxRetries: opts.maxRetries ?? 3,
      pingIntervalMs: opts.pingIntervalMs ?? 5000,
      pingFailThreshold: opts.pingFailThreshold ?? 3,
    };
  }

  get isConnected(): boolean {
    return this.connected && this.writeChar !== null;
  }

  /**
   * 绑定 BLE 特征并订阅 Notify。
   */
  attach(
    writeChar: BluetoothRemoteGATTCharacteristic,
    notifyChar: BluetoothRemoteGATTCharacteristic
  ): void {
    this.detach();
    this.writeChar = writeChar;
    this.notifyChar = notifyChar;
    this.connected = true;
    this.parser = new FrameParser();
    this.lastWriteResult = null;

    if (notifyChar.properties.notify || notifyChar.properties.indicate) {
      notifyChar.addEventListener('characteristicvaluechanged', this.handleNotify);
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      notifyChar.startNotifications().catch((err) => {
        console.warn('[GloveLink] startNotifications failed:', err);
      });
    } else {
      console.warn('[GloveLink] Notify characteristic does not support notifications');
    }

    this.startPing();
  }

  /** 断开：取消 pending、停止心跳、解绑特征。 */
  detach(): void {
    this.stopPing();
    this.connected = false;
    for (const req of this.pending.values()) {
      clearTimeout(req.timer);
      req.reject(new Error('Link detached'));
    }
    this.pending.clear();
    if (this.notifyChar) {
      this.notifyChar.removeEventListener('characteristicvaluechanged', this.handleNotify);
    }
    this.writeChar = null;
    this.notifyChar = null;
  }

  /* ===================== 底层写入（串行 + 分片） ===================== */

  private writeEncoded(encoded: Uint8Array): Promise<void> {
    const run = async (): Promise<void> => {
      if (!this.writeChar) throw new Error('Not connected');
      for (let i = 0; i < encoded.length; i += BLE_WRITE_CHUNK) {
        const slice = encoded.subarray(i, i + BLE_WRITE_CHUNK);
        if (this.writeChar.properties.writeWithoutResponse) {
          await this.writeChar.writeValueWithoutResponse(slice);
        } else {
          await this.writeChar.writeValueWithResponse(slice);
        }
      }
    };
    this.writeChain = this.writeChain.catch(() => {}).then(run);
    return this.writeChain;
  }

  /* ===================== 请求/响应模型 ===================== */

  /**
   * 发送一帧并等待匹配的响应。
   * @param encoded 已编码（转义）的帧字节流
   * @param acceptCmds 视为"有效成功响应"的命令码集合（NAK 总是被接受为到达）
   * @param opts 可选覆盖超时/重试
   */
  request(
    encoded: Uint8Array,
    acceptCmds: number[] = [CMD_ACK],
    opts: { ackTimeoutMs?: number; maxRetries?: number; seq?: number } = {}
  ): Promise<DecodedFrame> {
    const seq = opts.seq ?? this.nextSeq();
    return this.requestWithSeq(seq, encoded, acceptCmds, opts);
  }

  /**
   * 高层命令入口：组装命令帧（分配 SEQ）→ 发送 → 等待 ACK/NAK。
   * @returns 响应帧与发送帧的转义字节流（日志可追溯用）
   */
  sendCommand(
    dst: number,
    cmd: number,
    payload: Uint8Array = new Uint8Array(0),
    acceptCmds: number[] = [CMD_ACK],
    opts: { ackTimeoutMs?: number; maxRetries?: number } = {}
  ): Promise<{ frame: DecodedFrame; encoded: Uint8Array }> {
    const seq = this.nextSeq();
    const encoded = encodeFrame(seq, dst, cmd, payload);
    return this.requestWithSeq(seq, encoded, acceptCmds, opts).then((frame) => ({ frame, encoded }));
  }

  private requestWithSeq(
    seq: number,
    encoded: Uint8Array,
    acceptCmds: number[] = [CMD_ACK],
    opts: { ackTimeoutMs?: number; maxRetries?: number } = {}
  ): Promise<DecodedFrame> {
    const accept = new Set<number>([...acceptCmds, CMD_NAK]);
    // [diag] 发送帧 hex 日志
    console.log(
      `[GloveLink] TX seq=${seq} cmd=${'0x' + encoded[3].toString(16)} hex=${Array.from(encoded)
        .map((b) => '0x' + b.toString(16).padStart(2, '0'))
        .join(' ')}`
    );
    return new Promise<DecodedFrame>((resolve, reject) => {
      const req: PendingRequest = {
        seq,
        resolve,
        reject,
        acceptCmds: accept,
        attempts: 0,
        timer: null as unknown as ReturnType<typeof setTimeout>,
        encoded,
      };
      this.pending.set(seq, req);
      this.scheduleAttempt(req, opts);
    });
  }

  private nextSeq(): number {
    const seq = this.sendSeq;
    this.sendSeq = (this.sendSeq + 1) & 0xff;
    return seq;
  }

  private scheduleAttempt(
    req: PendingRequest,
    opts: { ackTimeoutMs?: number; maxRetries?: number }
  ): void {
    req.attempts++;
    this.writeEncoded(req.encoded).catch((err) => {
      this.pending.delete(req.seq);
      clearTimeout(req.timer);
      req.reject(err instanceof Error ? err : new Error(String(err)));
    });
    const timeoutMs = opts.ackTimeoutMs ?? this.opts.ackTimeoutMs;
    const maxRetries = opts.maxRetries ?? this.opts.maxRetries;
    req.timer = setTimeout(() => {
      if (!this.pending.has(req.seq)) return;
      if (req.attempts <= maxRetries) {
        this.scheduleAttempt(req, opts);
      } else {
        this.pending.delete(req.seq);
        req.reject(new Error(`ACK timeout after ${req.attempts} attempts (seq=${req.seq})`));
      }
    }, timeoutMs);
  }

  /* ===================== 接收（Notify） ===================== */

  private handleNotify = (event: Event): void => {
    const target = event.target as unknown as BluetoothRemoteGATTCharacteristic;
    const value = target.value;
    if (!value) return;
    const bytes = new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
    );
    this.feedBytes(bytes);
  };

  /** 供外部（如测试/调试）喂入字节流。 */
  feedBytes(bytes: Uint8Array): void {
    const frames = this.parser.feed(bytes);
    for (const frame of frames) {
      if (!frame.valid) {
        console.warn('[GloveLink] discarded invalid frame (CRC fail)');
        continue;
      }
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: DecodedFrame): void {
    // [diag] 接收帧 hex 日志
    console.log(
      `[GloveLink] RX seq=${frame.seq} cmd=${'0x' + frame.cmd.toString(16)} valid=${frame.valid}`
    );
    // 只处理发给 PC 的响应/事件
    if (frame.cmd < 0x80) return; // 命令段（发给设备的），App 侧忽略
    if (frame.dst !== DST_PC) return; // 非发往 PC 的帧忽略（如主机→从机流量）

    // 心跳 PONG
    if (frame.cmd === CMD_PONG) {
      this.pingFailCount = 0;
    }

    // 缓存 WRITE_RESULT
    if (frame.cmd === CMD_WRITE_RESULT && frame.payload.length >= 4) {
      const result: WriteSessionResult = {
        bytesWritten: frame.payload[0] | (frame.payload[1] << 8),
        crcOk: frame.payload[2] !== 0,
        status: frame.payload[3],
        blocksSent: 0,
        retries: 0,
        elapsedMs: 0,
      };
      this.lastWriteResult = result;
      const waiters = this.writeResultWaiters.splice(0);
      for (const w of waiters) w(result);
    }

    // 匹配 pending
    const req = this.pending.get(frame.seq);
    if (req) {
      if (req.acceptCmds.has(frame.cmd) || frame.cmd === CMD_NAK) {
        clearTimeout(req.timer);
        this.pending.delete(frame.seq);
        req.resolve(frame);
        return;
      }
    }

    this.callbacks.onResponse?.(frame);
    if (frame.cmd === CMD_EVENT && frame.payload.length >= 1) {
      this.callbacks.onEvent?.(frame.payload[0], frame.payload.subarray(1));
    }
  }

  /* ===================== 高层 API ===================== */

  /** 发送命令并等待 ACK/NAK。 */
  command(
    encoded: Uint8Array,
    accept: number[] = [CMD_ACK],
    opts?: { ackTimeoutMs?: number; maxRetries?: number }
  ): Promise<DecodedFrame> {
    return this.request(encoded, accept, opts);
  }

  /** 发送 PING 等待 PONG。 */
  ping(): Promise<DecodedFrame> {
    return this.request(buildPing(this.nextSeq(), DST_PC), [CMD_PONG], {
      ackTimeoutMs: 500,
      maxRetries: 1,
    });
  }

  /**
   * 批量写入会话（乐谱传输）。
   *
   * 流程：WRITE_BEGIN → N×WRITE_DATA（停等 ACK，GAP 即重发期望块）→ WRITE_END。
   * 设备收满 totalBytes 后回 WRITE_RESULT（缓存于 lastWriteResult）。
   */
  async writeScoreSession(opts: {
    dst: number;
    target: number;
    storage: number;
    partition: number;
    data: Uint8Array;
    batchCrc: number;
    blockSize?: number;
    onProgress?: (writtenBytes: number, totalBytes: number) => void;
    /** 每块发送前调用；返回 true 表示取消会话。 */
    shouldAbort?: () => boolean;
  }): Promise<WriteSessionResult> {
    const blockSize = Math.min(opts.blockSize ?? 20, 20);
    const start = Date.now();
    const totalBytes = opts.data.length;
    let retries = 0;
    let blocksSent = 0;
    this.lastWriteResult = null;

    // 1. WRITE_BEGIN（注意：seq 需与编码帧内 SEQ 一致，否则固件回包匹配不上 pending）
    const beginSeq = this.nextSeq();
    await this.request(encodeBeginFrame(beginSeq, opts), [CMD_ACK], { seq: beginSeq });

    try {
      // 2. WRITE_DATA 停等循环
      let offset = 0;
      let blockSeq = 0;
      while (offset < totalBytes) {
        if (opts.shouldAbort?.()) {
          throw new Error('cancelled');
        }
        const chunk = opts.data.subarray(offset, Math.min(offset + blockSize, totalBytes));
        const dataSeq = this.nextSeq();
        const dataFrame = buildWriteDataFrame(dataSeq, opts.dst, blockSeq, chunk);
        blocksSent++;
        const resp = await this.request(dataFrame, [CMD_WRITE_DATA_ACK], { seq: dataSeq });
        if (resp.cmd === CMD_NAK) {
          throw new Error(`WRITE_DATA NAK: err=${resp.payload[0] ?? '?'}`);
        }
        const ackedSeq = resp.payload[0];
        const status = resp.payload[1];
        if (ackedSeq === blockSeq && status === ERR_OK) {
          offset += chunk.length;
          blockSeq = (blockSeq + 1) & 0xff;
          opts.onProgress?.(offset, totalBytes);
        } else if (status === ERR_GAP) {
          retries++; // 设备请求重发当前块
        } else {
          retries++;
        }
      }

      // 3. WRITE_END（收尾；设备已收满，回 ACK）
      // 从机收满后会在 finishWriteSession 中同步回读 EEPROM 校验整批 CRC（I2C 逐字节，大数据需数秒），
      // 该期间从机主循环阻塞、无法及时回 ACK。故 WRITE_END 用长超时（默认 300ms 会误报超时），
      // 并保留重试兜底（半双工总线上收尾 ACK 偶发碰撞丢失时可重发恢复）。
      const endSeq = this.nextSeq();
      await this.request(buildWriteEnd(endSeq, opts.dst), [CMD_ACK], {
        seq: endSeq,
        ackTimeoutMs: 8000,
        maxRetries: 2,
      });

      // 4. 等待 WRITE_RESULT（可能早已缓存）
      const result = await this.waitWriteResult(start, totalBytes, blocksSent, retries);
      return result;
    } catch (err) {
      // 会话失败：尝试中止
      try {
        await this.writeEncoded(buildWriteAbort(this.nextSeq(), opts.dst));
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  /** 等待设备回 WRITE_RESULT（带超时）。 */
  private waitWriteResult(
    startTime: number,
    totalBytes: number,
    blocksSent: number,
    retries: number
  ): Promise<WriteSessionResult> {
    if (this.lastWriteResult) {
      return Promise.resolve({ ...this.lastWriteResult, blocksSent, retries });
    }
    return new Promise((resolve, reject) => {
      const timeoutMs = 3000;
      const timer = setTimeout(() => {
        const idx = this.writeResultWaiters.length;
        this.writeResultWaiters.splice(idx, 1);
        reject(new Error('WRITE_RESULT timeout'));
      }, timeoutMs);
      const waiter = (r: WriteSessionResult): void => {
        clearTimeout(timer);
        resolve({ ...r, blocksSent, retries });
      };
      this.writeResultWaiters.push(waiter);
    });
  }

  /* ===================== 心跳 ===================== */

  private startPing(): void {
    this.stopPing();
    this.pingFailCount = 0;
    this.pingTimer = setInterval(() => {
      if (!this.isConnected) return;
      this.ping().catch(() => {
        this.pingFailCount++;
        if (this.pingFailCount >= this.opts.pingFailThreshold) {
          this.stopPing();
        }
      });
    }, this.opts.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

/* ===================== 帧组装辅助 ===================== */

function encodeBeginFrame(
  seq: number,
  opts: {
    dst: number;
    target: number;
    storage: number;
    partition: number;
    data: Uint8Array;
    batchCrc: number;
  }
): Uint8Array {
  const totalBytes = opts.data.length;
  return encodeFrame(
    seq,
    opts.dst,
    CMD_WRITE_BEGIN,
    Uint8Array.from([
      opts.target,
      opts.storage,
      opts.partition,
      totalBytes & 0xff,
      (totalBytes >> 8) & 0xff,
      opts.batchCrc & 0xff,
      (opts.batchCrc >> 8) & 0xff,
    ])
  );
}

function buildWriteDataFrame(
  seq: number,
  dst: number,
  blockSeq: number,
  data: Uint8Array
): Uint8Array {
  return encodeFrame(seq, dst, CMD_WRITE_DATA, Uint8Array.from([blockSeq, ...Array.from(data)]));
}
