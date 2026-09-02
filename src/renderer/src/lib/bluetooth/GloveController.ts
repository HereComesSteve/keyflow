import { GLOVE_SERVICE_UUID, GLOVE_WRITE_UUID, GLOVE_NOTIFY_UUID } from './glove-constants';
import { GloveLink, GloveLinkCallbacks, WriteSessionResult } from './protocol/GloveLink';
import { DecodedFrame } from './protocol/frame';
import {
  CMD_ACK,
  CMD_HELLO,
  CMD_HELLO_ACK,
  DST_PC,
  ERR_OK,
  PROTOCOL_VERSION,
} from './protocol/commands';

/**
 * Bluetooth接続成功時の結果。deviceNameとWrite/Notify用キャラクタリスティックを返す。
 * キャラクタリスティックはglove-sliceへ保存し、切断時の再利用・指令送信に使う。
 */
export interface GloveConnection {
  deviceName: string;
  characteristic: BluetoothRemoteGATTCharacteristic;
  notifyCharacteristic: BluetoothRemoteGATTCharacteristic;
}

/**
 * デバイス選択（requestDevice）がタイムアウトしたことを示すエラー。
 */
export class GloveScanTimeoutError extends Error {
  constructor() {
    super('Glove scan timed out');
    this.name = 'GloveScanTimeoutError';
  }
}

/** requestDevice の待機上限（ms）。 */
const GLOVE_SCAN_TIMEOUT_MS = 60000;

/** 指令发送结果（不抛出，UI 友好）。 */
export interface GloveSendResult {
  ok: boolean;
  /** ACK 携带的状态码（仅 ACK）。 */
  status?: number;
  /** NAK 携带的错误码。 */
  errorCode?: number;
  /** 收到响应帧（如有）。 */
  frame?: DecodedFrame;
  /** 发送帧的转义字节流（日志可追溯用）。 */
  encoded?: Uint8Array;
  /** 失败原因描述（超时/异常/NAK）。 */
  error?: string;
}

/** 乐谱写入结果。 */
export interface GloveWriteResult {
  ok: boolean;
  result?: WriteSessionResult;
  error?: string;
}

/**
 * 振動手套（左手套・マスター）のBluetooth接続をカプセル化する。
 *
 * 重构后（新协议）：
 * - 连接时同时取得 Write（App→设备）与 Notify（设备→App）特征；
 * - 协议层逻辑（帧编解码、ACK 等待与重传、批量写入会话、心跳）全部收敛到 GloveLink，
 *   本类只负责 BLE 连接生命周期与高层 API 封装，与 UI 解耦。
 */
export class GloveController {
  private link: GloveLink;
  private linkCallbacks: GloveLinkCallbacks = {};
  private deviceName: string | null = null;
  private writeChar: BluetoothRemoteGATTCharacteristic | null = null;
  private notifyChar: BluetoothRemoteGATTCharacteristic | null = null;

  constructor() {
    this.link = new GloveLink(this.linkCallbacks);
  }

  /** 设置设备→App 事件回调（如从机断链通知、校时完成）。 */
  setEventCallback(cb: GloveLinkCallbacks['onEvent']): void {
    this.linkCallbacks.onEvent = cb;
    // 若已连接，重建链路层会丢失 attach；改为仅更新回调引用（link 持有同一对象引用）
    // GloveLink 内部回调对象与 linkCallbacks 共享引用，直接赋值即可生效。
  }

  async connect(): Promise<GloveConnection> {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth API is unavailable in this environment.');
    }

    const requestPromise = navigator.bluetooth.requestDevice({
      // 按广播名前缀过滤，只匹配手套设备（Glove_L / Glove_R），
      // 避免无关设备占据扫描窗口；无名称设备直接不显示。
      filters: [{ namePrefix: 'Glove' }],
      optionalServices: [GLOVE_SERVICE_UUID],
    });
    requestPromise.catch(() => {});

