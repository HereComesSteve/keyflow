import { StateCreator } from 'zustand';

/**
 * 振動手套（左手套・マスター）のBluetooth接続状態（Zustandスライス）。
 *
 * 通信トポロジーの制約上、PCは左手套のみと接続する。本スライスは左手套1台分の
 * 接続状態・Write/Notify用キャラクタリスティック・操作ログ・从机链路状态を管理する。
 * 実際のBluetooth通信処理はGloveController（内部で GloveLink）が担い、本スライスは
 * 状態の保持のみを行う（関心の分離: ロジック=GloveController、状態=glove-slice）。
 *
 * 注意: characteristicは非シリアライズ可能なGATTオブジェクトだが、Zustandの
 * メモリ状態として保持する分には問題ない（永続化対象ではない）。
 */
export interface GloveSyncInfo {
  /** 校时是否完成。 */
  synced: boolean;
  /** 最优 RTT（us）。 */
  bestRttUs: number;
  /** 计算得到的时钟偏移（us）。 */
  offsetUs: number;
  /** 校时完成时间。 */
  at: number;
}

export interface GloveSlice {
  /** 左手套が接続済みかどうか。 */
  isConnected: boolean;
  /** 接続中の左手套のデバイス名。未接続時はnull。 */
  deviceName: string | null;
  /** 接続中のWrite用キャラクタリスティック。未接続時はnull。 */
  characteristic: BluetoothRemoteGATTCharacteristic | null;
  /** 接続中のNotify用キャラクタリスティック（设备→App 响应/事件通道）。 */
  notifyCharacteristic: BluetoothRemoteGATTCharacteristic | null;
  /** 从机（右手）链路是否存活（主机侧心跳检测结果）。 */
  slaveLinkAlive: boolean;
  /** 最近一次校时结果。 */
  syncInfo: GloveSyncInfo | null;
  /** 写入进度（批量会话）。 */
  writeProgress: { written: number; total: number } | null;
  /** 操作ログ（タイムスタンプ付き文字列）。直近50件のみ保持する。 */
  logs: string[];
  /** 接続成功時に呼ぶ。deviceName/characteristic/notifyCharacteristic を設定する。 */
  setGloveConnected: (
    deviceName: string,
    characteristic: BluetoothRemoteGATTCharacteristic,
    notifyCharacteristic: BluetoothRemoteGATTCharacteristic
  ) => void;
  /** 切断完了後に呼ぶ。状態をクリアする。 */
  setGloveDisconnected: () => void;
  /** 从机链路状态更新。 */
  setSlaveLinkAlive: (alive: boolean) => void;
  /** 校时结果更新。 */
  setSyncInfo: (info: GloveSyncInfo) => void;
  /** 写入进度更新。 */
  setWriteProgress: (progress: { written: number; total: number } | null) => void;
  /** ログを1件追加する。直近50件のみ保持し古いものは破棄する。 */
  addGloveLog: (message: string) => void;
}

/** ログの保持上限（直近50件）。 */
const MAX_LOGS = 50;

export const createGloveSlice: StateCreator<GloveSlice> = (set) => ({
  isConnected: false,
  deviceName: null,
  characteristic: null,
  notifyCharacteristic: null,
  slaveLinkAlive: true,
  syncInfo: null,
  writeProgress: null,
  logs: [],
  setGloveConnected: (deviceName, characteristic, notifyCharacteristic) =>
    set({
      isConnected: true,
      deviceName,
      characteristic,
      notifyCharacteristic,
      slaveLinkAlive: true,
    }),
  setGloveDisconnected: () =>
    set({
      isConnected: false,
      deviceName: null,
      characteristic: null,
      notifyCharacteristic: null,
      slaveLinkAlive: true,
      writeProgress: null,
    }),
  setSlaveLinkAlive: (alive) => set({ slaveLinkAlive: alive }),
  setSyncInfo: (info) => set({ syncInfo: info }),
  setWriteProgress: (progress) => set({ writeProgress: progress }),
  addGloveLog: (message) =>
    set((state) => {
      const next = [...state.logs, message];
      return { logs: next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next };
    }),
});
