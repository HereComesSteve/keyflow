import React, { useEffect, useRef, useState } from 'react';
import { usePracticeStore } from '../../store';
import { gloveController, GloveScanTimeoutError } from '../../lib/bluetooth/GloveController';
import { convertScoreToGloveCommands } from '../../lib/glove/ScoreConverter';
import {
  PLAYBACK_COMMANDS,
  MODE_COMMANDS,
  TARGET_COMMANDS,
  eepromPlayCommand,
  toHexString,
  EEPROM_PARTITION_MIN,
  EEPROM_PARTITION_MAX,
  SRAM_CLEAR_COMMAND,
  SCORE_END_MARKER,
  MAX_SRAM_COMMANDS,
  buildScoreCommand,
  eepromClearCommand,
  eepromWriteInitCommand,
  parseScoreInput,
  buildBpmCommand,
  buildTimeSignatureCommand,
  TIME_SIGNATURE_OPTIONS,
  BPM_MIN,
  BPM_MAX,
  buildIntensityCommand,
  INTENSITY_MIN,
  INTENSITY_MAX,
  INTENSITY_FINGER_MIN,
  INTENSITY_FINGER_MAX,
  buildJumpBarCommand,
  JUMP_BAR_MIN,
  JUMP_BAR_MAX,
} from '../../lib/bluetooth/glove-commands';
import { useTranslation } from '../../lib/i18n/useTranslation';
import { formatMessage } from '../../lib/i18n/format';
import type { BluetoothDeviceInfo } from '../../types/electron-api';
import type { Annotation } from '../../types';
import { GloveIcon } from '../icons/GloveIcon';
import './GloveControlPanel.css';

export interface GloveControlPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** 指法标注数据(与音符通过 noteId 关联),由 App.tsx 的 keyboardAnnotations 传入。 */
  annotations: Annotation[];
}

/**
 * HH:MM:SS 形式のタイムスタンプ文字列を返す（ログ行の先頭に付ける）。
 * 1桁の値は0埋めする。
 */
