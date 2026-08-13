import { StateCreator } from 'zustand';

/**
 * 振動手套（左手套・マスター）のBluetooth接続状態（Zustandスライス）。
 *
 * 通信トポロジーの制約上、PCは左手套のみと接続する。本スライスは左手套1台分の
 * 接続状態・Write用キャラクタリスティック・操作ログを管理する。
 * 実際のBluetooth通信処理はGloveControllerが担い、本スライスは状態の保持のみを行う
 * （関心の分離: ロジック=GloveController、状態=glove-slice）。
 *
 * 注意: characteristicは非シリアライズ可能なGATTオブジェクトだが、Zustandの
 * メモリ状態として保持する分には問題ない（永続化対象ではない）。
 */
export interface GloveSlice {
  /** 左手套が接続済みかどうか。 */
  isConnected: boolean;
  /** 接続中の左手套のデバイス名。未接続時はnull。 */
  deviceName: string | null;
  /** 接続中のWrite用キャラクタリスティック。未接続時はnull。指令送信に使う。 */
  characteristic: BluetoothRemoteGATTCharacteristic | null;
  /** 操作ログ（タイムスタンプ付き文字列）。直近50件のみ保持する。 */
  logs: string[];
  /** 接続成功時に呼ぶ。deviceNameとcharacteristicを設定しisConnectedをtrueにする。 */
  setGloveConnected: (deviceName: string, characteristic: BluetoothRemoteGATTCharacteristic) => void;
  /** 切断完了後に呼ぶ。characteristicをクリアしisConnectedをfalseにする。 */
  setGloveDisconnected: () => void;
  /** ログを1件追加する。直近50件のみ保持し古いものは破棄する。 */
  addGloveLog: (message: string) => void;
}

/** ログの保持上限（REQ: 直近50件）。 */
const MAX_LOGS = 50;

export const createGloveSlice: StateCreator<GloveSlice> = (set) => ({
  isConnected: false,
  deviceName: null,
  characteristic: null,
  logs: [],
  setGloveConnected: (deviceName, characteristic) =>
    set({ isConnected: true, deviceName, characteristic }),
  setGloveDisconnected: () =>
    set({ isConnected: false, deviceName: null, characteristic: null }),
  addGloveLog: (message) =>
    set((state) => {
      const next = [...state.logs, message];
      // 上限を超えた分は古いものから破棄する
      return { logs: next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next };
    }),
});
