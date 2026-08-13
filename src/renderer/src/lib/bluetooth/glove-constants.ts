/**
 * 振動手套（左手套・マスター）とのBluetooth通信に使うUUID定数。
 *
 * 通信トポロジー: PCは左手套（マスター）のみと接続し、右手套には直接接続しない。
 * 左手套が全指令を受信し、モードに応じてローカル実行 or 右手套へ転送する。
 * 右手套はBluetoothサービスを外部に公開しない。
 */

/** 主サービスUUID（左手套が公開するGATTサービス）。 */
export const GLOVE_SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb';

/** Notify キャラクタリスティックUUID（手套→PCの通知用。現状は未使用）。 */
export const GLOVE_NOTIFY_UUID = '0000fff1-0000-1000-8000-00805f9b34fb';

/** Write キャラクタリスティックUUID（PC→手套の指令書き込み用）。 */
export const GLOVE_WRITE_UUID = '0000fff2-0000-1000-8000-00805f9b34fb';

/**
 * 左手套の想定デバイス名（参考値）。
 * 現在は acceptAllDevices + ユーザー選択方式のためフィルタには使わないが、
 * 左手套の識別目安として残す（UI表示やデバッグ用）。
 */
export const GLOVE_NAME_PREFIX = 'Piano_L';