function formatTimestamp(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** 日志行着色：指令发送行(→)高亮为青色，含警告标记(⚠️)的行高亮为琥珀色。 */
function logLineClass(line: string): string {
  if (line.includes('⚠️')) return 'glove-log__line--warn';
  if (line.includes('→')) return 'glove-log__line--cmd';
  return '';
}

/* ---------- 图标（内联 SVG,继承 currentColor） ---------- */

interface IconProps {
  size?: number;
}

const PlayIcon = ({ size = 16 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M8 5.14v13.72c0 .8.87 1.3 1.56.9l11.03-6.86a1.05 1.05 0 0 0 0-1.8L9.56 4.24A1.05 1.05 0 0 0 8 5.14Z" />
  </svg>
);

const PauseIcon = ({ size = 16 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
  </svg>
);

const StopIcon = ({ size = 16 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />
  </svg>
);

const ResetIcon = ({ size = 16 }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3 12a9 9 0 1 0 2.64-6.36" />
    <path d="M21 3v6h-6" />
  </svg>
);

const ChipIcon = ({ size = 16 }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="5" y="5" width="14" height="14" rx="2" />
    <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
  </svg>
);

const DatabaseIcon = ({ size = 16 }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    aria-hidden="true"
  >
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
    <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
  </svg>
);

const TrashIcon = ({ size = 16 }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3 6h18" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M10 11v6M14 11v6" />
  </svg>
);

/**
 * Bluetooth手套（左手套・マスター）接続用のモーダルダイアログ（ルーティング不要）。
 *
 * 通信トポロジーの制約上、PCは左手套のみと接続する。本パネルは左手套1台分の
 * 接続・切断・状態表示・ログ表示を担う。接続状態・ログはglove-slice（Zustand）で
 * 管理し、実際のBluetooth通信処理はGloveControllerが担う。
 *
 * スタイルは既存のSettingsModal/AboutModalと同一のライトテーマ（白背景・濃色文字）
 * で統一する。Escapeキーで閉じる（AboutModalと同じパターン）。
 */
export const GloveControlPanel: React.FC<GloveControlPanelProps> = ({
  isOpen,
  onClose,
  annotations,
}) => {
  const t = useTranslation();
  const isConnected = usePracticeStore((s) => s.isConnected);
  const deviceName = usePracticeStore((s) => s.deviceName);
  const characteristic = usePracticeStore((s) => s.characteristic);
  const logs = usePracticeStore((s) => s.logs);
  const setGloveConnected = usePracticeStore((s) => s.setGloveConnected);
  const setGloveDisconnected = usePracticeStore((s) => s.setGloveDisconnected);
  const addGloveLog = usePracticeStore((s) => s.addGloveLog);
  const score = usePracticeStore((s) => s.score);

  const logContainerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  // 連打防止: 接続/切断処理中フラグ
  const isBusyRef = useRef(false);
  // スキャン中の発見デバイス一覧（主プロセスからIPCで受信）。ユーザーが選択するまで保持。
  const [isScanning, setIsScanning] = useState(false);
  const [availableDevices, setAvailableDevices] = useState<BluetoothDeviceInfo[]>([]);
  // bluetooth:devices-updated 購読解除関数（connect終了/パネル閉鎖時に呼ぶ）
  const unsubscribeDevicesRef = useRef<(() => void) | null>(null);

  // 硬件控制状态：模式（单手/双手）、目标设备（左/右）、EEPROM 分区。
  // 这些是 UI 对已发送指令的镜像，发送成功后才更新。
  const [mode, setMode] = useState<'single' | 'dual'>('single');
  const [target, setTarget] = useState<'left' | 'right'>('left');
  const [partition, setPartition] = useState(0);
  // 指令发送中：短暂禁用所有控制按钮（视觉反馈 + 防止并发）。
  const [sending, setSending] = useState(false);

  // 乐谱写入状态：存储介质、分区、输入文本、状态文字、写入中标志。
  // 目标设备复用上面的 target 状态（与模式设置区目标按钮同步）。
  const [writeStorage, setWriteStorage] = useState<'sram' | 'eeprom'>('sram');
  const [writePartition, setWritePartition] = useState(0);
  const [scoreInput, setScoreInput] = useState('');
  // 发送范围：用户输入的小节范围（如 "1-3, 5-7, 9"），留空=全部小节
  const [rangeInput, setRangeInput] = useState('');
  const [writeStatus, setWriteStatus] = useState('');
  const [isWriting, setIsWriting] = useState(false);
  // 写入进度（进度条显示用），null 表示未在写入。
  const [writeProgress, setWriteProgress] = useState<{ current: number; total: number } | null>(
    null
  );
  // 取消标志：写入循环每次迭代检查，true 时立即退出。
  const shouldCancelRef = useRef(false);

  // BPM 设置：输入框文本、上次成功设置的值、范围错误提示。
  const [bpmInput, setBpmInput] = useState('120');
  const [bpmValue, setBpmValue] = useState(120);
  const [bpmStatus, setBpmStatus] = useState('');

  // 拍号设置：当前选择与上次成功设置的值（label 字符串）。
  const [timeSignature, setTimeSignature] = useState('4/4');
  const [timeSignatureValue, setTimeSignatureValue] = useState('4/4');

  // 马达强度设置：手指 1~5、强度输入、错误提示。目标设备复用上面的 target 状态
  // （强度区的左右手按钮与模式/写入区的目标按钮共用 handleTargetLeft/Right）。
  const [strengthFinger, setStrengthFinger] = useState(INTENSITY_FINGER_MIN);
  const [intensityInput, setIntensityInput] = useState('128');
  const [intensityStatus, setIntensityStatus] = useState('');

  // 小节跳转：小节号输入（1 基）、错误提示。目标设备同样复用 target 状态。
  const [jumpBarInput, setJumpBarInput] = useState('1');
  const [jumpStatus, setJumpStatus] = useState('');

  // 清除乐谱：目标存储、分区、确认弹窗开关。
  const [clearTarget, setClearTarget] = useState<'sram' | 'eeprom'>('sram');
  const [clearPartition, setClearPartition] = useState(0);
  const [confirmingClear, setConfirmingClear] = useState(false);

  // 指法数据传入验证(数据通路打通后可移除)。
  useEffect(() => {
    if (annotations.length > 0) {
      console.log('GloveControlPanel received annotations:', annotations);
    }
  }, [annotations]);

  // Escapeキーで閉じる（AboutModalと同じ購読パターン）。開いた際はダイアログへ
  // フォーカスを移し、閉じた際は元の要素へ復帰する。
  useEffect(() => {
    if (!isOpen) {
      // パネル閉鎖時: スキャン中ならキャンセルし購読解除（残留requestDeviceをreject）
      unsubscribeDevicesRef.current?.();
      unsubscribeDevicesRef.current = null;
      if (isBusyRef.current) {
        window.electronAPI.bluetooth?.cancelSelect();
      }
      return undefined;
    }

    previouslyFocusedElementRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocusedElementRef.current?.focus();
    };
  }, [isOpen, onClose]);

  // ログ更新時に最下行へ自動スクロールする（REQ: 最新ログを常に表示）。
  useEffect(() => {
    const container = logContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [logs]);

  if (!isOpen) return null;

  // 「接続」ボタンクリック時の処理。
  // 主プロセスの発見デバイス一覧を購読しつつ GloveController.connect（requestDevice）を
  // 呼ぶ。 requestDevice はユーザーが一覧からデバイスを選択するまで解決しない。
  // 選択/キャンセルは handlePickDevice / handleCancelScan からIPCで主プロセスへ通知。
  const handleConnect = async (): Promise<void> => {
    if (isBusyRef.current || isConnected) return;
    isBusyRef.current = true;
    setIsScanning(true);
    setAvailableDevices([]);
    addGloveLog(`[${formatTimestamp(new Date())}] ${t.glove.logScanning}`);

    // requestDevice 呼出前に購読を登録（主プロセスからの発見デバイス一覧を受信）
    unsubscribeDevicesRef.current =
      window.electronAPI.bluetooth?.onDevicesUpdated((devices) => {
        setAvailableDevices(devices);
      }) ?? null;

    try {
      const result = await gloveController.connect();
      setGloveConnected(result.deviceName, result.characteristic);
      addGloveLog(
        `[${formatTimestamp(new Date())}] ${formatMessage(t.glove.logConnected, { device: result.deviceName })}`
      );
    } catch (error) {
      if (!navigator.bluetooth) {
        addGloveLog(`[${formatTimestamp(new Date())}] ${t.glove.logUnavailable}`);
      } else if (error instanceof GloveScanTimeoutError) {
        addGloveLog(`[${formatTimestamp(new Date())}] ${t.glove.logScanTimeout}`);
      } else if (error instanceof DOMException && error.name === 'NotFoundError') {
        addGloveLog(`[${formatTimestamp(new Date())}] ${t.glove.logCancelled}`);
      } else {
        const msg = error instanceof Error ? error.message : String(error);
        addGloveLog(
          `[${formatTimestamp(new Date())}] ${formatMessage(t.glove.logConnectError, { error: msg })}`
        );
      }
    } finally {
      unsubscribeDevicesRef.current?.();
      unsubscribeDevicesRef.current = null;
      setAvailableDevices([]);
      setIsScanning(false);
      isBusyRef.current = false;
    }
  };

  // ユーザーが一覧からデバイスを選択: 主プロセスへdeviceIdを送りrequestDeviceを解決させる。
  const handlePickDevice = (deviceId: string): void => {
    window.electronAPI.bluetooth?.selectDevice(deviceId);
  };

  // スキャンキャンセル: 主プロセスへ空文字を送らせrequestDeviceをNotFoundErrorでreject。
  const handleCancelScan = (): void => {
    window.electronAPI.bluetooth?.cancelSelect();
  };

  // 「切断」ボタンクリック時の処理。
  // GloveController.disconnect → 状態クリア → 切断ログ。切断自体は同期的だが
  // 念のためtry-catchで囲む（REQ: 全Bluetooth操作にtry-catch）。
  const handleDisconnect = (): void => {
    if (isBusyRef.current) return;
    isBusyRef.current = true;
    try {
      gloveController.disconnect(characteristic);
      setGloveDisconnected();
      addGloveLog(`[${formatTimestamp(new Date())}] ${t.glove.logDisconnected}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      addGloveLog(
        `[${formatTimestamp(new Date())}] ${formatMessage(t.glove.logDisconnectError, { error: msg })}`
      );
    } finally {
      isBusyRef.current = false;
    }
  };

  // 通用指令发送：检查连接 → writeValue → 记录日志。返回是否发送成功。
  // 未连接时记录"请先连接手套"；发送中短暂禁用按钮（视觉反馈）。
  const sendCommand = async (bytes: number[], description: string): Promise<boolean> => {
    if (!characteristic) {
      addGloveLog(`[${formatTimestamp(new Date())}] ${t.glove.logNotConnected}`);
      return false;
    }
    setSending(true);
    try {
      await gloveController.sendCommand(characteristic, new Uint8Array(bytes));
      addGloveLog(
        `[${formatTimestamp(new Date())}] ${formatMessage(t.glove.logSent, {
          cmd: toHexString(bytes),
          desc: description,
        })}`
      );
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      addGloveLog(
        `[${formatTimestamp(new Date())}] ${formatMessage(t.glove.logSendError, { error: msg })}`
      );
      return false;
    } finally {
      setSending(false);
    }
  };

  // 播放控制
  const handleSramPlay = (): Promise<void> =>
    sendCommand(PLAYBACK_COMMANDS.sramPlay, t.glove.sramPlay).then(() => undefined);
  const handleEepromPlay = (): Promise<void> =>
    sendCommand(eepromPlayCommand(partition), t.glove.eepromPlay).then(() => undefined);
  const handleStop = (): Promise<void> =>
    sendCommand(PLAYBACK_COMMANDS.stop, t.glove.stop).then(() => undefined);
  const handlePause = (): Promise<void> =>
    sendCommand(PLAYBACK_COMMANDS.pause, t.glove.pause).then(() => undefined);
  const handleResume = (): Promise<void> =>
    sendCommand(PLAYBACK_COMMANDS.resume, t.glove.resume).then(() => undefined);
  const handleReset = (): Promise<void> =>
    sendCommand(PLAYBACK_COMMANDS.reset, t.glove.reset).then(() => undefined);

  // 模式切换：发送成功后才更新 UI（保证 UI 与硬件状态一致）
  const handleSingleHand = (): Promise<void> =>
    sendCommand(MODE_COMMANDS.singleHand, t.glove.singleHand).then((ok) => {
      if (ok) setMode('single');
    });
  const handleDualHand = (): Promise<void> =>
    sendCommand(MODE_COMMANDS.dualHand, t.glove.dualHand).then((ok) => {
      if (ok) setMode('dual');
    });

  // 目标设备切换
  const handleTargetLeft = (): Promise<void> =>
    sendCommand(TARGET_COMMANDS.left, t.glove.targetLeft).then((ok) => {
      if (ok) setTarget('left');
    });
  const handleTargetRight = (): Promise<void> =>
    sendCommand(TARGET_COMMANDS.right, t.glove.targetRight).then((ok) => {
      if (ok) setTarget('right');
    });

  // 乐谱输入实时预览：解析当前文本域内容，统计指令条数。
  const scorePreview = parseScoreInput(scoreInput);
  const scoreCommandCount = scorePreview.ok ? scorePreview.pairs.length : 0;

  // 乐谱写入完整流程：检查连接 → 解析 → 设置目标 → 初始化存储 → 逐条发送 → 结束标志。
  // 任意一步失败则中止并记录错误。全程 isWriting=true 禁用所有控制按钮。
  const handleWriteScore = async (): Promise<void> => {
    const ts = () => formatTimestamp(new Date());

    if (!characteristic) {
      setWriteStatus(t.glove.logNotConnected);
      addGloveLog(`[${ts()}] ${t.glove.logNotConnected}`);
      return;
    }

    const parsed = parseScoreInput(scoreInput);
    if (!parsed.ok) {
      const msg =
        parsed.reason === 'empty'
          ? t.glove.errEmpty
          : parsed.reason === 'odd'
            ? t.glove.errOddBytes
            : formatMessage(t.glove.errInvalidHex, { value: parsed.invalidToken ?? '' });
      setWriteStatus(msg);
      addGloveLog(`[${ts()}] ${msg}`);
      return;
    }

    // SRAM 容量硬限制：超过 32 条直接终止，不让用户误以为能写全部。
    if (writeStorage === 'sram' && parsed.pairs.length > MAX_SRAM_COMMANDS) {
      const msg = formatMessage(t.glove.errSramOverflow, { count: parsed.pairs.length });
      setWriteStatus(msg);
      addGloveLog(`[${ts()}] ${msg}`);
      return;
    }

    // 重置取消标志，记录开始时间
    shouldCancelRef.current = false;
    const startTime = Date.now();
    setIsWriting(true);
    setWriteProgress({ current: 0, total: parsed.pairs.length });
    const targetLabel = target === 'left' ? t.glove.targetLeft : t.glove.targetRight;
    const storageLabel = writeStorage === 'sram' ? t.glove.sram : t.glove.eeprom;
    addGloveLog(
      `[${ts()}] ${formatMessage(t.glove.logWriteStart, { target: targetLabel, storage: storageLabel })}`
    );

    let sentCount = 0;
    let cancelled = false;
    try {
      // 步骤3: 设置目标设备（必发，确保乐谱写入正确的目标）
      const targetCmd = target === 'left' ? TARGET_COMMANDS.left : TARGET_COMMANDS.right;
      await gloveController.sendCommand(characteristic, new Uint8Array(targetCmd));
      sentCount++;
      addGloveLog(
        `[${ts()}] → ${toHexString(targetCmd)} (${target === 'left' ? t.glove.logWriteTargetLeft : t.glove.logWriteTargetRight})`
      );

      // 步骤4: 初始化目标存储区域
      if (writeStorage === 'sram') {
        await gloveController.sendCommand(characteristic, new Uint8Array(SRAM_CLEAR_COMMAND));
        sentCount++;
        addGloveLog(`[${ts()}] → ${toHexString(SRAM_CLEAR_COMMAND)} (${t.glove.logWriteClearSram})`);
      } else {
        const clearCmd = eepromClearCommand(writePartition);
        await gloveController.sendCommand(characteristic, new Uint8Array(clearCmd));
        sentCount++;
        addGloveLog(
          `[${ts()}] → ${toHexString(clearCmd)} (${formatMessage(t.glove.logWriteClearEeprom, { partition: writePartition })})`
        );
        const initCmd = eepromWriteInitCommand(writePartition);
        await gloveController.sendCommand(characteristic, new Uint8Array(initCmd));
        sentCount++;
        addGloveLog(
          `[${ts()}] → ${toHexString(initCmd)} (${formatMessage(t.glove.logWriteInitEeprom, { partition: writePartition })})`
        );
      }

      // 步骤5: 逐条发送乐谱数据（controller 内部 5ms 节流）
      const total = parsed.pairs.length;
      // 诊断日志：打印每条指令的发送时间戳，便于验证实际间隔
      console.log(`[乐谱写入] 开始发送 ${total} 条指令，startTime=${startTime}`);
      let prevSendTime = Date.now();
      for (let i = 0; i < total; i++) {
        // 检查取消标志
        if (shouldCancelRef.current) {
          cancelled = true;
          console.log(`[乐谱写入] 用户取消，已发送 ${i}/${total} 条`);
          break;
        }

        const [tick, motor] = parsed.pairs[i];
        const cmd = buildScoreCommand(tick, motor);
        await gloveController.sendCommand(characteristic, new Uint8Array(cmd));
        sentCount++;

        // 诊断日志：每条指令的发送时间戳和间隔
        const now = Date.now();
        const interval = now - prevSendTime;
        console.log(`[乐谱写入] #${i + 1}/${total} ${toHexString(cmd)} t=${now} interval=${interval}ms`);
        prevSendTime = now;

        // UI 更新：每 20 条或最后一条更新一次状态（减少 React 重渲染开销）
        if (i % 20 === 0 || i === total - 1) {
          setWriteStatus(formatMessage(t.glove.writingProgress, { current: i + 1, total }));
          setWriteProgress({ current: i + 1, total });
        }
      }

      if (!cancelled) {
        // 步骤6: 发送结束标志 FB FF 00 04
        await gloveController.sendCommand(characteristic, new Uint8Array(SCORE_END_MARKER));
        sentCount++;
        addGloveLog(`[${ts()}] → ${toHexString(SCORE_END_MARKER)} (${t.glove.logWriteEnd})`);

        // 步骤7: 显示完成状态
        const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);
        const completeMsg = formatMessage(t.glove.logWriteComplete, { count: sentCount });
        const timeMsg = formatMessage(t.glove.logWriteTotalTime, { seconds: elapsedSec });
        setWriteStatus(`${completeMsg} (${timeMsg})`);
        addGloveLog(`[${ts()}] ${completeMsg} ${timeMsg}`);
        console.log(`[乐谱写入] 写入完成，总耗时: ${(Date.now() - startTime) / 1000}s，共 ${sentCount} 条`);
      } else {
        // 取消后：清空输入数据，不残留未发送指令
        setScoreInput('');
        const cancelMsg = formatMessage(t.glove.logWriteCancelled, { sent: sentCount, total: parsed.pairs.length });
        setWriteStatus(cancelMsg);
        addGloveLog(`[${ts()}] ${cancelMsg}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const errMsg = formatMessage(t.glove.logWriteError, { error: msg });
      setWriteStatus(errMsg);
      addGloveLog(`[${ts()}] ${errMsg}`);
    } finally {
      setIsWriting(false);
      setWriteProgress(null);
      shouldCancelRef.current = false;
    }
  };

  // 取消写入：设置标志位，发送循环下次迭代时检测到并退出。
  const handleCancelWrite = (): void => {
    shouldCancelRef.current = true;
  };

  // BPM 设置：校验 1~300 → 发送 FA [高8] [低8] 00 → 成功后更新当前值。
  const handleSetBpm = async (): Promise<void> => {
    const bpm = Number(bpmInput);
    if (!Number.isFinite(bpm) || bpm < BPM_MIN || bpm > BPM_MAX) {
      setBpmStatus(t.glove.bpmRangeError);
      addGloveLog(`[${formatTimestamp(new Date())}] ${t.glove.bpmRangeError}`);
      return;
    }
    setBpmStatus('');
    const desc = formatMessage(t.glove.logSetBpm, { value: bpm });
    if (await sendCommand(buildBpmCommand(bpm), desc)) {
      setBpmValue(bpm);
    }
  };

  // 拍号设置：只发送 F9 21 [beats<<4] 00，分母不参与编码。成功后更新当前值。
  const handleSetTimeSignature = async (): Promise<void> => {
    const option = TIME_SIGNATURE_OPTIONS.find((o) => o.label === timeSignature);
    const beats = option?.beats ?? 4;
    const desc = formatMessage(t.glove.logSetTimeSignature, { value: timeSignature });
    if (await sendCommand(buildTimeSignatureCommand(beats), desc)) {
      setTimeSignatureValue(timeSignature);
    }
  };

  // 校验强度输入（1~255），失败时记录错误并返回 null。
  const parseIntensity = (): number | null => {
    const intensity = Number(intensityInput);
    if (!Number.isFinite(intensity) || intensity < INTENSITY_MIN || intensity > INTENSITY_MAX) {
      setIntensityStatus(t.glove.intensityRangeError);
      addGloveLog(`[${formatTimestamp(new Date())}] ${t.glove.intensityRangeError}`);
      return null;
    }
    setIntensityStatus('');
    return intensity;
  };

  // 组装并发送强度指令 F9 25 [引脚索引] [强度]（固定 4 字节、无 XOR 校验）。
  const sendIntensity = (finger: number, intensity: number): Promise<boolean> => {
    const handLabel = target === 'left' ? t.glove.targetLeft : t.glove.targetRight;
    const desc = formatMessage(t.glove.logSetIntensity, {
      finger,
      value: intensity,
      hand: handLabel,
    });
    return sendCommand(buildIntensityCommand(finger, intensity), desc);
  };

  // 发送前先发目标指令 F9 24（决定左手本地执行 / 右手由左手转发）。目标与
  // 模式/写入区共用 target 状态，强度区的左右手按钮即 handleTargetLeft/Right。
  const ensureIntensityTarget = async (): Promise<boolean> => {
    const targetCmd = target === 'left' ? TARGET_COMMANDS.left : TARGET_COMMANDS.right;
    const targetDesc =
      target === 'left' ? t.glove.logWriteTargetLeft : t.glove.logWriteTargetRight;
    return sendCommand(targetCmd, targetDesc);
  };

  // 单指强度：目标 + F9 25。成功即代表硬件已收到（无确认回包）。
  const handleSendIntensity = async (): Promise<void> => {
    const intensity = parseIntensity();
    if (intensity === null) return;
    if (!(await ensureIntensityTarget())) return;
    await sendIntensity(strengthFinger, intensity);
  };

  // 一键发送：目标 + 五根手指各一条 F9 25，全部设为输入框中的强度。
  const handleSendAllIntensity = async (): Promise<void> => {
    const intensity = parseIntensity();
    if (intensity === null) return;
    if (!(await ensureIntensityTarget())) return;
    for (let finger = INTENSITY_FINGER_MIN; finger <= INTENSITY_FINGER_MAX; finger++) {
      if (!(await sendIntensity(finger, intensity))) return;
    }
  };

  // 小节跳转：校验 1~255 → 发送前先设目标 F9 24 → 发 F9 26 [小节号] 00。
  // 与强度区共用 ensureIntensityTarget（目标设备指令 F9 24 对所有指令通用）。
  const handleJumpBar = async (): Promise<void> => {
    const bar = Number(jumpBarInput);
    if (!Number.isFinite(bar) || bar < JUMP_BAR_MIN || bar > JUMP_BAR_MAX) {
      setJumpStatus(t.glove.jumpRangeError);
      addGloveLog(`[${formatTimestamp(new Date())}] ${t.glove.jumpRangeError}`);
      return;
    }
    setJumpStatus('');
    if (!(await ensureIntensityTarget())) return;
    const handLabel = target === 'left' ? t.glove.targetLeft : t.glove.targetRight;
    const desc = formatMessage(t.glove.logJumpBar, { value: bar, hand: handLabel });
    await sendCommand(buildJumpBarCommand(bar), desc);
  };

  // 清除乐谱：先检查连接，再弹窗二次确认，确认后发送清除指令。
  const handleClearRequest = (): void => {
    if (!characteristic) {
      addGloveLog(`[${formatTimestamp(new Date())}] ${t.glove.logNotConnected}`);
      return;
    }
    setConfirmingClear(true);
  };

  const handleConfirmClear = async (): Promise<void> => {
    setConfirmingClear(false);
    const cmd = clearTarget === 'sram' ? SRAM_CLEAR_COMMAND : eepromClearCommand(clearPartition);
    const desc =
      clearTarget === 'sram'
        ? t.glove.logWriteClearSram
        : formatMessage(t.glove.logWriteClearEeprom, { partition: clearPartition });
    await sendCommand(cmd, desc);
  };

  const handleCancelClear = (): void => {
    setConfirmingClear(false);
  };

  // 从当前乐谱导入：调用 ScoreConverter 生成手套指令并填入文本域。
  // 优先级检查：乐谱 → 指法 → 目标手音符 → SRAM 容量。
  const handleImportFromScore = (): void => {
    const ts = () => formatTimestamp(new Date());

    if (!score || score.measures.length === 0) {
      setWriteStatus(t.glove.noScoreLoaded);
      addGloveLog(`[${ts()}] ${t.glove.noScoreLoaded}`);
      return;
    }

    if (annotations.length === 0) {
      setWriteStatus(t.glove.noFingeringData);
      addGloveLog(`[${ts()}] ${t.glove.noFingeringData}`);
      return;
    }

    // 检查目标手是否有指法数据
    const hasTargetHandNotes = annotations.some((a) => {
      if (a.fingerNumber === undefined) return false;
      // 找到对应 note，检查 hand 属性
      for (const m of score.measures) {
        for (const n of m.notes) {
          if (n.id === a.noteId && n.hand === target && !n.isRest) {
            return true;
          }
        }
      }
      return false;
    });

    if (!hasTargetHandNotes) {
      const handLabel = target === 'left' ? t.glove.targetLeft : t.glove.targetRight;
      const msg = formatMessage(t.glove.noNotesForHand, { hand: handLabel });
      setWriteStatus(msg);
      addGloveLog(`[${ts()}] ${msg}`);
      return;
    }

    const result = convertScoreToGloveCommands(score, annotations, target, rangeInput);

    // 范围解析错误（parseRange 抛出异常时，result.warnings 含错误信息，noteCount=0）
    if (result.warnings.length > 0 && result.noteCount === 0 && result.data === 'FF 00') {
      const msg = result.warnings[0];
      setWriteStatus(msg);
      addGloveLog(`[${ts()}] ${msg}`);
      return;
    }

    if (result.noteCount === 0) {
      setWriteStatus(t.glove.noFingeringData);
      addGloveLog(`[${ts()}] ${t.glove.noFingeringData}`);
      return;
    }

    // SRAM 容量警告（仅 SRAM 存储时）
    if (writeStorage === 'sram' && result.instructionCount > MAX_SRAM_COMMANDS) {
      const msg = formatMessage(t.glove.sramCapacityWarning, { count: result.instructionCount });
      addGloveLog(`[${ts()}] ${msg}`);
      // 仍允许继续填入
    }

    // 填入文本域（保留空格分隔格式，parseScoreInput 兼容空格/换行）
    setScoreInput(result.data);

    // 更新状态
    const statusMsg = formatMessage(t.glove.importSuccess, {
      notes: result.noteCount,
      instructions: result.instructionCount,
    });
    setWriteStatus(statusMsg);
    addGloveLog(`[${ts()}] ${statusMsg}`);

    // 警告信息
    for (const w of result.warnings) {
      addGloveLog(`[${ts()}] ⚠️ ${w}`);
    }
  };

  // 硬件指令按钮的统一禁用条件：未连接、单条发送中或乐谱写入中。
  // 输入类控件（乐谱文本域、范围、存储选择等）仅受"忙碌中"影响，
  // 允许用户在未连接时先准备数据。
  const busy = sending || isWriting;
  const cmdDisabled = busy || !isConnected;
  // 未连接时给指令按钮提示"请先连接手套"。
  const connHint = !isConnected ? t.glove.logNotConnected : undefined;

  // EEPROM 分区选项（0~7），三处共用。
  const partitionOptions = Array.from(
    { length: EEPROM_PARTITION_MAX - EEPROM_PARTITION_MIN + 1 },
    (_, i) => EEPROM_PARTITION_MIN + i
  );

  // 写入进度百分比（进度条显示）。
  const writePercent = writeProgress
    ? Math.round((writeProgress.current / writeProgress.total) * 100)
    : 0;

  return (
    <div className="glove-overlay">
      <div
        ref={dialogRef}
        className="glove-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t.glove.dialogTitle}
        tabIndex={-1}
      >
        {/* Header */}
        <header className="glove-header">
          <div className="glove-header__brand">
            <span className="glove-header__icon" style={{ color: '#fff' }} aria-hidden="true">
              <GloveIcon size={18} strokeWidth={2} />
            </span>
            <span>{t.glove.dialogTitle}</span>
          </div>
          <div className="glove-header__spacer" />
          <span
            className={`glove-status-pill ${isConnected ? 'glove-status-pill--connected' : 'glove-status-pill--disconnected'}`}
          >
            {isConnected ? t.glove.statusConnected : t.glove.statusDisconnected}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.glove.closeButtonAriaLabel}
            className="glove-icon-btn"
          >
            <svg width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </header>

        {/* Content */}
        <div className="glove-body">
          {/* 连接卡片 */}
          <section className="glove-card">
            <div className="glove-connection">
              <div>
                <div className="glove-connection__title">
                  <span
                    className="glove-connection__emoji"
                    style={{ color: 'var(--gp-primary)' }}
                    aria-hidden="true"
                  >
                    <GloveIcon size={22} strokeWidth={1.8} />
                  </span>
                  <span>{t.glove.leftGloveLabel}</span>
                </div>
                <div className="glove-connection__sub">
                  <span
                    className={`glove-connection__dot ${isConnected ? 'glove-connection__dot--on' : 'glove-connection__dot--off'}`}
                    aria-hidden="true"
                  />
                  <span>
                    {isConnected ? (
                      <>
                        <span style={{ color: 'var(--gp-success)', fontWeight: 600 }}>
                          {t.glove.statusConnected}
                        </span>
                        {deviceName ? ` · ${deviceName}` : ''}
                      </>
                    ) : (
                      t.glove.statusDisconnected
                    )}
                  </span>
                </div>
              </div>
              <div className="glove-connection__actions">
                {isConnected ? (
                  <button
                    type="button"
                    onClick={handleDisconnect}
                    className="glove-btn glove-btn--danger"
                  >
                    {t.glove.disconnectButton}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleConnect}
                    disabled={isScanning}
                    className="glove-btn glove-btn--primary"
                  >
                    {isScanning && <span className="glove-spinner" aria-hidden="true" />}
                    {isScanning ? t.glove.logScanning : t.glove.connectButton}
                  </button>
                )}
              </div>
            </div>
            {!isConnected && (
              <div className="glove-hint" role="note">
                {t.glove.logNotConnected}
              </div>
            )}
          </section>

          {/* 扫描中：发现设备列表 */}
          {isScanning && (
            <section className="glove-card glove-scan">
              <div className="glove-scan__header">
                <span className="glove-spinner glove-spinner--dark" aria-hidden="true" />
                <span>{t.glove.scanPrompt}</span>
              </div>
              <div className="glove-hint">{t.glove.scanningHint}</div>
              {availableDevices.length === 0 ? (
                <div className="glove-hint" style={{ fontStyle: 'italic' }}>
                  {t.glove.noDevicesYet}
                </div>
              ) : (
                <div className="glove-scan__list">
                  {availableDevices.map((device) => (
                    <button
                      key={device.deviceId}
                      type="button"
                      onClick={() => handlePickDevice(device.deviceId)}
                      className="glove-scan__item"
                    >
                      <span aria-hidden="true">📶</span>
                      <span>{device.deviceName || device.deviceId}</span>
                    </button>
                  ))}
                </div>
              )}
              <div>
                <button
                  type="button"
                  onClick={handleCancelScan}
                  className="glove-btn glove-btn--sm"
                >
                  {t.glove.cancelScan}
                </button>
              </div>
            </section>
          )}

          {/* 模式 + 目标设备 */}
          <div className="glove-grid">
            <section className="glove-card">
              <div className="glove-section-label">
                <span className="glove-section-label__accent" aria-hidden="true" />
                {t.glove.modeSection}
              </div>
              <div className="glove-seg" role="group" aria-label={t.glove.modeSection}>
                <button
                  type="button"
                  onClick={handleSingleHand}
                  disabled={cmdDisabled}
                  title={cmdDisabled ? connHint : undefined}
                  className={`glove-seg__btn ${mode === 'single' ? 'glove-seg__btn--active' : ''}`}
                >
                  {t.glove.singleHand}
                </button>
                <button
                  type="button"
                  onClick={handleDualHand}
                  disabled={cmdDisabled}
                  title={cmdDisabled ? connHint : undefined}
                  className={`glove-seg__btn ${mode === 'dual' ? 'glove-seg__btn--active' : ''}`}
                >
                  {t.glove.dualHand}
                </button>
              </div>
            </section>

            <section className="glove-card">
              <div className="glove-section-label">
                <span className="glove-section-label__accent" aria-hidden="true" />
                {t.glove.targetSection}
              </div>
              <div className="glove-seg" role="group" aria-label={t.glove.targetSection}>
                <button
                  type="button"
                  onClick={handleTargetLeft}
                  disabled={cmdDisabled}
                  title={cmdDisabled ? connHint : undefined}
                  className={`glove-seg__btn ${target === 'left' ? 'glove-seg__btn--active' : ''}`}
                >
                  {t.glove.targetLeft}
                </button>
                <button
                  type="button"
                  onClick={handleTargetRight}
                  disabled={cmdDisabled}
                  title={cmdDisabled ? connHint : undefined}
                  className={`glove-seg__btn ${target === 'right' ? 'glove-seg__btn--active' : ''}`}
                >
                  {t.glove.targetRight}
                </button>
              </div>
              <div className="glove-hint">
                {target === 'left' ? t.glove.logWriteTargetLeft : t.glove.logWriteTargetRight}
              </div>
            </section>
          </div>

          {/* 播放控制 */}
          <section className="glove-card">
            <div className="glove-section-label">
              <span className="glove-section-label__accent" aria-hidden="true" />
              {t.glove.playbackSection}
            </div>
            <div className="glove-transport">
              <button
                type="button"
                onClick={handleSramPlay}
                disabled={cmdDisabled}
                title={cmdDisabled ? connHint : undefined}
                className="glove-btn glove-btn--primary"
              >
                <ChipIcon />
                {t.glove.sramPlay}
              </button>
              <button
                type="button"
                onClick={handleEepromPlay}
                disabled={cmdDisabled}
                title={cmdDisabled ? connHint : undefined}
                className="glove-btn glove-btn--primary"
              >
                <DatabaseIcon />
                {t.glove.eepromPlay}
              </button>
              <button
                type="button"
                onClick={handleStop}
                disabled={cmdDisabled}
                title={cmdDisabled ? connHint : undefined}
                className="glove-btn"
              >
                <StopIcon />
                {t.glove.stop}
              </button>
              <button
                type="button"
                onClick={handlePause}
                disabled={cmdDisabled}
                title={cmdDisabled ? connHint : undefined}
                className="glove-btn"
              >
                <PauseIcon />
                {t.glove.pause}
              </button>
              <button
                type="button"
                onClick={handleResume}
                disabled={cmdDisabled}
                title={cmdDisabled ? connHint : undefined}
                className="glove-btn"
              >
                <PlayIcon />
                {t.glove.resume}
              </button>
              <button
                type="button"
                onClick={handleReset}
                disabled={cmdDisabled}
                title={cmdDisabled ? connHint : undefined}
                className="glove-btn"
              >
                <ResetIcon />
                {t.glove.reset}
              </button>
            </div>
            <div className="glove-row">
              <label className="glove-hint" style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
                {t.glove.partitionLabel}
                <select
                  value={partition}
                  onChange={(e) => setPartition(Number(e.target.value))}
                  disabled={busy}
                  className="glove-select glove-select--num"
                >
                  {partitionOptions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>

          {/* BPM + 拍号 */}
          <div className="glove-grid">
            <section className="glove-card">
              <div className="glove-section-label">
                <span className="glove-section-label__accent" aria-hidden="true" />
                {t.glove.bpmSection}
              </div>
              <div className="glove-row">
                <input
                  type="number"
                  value={bpmInput}
                  onChange={(e) => setBpmInput(e.target.value)}
                  disabled={busy}
                  min={BPM_MIN}
                  max={BPM_MAX}
                  className="glove-input glove-input--num"
                />
                <button
                  type="button"
                  onClick={handleSetBpm}
                  disabled={cmdDisabled}
                  title={cmdDisabled ? connHint : undefined}
                  className="glove-btn glove-btn--sm"
                >
                  {t.glove.bpmSetButton}
                </button>
              </div>
              <div className="glove-hint">
                {formatMessage(t.glove.bpmCurrent, { value: bpmValue })}
                {bpmStatus && <span className="glove-error" style={{ marginLeft: '8px' }}>{bpmStatus}</span>}
              </div>
            </section>

            <section className="glove-card">
              <div className="glove-section-label">
                <span className="glove-section-label__accent" aria-hidden="true" />
                {t.glove.timeSignatureSection}
              </div>
              <div className="glove-row">
                <select
                  value={timeSignature}
                  onChange={(e) => setTimeSignature(e.target.value)}
                  disabled={busy}
                  className="glove-select"
                >
                  {TIME_SIGNATURE_OPTIONS.map((opt) => (
                    <option key={opt.label} value={opt.label}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleSetTimeSignature}
                  disabled={cmdDisabled}
                  title={cmdDisabled ? connHint : undefined}
                  className="glove-btn glove-btn--sm"
                >
                  {t.glove.timeSignatureSetButton}
                </button>
              </div>
              <div className="glove-hint">
                {formatMessage(t.glove.timeSignatureCurrent, { value: timeSignatureValue })}
              </div>
            </section>
          </div>

          {/* 乐谱写入 */}
          <section className="glove-card">
            <div className="glove-section-label">
              <span className="glove-section-label__accent" aria-hidden="true" />
              {t.glove.writeSection}
              <span className="glove-badge">
                {formatMessage(t.glove.statCommands, { count: scoreCommandCount })}
              </span>
            </div>

            {/* 存储介质（SRAM / EEPROM），EEPROM 时显示分区选择器 */}
            <div className="glove-row">
              <span className="glove-hint">{t.glove.writeStorageLabel}</span>
              <div className="glove-seg" role="group" aria-label={t.glove.writeStorageLabel}>
                <button
                  type="button"
                  onClick={() => setWriteStorage('sram')}
                  disabled={busy}
                  className={`glove-seg__btn ${writeStorage === 'sram' ? 'glove-seg__btn--active' : ''}`}
                >
                  {t.glove.sram}
                </button>
                <button
                  type="button"
                  onClick={() => setWriteStorage('eeprom')}
                  disabled={busy}
                  className={`glove-seg__btn ${writeStorage === 'eeprom' ? 'glove-seg__btn--active' : ''}`}
                >
                  {t.glove.eeprom}
                </button>
              </div>
              {writeStorage === 'eeprom' && (
                <label className="glove-hint" style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
                  {t.glove.partitionLabel}
                  <select
                    value={writePartition}
                    onChange={(e) => setWritePartition(Number(e.target.value))}
                    disabled={busy}
                    className="glove-select glove-select--num"
                  >
                    {partitionOptions.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            {/* 从当前乐谱导入 + 发送范围 */}
            <div className="glove-import">
              <div className="glove-row">
                <label className="glove-hint" style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
                  {t.glove.rangeLabel}
                  <input
                    type="text"
                    value={rangeInput}
                    onChange={(e) => setRangeInput(e.target.value)}
                    disabled={busy}
                    placeholder={t.glove.rangePlaceholder}
                    className="glove-input"
                    style={{ width: '170px' }}
                  />
                </label>
                <button
                  type="button"
                  onClick={handleImportFromScore}
                  disabled={busy}
                  className="glove-btn glove-btn--sm"
                >
                  📋 {t.glove.importFromScore}
                </button>
              </div>
              <span className="glove-hint">{t.glove.rangeHint}</span>
            </div>

            {/* 乐谱数据文本域 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span className="glove-hint">{t.glove.scoreDataLabel}</span>
              <textarea
                value={scoreInput}
                onChange={(e) => setScoreInput(e.target.value)}
                placeholder={t.glove.scoreDataPlaceholder}
                disabled={isWriting}
                spellCheck={false}
                className="glove-textarea"
              />
              <span className="glove-hint" style={{ color: 'var(--gp-text-4)' }}>
                {formatMessage(t.glove.statCommands, { count: scoreCommandCount })}
                {writeStorage === 'sram' && ` · ${t.glove.sramCapacityHint}`}
                {writeStorage === 'eeprom' && ` · ${t.glove.eepromCapacityHint}`}
              </span>
            </div>

            {/* 写入进度条 */}
            {isWriting && writeProgress && (
              <div className="glove-progress">
                <div className="glove-progress__bar" role="progressbar" aria-valuenow={writePercent} aria-valuemin={0} aria-valuemax={100}>
                  <div className="glove-progress__fill" style={{ width: `${writePercent}%` }} />
                </div>
                <div className="glove-progress__label">
                  <span>
                    {formatMessage(t.glove.writingProgress, {
                      current: writeProgress.current,
                      total: writeProgress.total,
                    })}
                  </span>
                  <span>{writePercent}%</span>
                </div>
              </div>
            )}

            {/* 写入按钮 + 取消按钮 + 状态提示 */}
            <div className="glove-row">
              <button
                type="button"
                onClick={handleWriteScore}
                disabled={cmdDisabled}
                title={cmdDisabled ? connHint : undefined}
                className="glove-btn glove-btn--primary"
              >
                {isWriting && <span className="glove-spinner" aria-hidden="true" />}
                {isWriting ? t.glove.writingButton : t.glove.writeButton}
              </button>
              {isWriting && (
                <button
                  type="button"
                  onClick={handleCancelWrite}
                  className="glove-btn glove-btn--solid-danger"
                >
                  {t.glove.cancelWriteButton}
                </button>
              )}
              {writeStatus && <span className="glove-status-text">{writeStatus}</span>}
            </div>
          </section>

          {/* 马达强度 + 小节跳转 */}
          <div className="glove-grid">
            <section className="glove-card">
              <div className="glove-section-label">
                <span className="glove-section-label__accent" aria-hidden="true" />
                {t.glove.intensitySection}
              </div>
              <div className="glove-row">
                <select
                  value={strengthFinger}
                  onChange={(e) => setStrengthFinger(Number(e.target.value))}
                  disabled={busy}
                  aria-label={t.glove.intensityFingerLabel}
                  className="glove-select glove-select--num"
                >
                  {Array.from(
                    { length: INTENSITY_FINGER_MAX - INTENSITY_FINGER_MIN + 1 },
                    (_, i) => INTENSITY_FINGER_MIN + i
                  ).map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  value={intensityInput}
                  onChange={(e) => setIntensityInput(e.target.value)}
                  disabled={busy}
                  min={INTENSITY_MIN}
                  max={INTENSITY_MAX}
                  aria-label={t.glove.intensityValueLabel}
                  className="glove-input glove-input--num"
                />
                <button
                  type="button"
                  onClick={handleSendIntensity}
                  disabled={cmdDisabled}
                  title={cmdDisabled ? connHint : undefined}
                  className="glove-btn glove-btn--sm"
                >
                  {t.glove.intensitySendButton}
                </button>
                <button
                  type="button"
                  onClick={handleSendAllIntensity}
                  disabled={cmdDisabled}
                  title={cmdDisabled ? connHint : undefined}
                  className="glove-btn glove-btn--violet glove-btn--sm"
                >
                  {t.glove.intensitySendAllButton}
                </button>
              </div>
              {intensityStatus && <div className="glove-error">{intensityStatus}</div>}
              <div className="glove-hint">{t.glove.intensityHint}</div>
            </section>

            <section className="glove-card">
              <div className="glove-section-label">
                <span className="glove-section-label__accent" aria-hidden="true" />
                {t.glove.jumpSection}
              </div>
              <div className="glove-row">
                <input
                  type="number"
                  value={jumpBarInput}
                  onChange={(e) => setJumpBarInput(e.target.value)}
                  disabled={busy}
                  min={JUMP_BAR_MIN}
                  max={JUMP_BAR_MAX}
                  aria-label={t.glove.jumpBarLabel}
                  className="glove-input glove-input--num"
                />
                <button
                  type="button"
                  onClick={handleJumpBar}
                  disabled={cmdDisabled}
                  title={cmdDisabled ? connHint : undefined}
                  className="glove-btn glove-btn--teal glove-btn--sm"
                >
                  {t.glove.jumpButton}
                </button>
              </div>
              {jumpStatus && <div className="glove-error">{jumpStatus}</div>}
              <div className="glove-hint">{t.glove.jumpHint}</div>
            </section>
          </div>

          {/* 清除乐谱 */}
          <section className="glove-card">
            <div className="glove-section-label">
              <span className="glove-section-label__accent" aria-hidden="true" />
              {t.glove.clearSection}
            </div>
            <div className="glove-row">
              <span className="glove-hint">{t.glove.clearTargetLabel}</span>
              <div className="glove-seg" role="group" aria-label={t.glove.clearTargetLabel}>
                <button
                  type="button"
                  onClick={() => setClearTarget('sram')}
                  disabled={busy}
                  className={`glove-seg__btn ${clearTarget === 'sram' ? 'glove-seg__btn--active' : ''}`}
                >
                  {t.glove.sram}
                </button>
                <button
                  type="button"
                  onClick={() => setClearTarget('eeprom')}
                  disabled={busy}
                  className={`glove-seg__btn ${clearTarget === 'eeprom' ? 'glove-seg__btn--active' : ''}`}
                >
                  {t.glove.eeprom}
                </button>
              </div>
              {clearTarget === 'eeprom' && (
                <label className="glove-hint" style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
                  {t.glove.clearPartitionLabel}
                  <select
                    value={clearPartition}
                    onChange={(e) => setClearPartition(Number(e.target.value))}
                    disabled={busy}
                    className="glove-select glove-select--num"
                  >
                    {partitionOptions.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <div className="glove-row">
              <button
                type="button"
                onClick={handleClearRequest}
                disabled={cmdDisabled}
                title={cmdDisabled ? connHint : undefined}
                className="glove-btn glove-btn--solid-danger glove-btn--sm"
              >
                <TrashIcon size={14} />
                {t.glove.clearButton}
              </button>
              <span className="glove-hint" style={{ color: 'var(--gp-text-4)' }}>
                ⚠️ {t.glove.clearWarning}
              </span>
            </div>
          </section>

          {/* 日志面板 */}
          <section className="glove-card">
            <div className="glove-log-header">
              <div className="glove-section-label">
                <span className="glove-section-label__accent" aria-hidden="true" />
                {t.glove.logSectionTitle}
              </div>
              <span className="glove-badge">{logs.length}</span>
            </div>
            <div ref={logContainerRef} className="glove-log">
              {logs.length === 0 ? (
                <span className="glove-log__empty">{t.glove.logEmpty}</span>
              ) : (
                logs.map((line, idx) => (
                  <div key={idx} className={`glove-log__line ${logLineClass(line)}`}>
                    {line}
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>

      {/* 清除乐谱二次确认弹窗 */}
      {confirmingClear && (
        <div className="glove-confirm-backdrop">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label={t.glove.clearConfirmTitle}
            className="glove-confirm"
          >
            <div className="glove-confirm__title">
              <span style={{ color: 'var(--gp-danger)' }} aria-hidden="true">
                <TrashIcon size={17} />
              </span>
              {t.glove.clearConfirmTitle}
            </div>
            <div className="glove-confirm__message">{t.glove.clearConfirmMessage}</div>
            <div className="glove-confirm__actions">
              <button type="button" onClick={handleCancelClear} className="glove-btn">
                {t.glove.clearConfirmCancel}
              </button>
              <button
                type="button"
                onClick={handleConfirmClear}
                className="glove-btn glove-btn--solid-danger"
              >
                {t.glove.clearConfirmOk}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
