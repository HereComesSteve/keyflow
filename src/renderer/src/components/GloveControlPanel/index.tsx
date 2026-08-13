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

/**
 * Bluetooth手套（左手套・マスター）接続用の全画面モーダル（ルーティング不要）。
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

  // 硬件控制状态：模式（单手/双手）、目标设备（左/右，仅单手模式）、EEPROM 分区。
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
  // 呼ぶ。requestDevice はユーザーが一覧からデバイスを選択するまで解決しない。
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

  // 目标设备切换（仅单手模式）
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

  // 控制按钮统一禁用条件：单条发送中或乐谱写入中。
  const controlsDisabled = sending || isWriting;

  // 控制区卡片样式（与连接卡片一致的浅色主题）
  const cardStyle: React.CSSProperties = {
    backgroundColor: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: '8px',
    padding: '16px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    boxShadow: '0 1px 2px rgba(0, 0, 0, 0.04)',
  };
  // 控制按钮样式：active 时高亮（蓝底白字），禁用时半透明 + 禁用光标。
  const commandButtonStyle = (active = false): React.CSSProperties => ({
    padding: '8px 14px',
    backgroundColor: active ? '#2563eb' : '#fff',
    color: active ? 'white' : '#374151',
    border: `1px solid ${active ? '#2563eb' : '#d1d5db'}`,
    borderRadius: '4px',
    cursor: controlsDisabled ? 'not-allowed' : 'pointer',
    fontSize: '0.875rem',
    fontWeight: 500,
    opacity: controlsDisabled ? 0.6 : 1,
  });

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        backgroundColor: '#f5f5f5',
        color: '#111827',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header bar: 左に閉じるボタン、中央にタイトル */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          height: '48px',
          padding: '0 12px',
          backgroundColor: '#fff',
          borderBottom: '1px solid #ccc',
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={t.glove.closeButtonAriaLabel}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '36px',
            height: '36px',
            padding: 0,
            backgroundColor: 'transparent',
            border: 'none',
            borderRadius: '6px',
            color: '#374151',
            cursor: 'pointer',
          }}
        >
          <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
        <h2 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 600 }}>
          {t.glove.dialogTitle}
        </h2>
      </div>

      {/* Content */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t.glove.dialogTitle}
        tabIndex={-1}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          maxWidth: '720px',
          width: '100%',
          margin: '0 auto',
          boxSizing: 'border-box',
        }}
      >
        {/* 左手套カード */}
        <div
          style={{
            backgroundColor: '#fff',
            border: '1px solid #e5e7eb',
            borderRadius: '8px',
            padding: '16px 20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            boxShadow: '0 1px 2px rgba(0, 0, 0, 0.04)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span aria-hidden="true" style={{ fontSize: '1.5rem' }}>🧤</span>
            <span style={{ fontSize: '1rem', fontWeight: 600 }}>{t.glove.leftGloveLabel}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={handleConnect}
              disabled={isConnected || isScanning}
              style={{
                padding: '8px 16px',
                backgroundColor: isConnected || isScanning ? '#9ca3af' : '#2563eb',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: isConnected || isScanning ? 'not-allowed' : 'pointer',
                fontWeight: 500,
              }}
            >
              {t.glove.connectButton}
            </button>
            <span style={{ fontSize: '0.875rem' }}>
              {t.glove.statusLabel}{' '}
              {isConnected ? (
                <span style={{ color: '#059669', fontWeight: 500 }}>
                  {t.glove.statusConnected}
                  {deviceName ? ` (${deviceName})` : ''}
                </span>
              ) : (
                <span style={{ color: '#6b7280' }}>{t.glove.statusDisconnected}</span>
              )}
            </span>
          </div>
        </div>

        {/* スキャン中: 発見デバイス一覧を表示しユーザーに選ばせる */}
        {isScanning && (
          <div
            style={{
              backgroundColor: '#fff',
              border: '1px solid #e5e7eb',
              borderRadius: '8px',
              padding: '16px 20px',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              boxShadow: '0 1px 2px rgba(0, 0, 0, 0.04)',
            }}
          >
            <div style={{ fontSize: '0.875rem', fontWeight: 600 }}>{t.glove.scanPrompt}</div>
            <div style={{ fontSize: '0.8125rem', color: '#6b7280' }}>{t.glove.scanningHint}</div>
            {availableDevices.length === 0 ? (
              <div style={{ fontSize: '0.8125rem', color: '#9ca3af', fontStyle: 'italic' }}>
                {t.glove.noDevicesYet}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {availableDevices.map((device) => (
                  <button
                    key={device.deviceId}
                    type="button"
                    onClick={() => handlePickDevice(device.deviceId)}
                    style={{
                      textAlign: 'left',
                      padding: '10px 12px',
                      backgroundColor: '#fafafa',
                      color: '#111827',
                      border: '1px solid #e5e7eb',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontSize: '0.875rem',
                    }}
                  >
                    {device.deviceName || device.deviceId}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={handleCancelScan}
              style={{
                alignSelf: 'flex-start',
                padding: '6px 12px',
                backgroundColor: 'transparent',
                color: '#6b7280',
                border: '1px solid #d1d5db',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '0.8125rem',
              }}
            >
              {t.glove.cancelScan}
            </button>
          </div>
        )}

        {/* 切断ボタン */}
        <button
          type="button"
          onClick={handleDisconnect}
          disabled={!isConnected}
          style={{
            alignSelf: 'flex-start',
            padding: '8px 16px',
            backgroundColor: !isConnected ? '#e5e7eb' : '#fff',
            color: !isConnected ? '#9ca3af' : '#dc2626',
            border: '1px solid ' + (!isConnected ? '#e5e7eb' : '#dc2626'),
            borderRadius: '4px',
            cursor: !isConnected ? 'not-allowed' : 'pointer',
            fontWeight: 500,
          }}
        >
          {t.glove.disconnectButton}
        </button>

        {/* 播放控制区 */}
        <div style={cardStyle}>
          <div style={{ fontSize: '0.875rem', fontWeight: 600 }}>{t.glove.playbackSection}</div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              type="button"
              onClick={handleSramPlay}
              disabled={controlsDisabled}
              style={commandButtonStyle()}
            >
              {t.glove.sramPlay}
            </button>
            <button
              type="button"
              onClick={handleEepromPlay}
              disabled={controlsDisabled}
              style={commandButtonStyle()}
            >
              {t.glove.eepromPlay}
            </button>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '0.8125rem',
                color: '#6b7280',
              }}
            >
              {t.glove.partitionLabel}
              <select
                value={partition}
                onChange={(e) => setPartition(Number(e.target.value))}
                disabled={controlsDisabled}
                style={{
                  padding: '4px 8px',
                  borderRadius: '4px',
                  border: '1px solid #d1d5db',
                  backgroundColor: '#fff',
                  color: '#374151',
                  fontSize: '0.8125rem',
                }}
              >
                {Array.from(
                  { length: EEPROM_PARTITION_MAX - EEPROM_PARTITION_MIN + 1 },
                  (_, i) => {
                    const v = EEPROM_PARTITION_MIN + i;
                    return (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    );
                  }
                )}
              </select>
            </label>
            <button type="button" onClick={handleStop} disabled={controlsDisabled} style={commandButtonStyle()}>
              {t.glove.stop}
            </button>
            <button type="button" onClick={handlePause} disabled={controlsDisabled} style={commandButtonStyle()}>
              {t.glove.pause}
            </button>
            <button type="button" onClick={handleResume} disabled={controlsDisabled} style={commandButtonStyle()}>
              {t.glove.resume}
            </button>
            <button type="button" onClick={handleReset} disabled={controlsDisabled} style={commandButtonStyle()}>
              {t.glove.reset}
            </button>
          </div>
        </div>

        {/* 模式设置区 */}
        <div style={cardStyle}>
          <div style={{ fontSize: '0.875rem', fontWeight: 600 }}>{t.glove.modeSection}</div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={handleSingleHand}
              disabled={controlsDisabled}
              style={commandButtonStyle(mode === 'single')}
            >
              {t.glove.singleHand}
            </button>
            <button
              type="button"
              onClick={handleDualHand}
              disabled={controlsDisabled}
              style={commandButtonStyle(mode === 'dual')}
            >
              {t.glove.dualHand}
            </button>
          </div>
        </div>

        {/* 目标设备选择区（仅单手模式显示） */}
        {mode === 'single' && (
          <div style={cardStyle}>
            <div style={{ fontSize: '0.875rem', fontWeight: 600 }}>{t.glove.targetSection}</div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={handleTargetLeft}
                disabled={controlsDisabled}
                style={commandButtonStyle(target === 'left')}
              >
                {t.glove.targetLeft}
              </button>
              <button
                type="button"
                onClick={handleTargetRight}
                disabled={controlsDisabled}
                style={commandButtonStyle(target === 'right')}
              >
                {t.glove.targetRight}
              </button>
            </div>
          </div>
        )}

        {/* 📝 乐谱写入区 */}
        <div style={cardStyle}>
          <div style={{ fontSize: '0.875rem', fontWeight: 600 }}>📝 {t.glove.writeSection}</div>

          {/* 目标设备（始终显示，与模式设置区目标按钮共用 target 状态） */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.8125rem', color: '#6b7280' }}>{t.glove.writeTargetLabel}</span>
            <button
              type="button"
              onClick={handleTargetLeft}
              disabled={controlsDisabled}
              style={commandButtonStyle(target === 'left')}
            >
              {t.glove.targetLeft}
            </button>
            <button
              type="button"
              onClick={handleTargetRight}
              disabled={controlsDisabled}
              style={commandButtonStyle(target === 'right')}
            >
              {t.glove.targetRight}
            </button>
          </div>

          {/* 存储介质（SRAM / EEPROM），EEPROM 时显示分区选择器 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.8125rem', color: '#6b7280' }}>{t.glove.writeStorageLabel}</span>
            <button
              type="button"
              onClick={() => setWriteStorage('sram')}
              disabled={controlsDisabled}
              style={commandButtonStyle(writeStorage === 'sram')}
            >
              {t.glove.sram}
            </button>
            <button
              type="button"
              onClick={() => setWriteStorage('eeprom')}
              disabled={controlsDisabled}
              style={commandButtonStyle(writeStorage === 'eeprom')}
            >
              {t.glove.eeprom}
            </button>
            {writeStorage === 'eeprom' && (
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  fontSize: '0.8125rem',
                  color: '#6b7280',
                }}
              >
                {t.glove.partitionLabel}
                <select
                  value={writePartition}
                  onChange={(e) => setWritePartition(Number(e.target.value))}
                  disabled={controlsDisabled}
                  style={{
                    padding: '4px 8px',
                    borderRadius: '4px',
                    border: '1px solid #d1d5db',
                    backgroundColor: '#fff',
                    color: '#374151',
                    fontSize: '0.8125rem',
                  }}
                >
                  {Array.from(
                    { length: EEPROM_PARTITION_MAX - EEPROM_PARTITION_MIN + 1 },
                    (_, i) => {
                      const v = EEPROM_PARTITION_MIN + i;
                      return (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      );
                    }
                  )}
                </select>
              </label>
            )}
          </div>

          {/* 从当前乐谱导入 + 发送范围 */}
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            padding: '8px 12px',
            backgroundColor: '#f0f9ff',
            border: '1px dashed #38bdf8',
            borderRadius: '6px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.8125rem', color: '#374151' }}>
                {t.glove.rangeLabel}
                <input
                  type="text"
                  value={rangeInput}
                  onChange={(e) => setRangeInput(e.target.value)}
                  placeholder={t.glove.rangePlaceholder}
                  style={{
                    width: '160px',
                    padding: '4px 8px',
                    border: '1px solid #d1d5db',
                    borderRadius: '4px',
                    fontSize: '0.8125rem',
                  }}
                />
              </label>
              <button
                type="button"
                onClick={handleImportFromScore}
                disabled={controlsDisabled}
                style={{
                  padding: '6px 14px',
                  backgroundColor: '#0ea5e9',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '4px',
                  fontSize: '0.8125rem',
                  cursor: controlsDisabled ? 'not-allowed' : 'pointer',
                  opacity: controlsDisabled ? 0.5 : 1,
                }}
              >
                📋 {t.glove.importFromScore}
              </button>
            </div>
            <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>
              {t.glove.rangeHint}
            </span>
          </div>

          {/* 乐谱数据文本域 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ fontSize: '0.8125rem', color: '#6b7280' }}>{t.glove.scoreDataLabel}</span>
            <textarea
              value={scoreInput}
              onChange={(e) => setScoreInput(e.target.value)}
              placeholder={t.glove.scoreDataPlaceholder}
              disabled={isWriting}
              spellCheck={false}
              style={{
                width: '100%',
                minHeight: '80px',
                padding: '8px',
                borderRadius: '4px',
                border: '1px solid #d1d5db',
                backgroundColor: '#fff',
                color: '#374151',
                fontFamily: 'monospace',
                fontSize: '0.8125rem',
                resize: 'vertical',
                boxSizing: 'border-box',
              }}
            />
            <span style={{ fontSize: '0.75rem', color: '#9ca3af' }}>
              {formatMessage(t.glove.statCommands, { count: scoreCommandCount })}
              {writeStorage === 'sram' && ` · ${t.glove.sramCapacityHint}`}
              {writeStorage === 'eeprom' && ` · ${t.glove.eepromCapacityHint}`}
            </span>
          </div>

          {/* 写入按钮 + 取消按钮 + 状态提示 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={handleWriteScore}
              disabled={controlsDisabled}
              style={commandButtonStyle()}
            >
              {isWriting ? t.glove.writingButton : t.glove.writeButton}
            </button>
            {isWriting && (
              <button
                type="button"
                onClick={handleCancelWrite}
                style={{ ...commandButtonStyle(), background: '#dc2626', color: '#fff' }}
              >
                {t.glove.cancelWriteButton}
              </button>
            )}
            {writeStatus && (
              <span style={{ fontSize: '0.8125rem', color: '#374151' }}>{writeStatus}</span>
            )}
          </div>
        </div>

        {/* ⚡ BPM 设置区 */}
        <div style={cardStyle}>
          <div style={{ fontSize: '0.875rem', fontWeight: 600 }}>⚡ {t.glove.bpmSection}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.8125rem', color: '#6b7280' }}>{t.glove.bpmInputLabel}</span>
            <input
              type="number"
              value={bpmInput}
              onChange={(e) => setBpmInput(e.target.value)}
              disabled={controlsDisabled}
              min={BPM_MIN}
              max={BPM_MAX}
              style={{
                width: '72px',
                padding: '4px 8px',
                borderRadius: '4px',
                border: '1px solid #d1d5db',
                backgroundColor: '#fff',
                color: '#374151',
                fontSize: '0.8125rem',
              }}
            />
            <button
              type="button"
              onClick={handleSetBpm}
              disabled={controlsDisabled}
              style={commandButtonStyle()}
            >
              {t.glove.bpmSetButton}
            </button>
          </div>
          <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>
            {formatMessage(t.glove.bpmCurrent, { value: bpmValue })}
            {bpmStatus && <span style={{ color: '#dc2626', marginLeft: '8px' }}>{bpmStatus}</span>}
          </div>
        </div>

        {/* 🎵 拍号设置区 */}
        <div style={cardStyle}>
          <div style={{ fontSize: '0.875rem', fontWeight: 600 }}>🎵 {t.glove.timeSignatureSection}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.8125rem', color: '#6b7280' }}>{t.glove.timeSignatureLabel}</span>
            <select
              value={timeSignature}
              onChange={(e) => setTimeSignature(e.target.value)}
              disabled={controlsDisabled}
              style={{
                padding: '4px 8px',
                borderRadius: '4px',
                border: '1px solid #d1d5db',
                backgroundColor: '#fff',
                color: '#374151',
                fontSize: '0.8125rem',
              }}
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
              disabled={controlsDisabled}
              style={commandButtonStyle()}
            >
              {t.glove.timeSignatureSetButton}
            </button>
          </div>
          <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>
            {formatMessage(t.glove.timeSignatureCurrent, { value: timeSignatureValue })}
          </div>
        </div>

        {/* 🖐 马达强度设置区 */}
        <div style={cardStyle}>
          <div style={{ fontSize: '0.875rem', fontWeight: 600 }}>🖐 {t.glove.intensitySection}</div>

          {/* 目标设备（左右手）：选左手→左手本地执行，选右手→由左手转发给右手。
              与模式/写入区的目标按钮共用 target 状态。 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.8125rem', color: '#6b7280' }}>{t.glove.writeTargetLabel}</span>
            <button
              type="button"
              onClick={handleTargetLeft}
              disabled={controlsDisabled}
              style={commandButtonStyle(target === 'left')}
            >
              {t.glove.targetLeft}
            </button>
            <button
              type="button"
              onClick={handleTargetRight}
              disabled={controlsDisabled}
              style={commandButtonStyle(target === 'right')}
            >
              {t.glove.targetRight}
            </button>
          </div>

          {/* 手指选择 + 强度输入 + 发送/一键发送 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.8125rem', color: '#6b7280' }}>{t.glove.intensityFingerLabel}</span>
            <select
              value={strengthFinger}
              onChange={(e) => setStrengthFinger(Number(e.target.value))}
              disabled={controlsDisabled}
              style={{
                padding: '4px 8px',
                borderRadius: '4px',
                border: '1px solid #d1d5db',
                backgroundColor: '#fff',
                color: '#374151',
                fontSize: '0.8125rem',
              }}
            >
              {Array.from(
                { length: INTENSITY_FINGER_MAX - INTENSITY_FINGER_MIN + 1 },
                (_, i) => {
                  const v = INTENSITY_FINGER_MIN + i;
                  return (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  );
                }
              )}
            </select>
            <span style={{ fontSize: '0.8125rem', color: '#6b7280' }}>{t.glove.intensityValueLabel}</span>
            <input
              type="number"
              value={intensityInput}
              onChange={(e) => setIntensityInput(e.target.value)}
              disabled={controlsDisabled}
              min={INTENSITY_MIN}
              max={INTENSITY_MAX}
              style={{
                width: '72px',
                padding: '4px 8px',
                borderRadius: '4px',
                border: '1px solid #d1d5db',
                backgroundColor: '#fff',
                color: '#374151',
                fontSize: '0.8125rem',
              }}
            />
            <button
              type="button"
              onClick={handleSendIntensity}
              disabled={controlsDisabled}
              style={commandButtonStyle()}
            >
              {t.glove.intensitySendButton}
            </button>
            <button
              type="button"
              onClick={handleSendAllIntensity}
              disabled={controlsDisabled}
              style={{ ...commandButtonStyle(), backgroundColor: '#7c3aed', color: 'white', borderColor: '#7c3aed' }}
            >
              {t.glove.intensitySendAllButton}
            </button>
          </div>

          {intensityStatus && (
            <div style={{ fontSize: '0.8125rem', color: '#dc2626' }}>{intensityStatus}</div>
          )}
          <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>{t.glove.intensityHint}</div>
        </div>

        {/* ⏩ 小节跳转区 */}
        <div style={cardStyle}>
          <div style={{ fontSize: '0.875rem', fontWeight: 600 }}>⏩ {t.glove.jumpSection}</div>

          {/* 目标设备（左右手）：与强度/写入区共用 target 状态 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.8125rem', color: '#6b7280' }}>{t.glove.writeTargetLabel}</span>
            <button
              type="button"
              onClick={handleTargetLeft}
              disabled={controlsDisabled}
              style={commandButtonStyle(target === 'left')}
            >
              {t.glove.targetLeft}
            </button>
            <button
              type="button"
              onClick={handleTargetRight}
              disabled={controlsDisabled}
              style={commandButtonStyle(target === 'right')}
            >
              {t.glove.targetRight}
            </button>
          </div>

          {/* 小节号输入 + 跳转按钮 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.8125rem', color: '#6b7280' }}>{t.glove.jumpBarLabel}</span>
            <input
              type="number"
              value={jumpBarInput}
              onChange={(e) => setJumpBarInput(e.target.value)}
              disabled={controlsDisabled}
              min={JUMP_BAR_MIN}
              max={JUMP_BAR_MAX}
              style={{
                width: '72px',
                padding: '4px 8px',
                borderRadius: '4px',
                border: '1px solid #d1d5db',
                backgroundColor: '#fff',
                color: '#374151',
                fontSize: '0.8125rem',
              }}
            />
            <button
              type="button"
              onClick={handleJumpBar}
              disabled={controlsDisabled}
              style={{ ...commandButtonStyle(), backgroundColor: '#0d9488', color: 'white', borderColor: '#0d9488' }}
            >
              {t.glove.jumpButton}
            </button>
          </div>

          {jumpStatus && (
            <div style={{ fontSize: '0.8125rem', color: '#dc2626' }}>{jumpStatus}</div>
          )}
          <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>{t.glove.jumpHint}</div>
        </div>

        {/* 🗑 清除乐谱区 */}
        <div style={cardStyle}>
          <div style={{ fontSize: '0.875rem', fontWeight: 600 }}>🗑 {t.glove.clearSection}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.8125rem', color: '#6b7280' }}>{t.glove.clearTargetLabel}</span>
            <button
              type="button"
              onClick={() => setClearTarget('sram')}
              disabled={controlsDisabled}
              style={commandButtonStyle(clearTarget === 'sram')}
            >
              {t.glove.sram}
            </button>
            <button
              type="button"
              onClick={() => setClearTarget('eeprom')}
              disabled={controlsDisabled}
              style={commandButtonStyle(clearTarget === 'eeprom')}
            >
              {t.glove.eeprom}
            </button>
            {clearTarget === 'eeprom' && (
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  fontSize: '0.8125rem',
                  color: '#6b7280',
                }}
              >
                {t.glove.clearPartitionLabel}
                <select
                  value={clearPartition}
                  onChange={(e) => setClearPartition(Number(e.target.value))}
                  disabled={controlsDisabled}
                  style={{
                    padding: '4px 8px',
                    borderRadius: '4px',
                    border: '1px solid #d1d5db',
                    backgroundColor: '#fff',
                    color: '#374151',
                    fontSize: '0.8125rem',
                  }}
                >
                  {Array.from(
                    { length: EEPROM_PARTITION_MAX - EEPROM_PARTITION_MIN + 1 },
                    (_, i) => {
                      const v = EEPROM_PARTITION_MIN + i;
                      return (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      );
                    }
                  )}
                </select>
              </label>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={handleClearRequest}
              disabled={controlsDisabled}
              style={{
                ...commandButtonStyle(),
                backgroundColor: '#dc2626',
                color: 'white',
                borderColor: '#dc2626',
              }}
            >
              {t.glove.clearButton}
            </button>
            <span style={{ fontSize: '0.75rem', color: '#9ca3af' }}>⚠️ {t.glove.clearWarning}</span>
          </div>
        </div>

        {/* ログパネル */}
        <div
          style={{
            backgroundColor: '#fff',
            border: '1px solid #e5e7eb',
            borderRadius: '8px',
            padding: '16px 20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            flex: 1,
            minHeight: '200px',
            boxShadow: '0 1px 2px rgba(0, 0, 0, 0.04)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span aria-hidden="true">📋</span>
            <span style={{ fontSize: '0.875rem', fontWeight: 600 }}>{t.glove.logSectionTitle}</span>
          </div>
          <div
            ref={logContainerRef}
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: '0.8125rem',
              color: '#374151',
              backgroundColor: '#fafafa',
              border: '1px solid #f3f4f6',
              borderRadius: '4px',
              padding: '8px 12px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {logs.length === 0 ? (
              <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>{t.glove.logEmpty}</span>
            ) : (
              logs.map((line, idx) => (
                <div key={idx} style={{ lineHeight: '1.6' }}>
                  {line}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* 清除乐谱二次确认弹窗 */}
      {confirmingClear && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              backgroundColor: '#fff',
              borderRadius: '8px',
              padding: '24px',
              maxWidth: '360px',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
            }}
          >
            <div style={{ fontSize: '1rem', fontWeight: 600 }}>{t.glove.clearConfirmTitle}</div>
            <div style={{ fontSize: '0.875rem', color: '#6b7280' }}>{t.glove.clearConfirmMessage}</div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={handleCancelClear}
                style={commandButtonStyle()}
              >
                {t.glove.clearConfirmCancel}
              </button>
              <button
                type="button"
                onClick={handleConfirmClear}
                style={{
                  ...commandButtonStyle(),
                  backgroundColor: '#dc2626',
                  color: 'white',
                  borderColor: '#dc2626',
                }}
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
