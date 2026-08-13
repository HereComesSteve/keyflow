import { GLOVE_SERVICE_UUID, GLOVE_WRITE_UUID } from './glove-constants';

/**
 * Bluetooth接続成功時の結果。deviceNameとWrite用キャラクタリスティックを返す。
 * キャラクタリスティックはglove-sliceへ保存し、切断時の再利用・指令送信に使う。
 */
export interface GloveConnection {
  deviceName: string;
  characteristic: BluetoothRemoteGATTCharacteristic;
}

/**
 * デバイス選択（requestDevice）がタイムアウトしたことを示すエラー。
 * 主プロセスの select-bluetooth-device ハンドラが Piano_L デバイスを見つけられない
 * まま時間が経過した場合に投げる。UI側で専用メッセージへ振り分けるために使う。
 */
export class GloveScanTimeoutError extends Error {
  constructor() {
    super('Glove scan timed out');
    this.name = 'GloveScanTimeoutError';
  }
}

/** requestDevice の待機上限（ms）。ユーザーがデバイスを選ぶ時間を含むため余裕を持たせる。 */
const GLOVE_SCAN_TIMEOUT_MS = 60000;

/**
 * 每条指令发送间隔（ms）。
 * 9600 baud 下单条指令传输约 4ms，5ms 足够让 BLE 缓冲区排空。
 * 870 条指令写入时间从 43 秒降到约 4.35 秒。
 */
const SEND_INTERVAL_MS = 5;

/**
 * 振動手套（左手套・マスター）のBluetooth接続をカプセル化する。
 *
 * 通信トポロジーの制約上、PCは左手套のみと接続する（右手套は左手套経由で制御）。
 * 本クラスは接続（requestDevice → GATT接続 → Write特性取得）と切断のみを担い、
 * 接続状態・ログの管理はglove-slice側で行う（関心の分離）。
 *
 * 注意: Web Bluetooth APIは開発環境（localhost）でのみ利用可能。
 * 本番（file://プロトコル）では無効化されるため、別途noble等での置換が必要。
 */
export class GloveController {
  /** 上次指令发送的时间戳，用于间隔控制。 */
  private lastSendTime = 0;
  /** 发送链：串行化所有指令，确保间隔控制不被并发调用破坏。 */
  private sendChain: Promise<void> = Promise.resolve();
  /** 诊断：首次发送时打印使用的写入方式（只打印一次）。 */
  private writeMethodLogged = false;

  /**
   * Bluetooth接続フローを実行する。
   *
   * 1. navigator.bluetooth.requestDevice() を acceptAllDevices で呼び出す
   *    （名前フィルタ無し。主プロセスが発見デバイス一覧をrendererへ転送し、
   *     ユーザーがGloveControlPanelの一覧から選択する。任意サービス: 主サービスUUID）
   * 2. 選択されたデバイスのGATTサーバへ接続
   * 3. 主サービス（0000fff0-...）を取得
   * 4. Writeキャラクタリスティック（0000fff2-...）を取得
   *
   * requestDevice はユーザーがデバイスを選択するまで解決しない。無限待機を避けるため
   * タイムアウトと競わせる。ユーザーがキャンセルした場合、主プロセスが空文字を
   * callbackへ渡し、requestDeviceはNotFoundErrorでrejectされる（呼び出し側でtry-catch）。
   *
   * @throws Web Bluetooth APIが利用不可、選択デバイスが手套でない（GATTサービス無し）、
   *         または接続の各段階で失敗した場合
   */
  async connect(): Promise<GloveConnection> {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth API is unavailable in this environment.');
    }
    // 重置诊断标志，新连接时重新打印写入方式
    this.writeMethodLogged = false;

    // requestDevice はユーザーがデバイスを選択するまで解決しない。無限待機を避けるため
    // タイムアウトと競わせる。タイムアウト勝利時も requestPromise は裏で保留されたままに
    // なるため、後から reject された場合の未処理拒否を抑制する no-op catch を付ける。
    const requestPromise = navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
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
    const characteristic = await service.getCharacteristic(GLOVE_WRITE_UUID);

    return {
      deviceName: device.name ?? 'Unknown device',
      characteristic,
    };
  }

  /**
   * 通过已连接的 characteristic 发送 4 字节指令。
   *
   * 串行化所有发送（链式 Promise）并保证两次发送间至少间隔 SEND_INTERVAL_MS，
   * 避免 BLE 队列溢出。优先使用 writeValueWithoutResponse（无需等设备 ACK），
   * 不支持时回退到 writeValue（write with response）。
   *
   * 单次失败不会打断后续指令的发送（链上每次调用独立 reject/resolve）。
   *
   * @throws writeValue 失败时抛出
   */
  sendCommand(characteristic: BluetoothRemoteGATTCharacteristic, data: Uint8Array): Promise<void> {
    const run = async (): Promise<void> => {
      const elapsed = Date.now() - this.lastSendTime;
      if (elapsed < SEND_INTERVAL_MS) {
        await new Promise((resolve) => setTimeout(resolve, SEND_INTERVAL_MS - elapsed));
      }
      // 优先无响应写入：不等 ACK，一个连接间隔即可完成（约 30ms→5ms）
      // 回退带响应写入：每条需等 ACK（约 120ms），慢但兼容性好
      if (characteristic.properties.writeWithoutResponse) {
        if (!this.writeMethodLogged) {
          console.log('[GloveController] 使用 writeValueWithoutResponse（无响应写入）');
          this.writeMethodLogged = true;
        }
        await characteristic.writeValueWithoutResponse(data);
      } else {
        if (!this.writeMethodLogged) {
          console.log('[GloveController] 使用 writeValue（带响应写入，较慢）');
          this.writeMethodLogged = true;
        }
        await characteristic.writeValue(data);
      }
      this.lastSendTime = Date.now();
    };
    // 前一个发送完成（无论成功失败）后再执行本次，保证串行 + 间隔控制。
    this.sendChain = this.sendChain.catch(() => {}).then(run);
    return this.sendChain;
  }

  /**
   * GATT接続を切断する。キャラクタリスティックからデバイスを逆参照して
   * gatt.disconnect()を呼ぶ。未接続・characteristicがnullの場合は何もしない。
   */
  disconnect(characteristic: BluetoothRemoteGATTCharacteristic | null): void {
    if (!characteristic) return;
    const gatt = characteristic.service?.device?.gatt;
    if (gatt?.connected) {
      gatt.disconnect();
    }
  }
}

/** アプリ全体で共有するシングルトンインスタンス。 */
export const gloveController = new GloveController();
