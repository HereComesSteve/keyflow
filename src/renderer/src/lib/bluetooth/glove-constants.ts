/**
 * 振動手套（左手套・マスター）とのBluetooth通信に使うUUID定数。
 *
 * 通信トポロジー: PCは左手套（マスター）のみと接続し、右手套には直接接続しない。
 * 左手套が全指令を受信し、モードに応じてローカル実行 or 右手套へ転送する。
 * 右手套はBluetoothサービスを外部に公開しない。
 *
 * 新协议（重构后）：
 * - Write 特征（0000fff2）承载 App→设备 的协议帧字节流（HDLC 风格，可跨 BLE 写分片）；
 * - Notify 特征（0000fff1）承载 设备→App 的所有响应/事件/心跳帧；
 * - 设备→App 不再有"无反馈"路径，所有命令均有 ACK/NAK。
 */

/** 主サービスUUID（左手套が公開するGATTサービス）。 */
export const GLOVE_SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb';

/** Notify キャラクタリスティックUUID（手套→PC の応答/イベント/心跳用）。 */
export const GLOVE_NOTIFY_UUID = '0000fff1-0000-1000-8000-00805f9b34fb';

/** Write キャラクタリスティックUUID（PC→手套の指令書き込み用）。 */
export const GLOVE_WRITE_UUID = '0000fff2-0000-1000-8000-00805f9b34fb';

/**
 * 左手套の想定デバイス名（参考値）。
 * 現在は acceptAllDevices + ユーザー選択方式のためフィルタには使わないが、
 * 左手套の識別目安として残す（UI表示やデバッグ用）。
 */
export const GLOVE_NAME_PREFIX = 'Piano_L';