    const device = await Promise.race([
      requestPromise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new GloveScanTimeoutError()), GLOVE_SCAN_TIMEOUT_MS);
      }),
    ]);

    if (!device.gatt) {
      throw new Error('GATT server is unavailable on the selected device.');
    }

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(GLOVE_SERVICE_UUID);
    const writeChar = await service.getCharacteristic(GLOVE_WRITE_UUID);
    // 尝试获取 Notify 特征（设备→App 响应/事件通道）。部分模块可能未启用，容错。
    let notifyChar: BluetoothRemoteGATTCharacteristic | null = null;
    try {
      notifyChar = await service.getCharacteristic(GLOVE_NOTIFY_UUID);
    } catch (err) {
      console.warn('[GloveController] Notify characteristic not found:', err);
    }
    if (!notifyChar) {
      throw new Error('Notify characteristic is unavailable; new protocol requires it.');
    }

    this.deviceName = device.name ?? 'Unknown device';
    this.writeChar = writeChar;
    this.notifyChar = notifyChar;
    this.link.attach(writeChar, notifyChar);

    // 连接握手：HELLO（协议版本协商）
    await this.sendCommand(DST_PC, CMD_HELLO, new Uint8Array([PROTOCOL_VERSION, 0x00]), [CMD_HELLO_ACK], {
      ackTimeoutMs: 1000,
      maxRetries: 2,
    });

    return {
      deviceName: this.deviceName,
      characteristic: writeChar,
      notifyCharacteristic: notifyChar,
    };
  }

  /**
   * 发送一条命令并等待 ACK/NAK（超时重发，最多 3 次）。
   * @param dst 目的节点（DST_PC / DST_SLAVE）
   * @param cmd 命令码
   * @param payload 载荷
   * @param acceptCmds 有效成功响应命令集合
   * @param opts 超时/重试覆盖
   * @returns 结果对象；ok=false 时不抛出，error 描述原因。
   */
  async sendCommand(
    dst: number,
    cmd: number,
    payload: Uint8Array = new Uint8Array(0),
    acceptCmds: number[] = [CMD_ACK],
    opts?: { ackTimeoutMs?: number; maxRetries?: number }
  ): Promise<GloveSendResult> {
    try {
      const { frame, encoded } = await this.link.sendCommand(dst, cmd, payload, acceptCmds, opts);
      if (frame.cmd === 0x83 /* NAK */) {
        return {
          ok: false,
          errorCode: frame.payload[0] ?? -1,
          error: `NAK err=${frame.payload[0] ?? -1}`,
          frame,
          encoded,
        };
      }
      return { ok: true, status: frame.payload[0] ?? ERR_OK, frame, encoded };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  /** 直接发送原始编码帧（保留兼容入口；一般使用 sendCommand）。 */
  async sendRaw(
    encoded: Uint8Array,
    acceptCmds: number[] = [CMD_ACK],
    opts?: { ackTimeoutMs?: number; maxRetries?: number }
  ): Promise<GloveSendResult> {
    try {
      const frame = await this.link.request(encoded, acceptCmds, opts);
      if (frame.cmd === 0x83) {
        return { ok: false, errorCode: frame.payload[0] ?? -1, error: `NAK err=${frame.payload[0] ?? -1}`, frame, encoded };
      }
      return { ok: true, status: frame.payload[0] ?? ERR_OK, frame, encoded };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  /** 批量写入乐谱会话（走协议层 WRITE_BEGIN/DATA/END）。 */
  async writeScore(opts: {
    dst: number;
    target: number;
    storage: number;
    partition: number;
    data: Uint8Array;
    batchCrc: number;
    blockSize?: number;
    onProgress?: (writtenBytes: number, totalBytes: number) => void;
    shouldAbort?: () => boolean;
  }): Promise<GloveWriteResult> {
    try {
      const result = await this.link.writeScoreSession(opts);
      return { ok: result.status === ERR_OK && result.crcOk, result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  /** 应用层命令便捷方法：DST 默认发往主机。 */
  get isConnected(): boolean {
    return this.link.isConnected;
  }

  disconnect(characteristic: BluetoothRemoteGATTCharacteristic | null): void {
    this.link.detach();
    if (!characteristic) return;
    const gatt = characteristic.service?.device?.gatt;
    if (gatt?.connected) {
      gatt.disconnect();
    }
  }
}

/** アプリ全体で共有するシングルトンインスタンス。 */
export const gloveController = new GloveController();

// 保留 DST_PC 导出避免破坏引用（UI 层）
export { DST_PC };
