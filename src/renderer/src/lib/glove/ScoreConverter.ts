/**
 * ScoreConverter: 将 Keyflow 当前加载的乐谱 + 指法数据转换为手套蓝牙指令格式。
 *
 * 转换流程：
 * 1. 解析用户输入的小节范围（支持 1-3, 5-7, 9 格式，支持重复）
 * 2. 按小节序列遍历，过滤目标手的音符，关联指法
 * 3. 乐谱 tick → 蓝牙 tick 换算 + 小节偏移（segIdx * ticksPerBar）
 * 4. 生成 NoteOn/NoteOff 指令，同 tick 手指 OR 合并
 * 5. 按绝对 tick 排序，同 tick Off 在前
 * 6. 空小节处理（为所有没有指令的小节插入占位空指令）
 * 7. 递归补丁算法（处理固件跨小节检测问题）
 * 8. 格式化为 "relTick motorCtrl ..." 纯数据字符串
 */

import type { Score, Annotation, Finger } from '../../types';

/** 转换结果。 */
export interface ConvertResult {
  /** "00 81 10 82 ..." 格式的纯数据字符串 */
  data: string;
  /** 参与转换的音符数量（有指法的） */
  noteCount: number;
  /** 生成的指令数量（含补丁） */
  instructionCount: number;
  /** 因无指法被跳过的音符数 */
  skippedNotes: number;
  /** 补丁插入的对数（每对 = endOfBar + startOfNextBar） */
  patchedCount: number;
  /** 警告信息（如 tick 取整、relTick 溢出等） */
  warnings: string[];
}

/** 内部指令结构（蓝牙 tick 空间）。 */
interface Command {
  /** 绝对 tick（蓝牙空间） */
  absTick: number;
  /** 相对 tick（absTick % ticksPerBar），输出时赋值 */
  relTick: number;
  /** 马达控制字节（bit7=On/Off，bit0-4=手指掩码） */
  motorCtrl: number;
  /** true=NoteOn（bit7=1），false=NoteOff（bit7=0） */
  isOn: boolean;
}

/** 十六进制格式化：2位大写。 */
function hex2(v: number): string {
  return v.toString(16).toUpperCase().padStart(2, '0');
}

/**
 * 将乐谱 tick 换算为蓝牙 tick。
 * 蓝牙 tick 空间：每拍 = 32 ticks（固定）
 * 乐谱 tick 空间：PPQ=480，分母影响每拍 tick 数
 */
function toBluetoothTick(
  scoreTick: number,
  ppq: number,
  beatType: number
): number {
  const denominatorFactor = 4 / beatType;
  const ticksPerBeatNote = ppq * denominatorFactor;
  return Math.round((scoreTick * 32) / ticksPerBeatNote);
}

/**
 * 解析用户输入的小节范围字符串。
 *
 * 支持格式：
 * - "1-3" → [1, 2, 3]
 * - "1-3, 5-7" → [1, 2, 3, 5, 6, 7]
 * - "1-3, 1-3" → [1, 2, 3, 1, 2, 3]（重复，实现反复效果）
 * - "9" → [9]
 * - "" → []（空，表示所有小节）
 *
 * @throws 无效输入时抛出 Error
 */
export function parseRange(range: string): number[] {
  if (!range || range.trim() === '') return [];

  const result: number[] = [];
  const parts = range.split(',').map((s) => s.trim());

  for (const part of parts) {
    if (part === '') continue;
    if (part.includes('-')) {
      const dashParts = part.split('-');
      if (dashParts.length !== 2) {
        throw new Error(`Invalid range: ${part}`);
      }
      const start = Number(dashParts[0].trim());
      const end = Number(dashParts[1].trim());
      if (isNaN(start) || isNaN(end) || start < 1 || end < 1 || start > end) {
        throw new Error(`Invalid range: ${part}`);
      }
      for (let i = start; i <= end; i++) {
        result.push(i);
      }
    } else {
      const num = Number(part);
      if (isNaN(num) || num < 1) {
        throw new Error(`Invalid measure number: ${part}`);
      }
      result.push(num);
    }
  }

  return result;
}

/**
 * 应用补丁算法：处理固件跨小节检测问题。
 *
 * 固件逻辑：if (eepromCurTick < eepromLastTick) eepromSectionStart += barDurationUs
 * 问题：当音符跨小节且相对 tick 递增时，固件无法检测到跨小节。
 * 补丁：在小节边界插入一对 "保持当前状态" 的指令，强制固件推进小节。
 *
 * @param commands 已排序的指令数组（蓝牙绝对 tick）
 * @param ticksPerBar 每小节的蓝牙 tick 数（= 32 * beats）
 */
function applyPatch(commands: Command[], ticksPerBar: number): { result: Command[]; patchedCount: number; patchIterations: number } {
  // 预先按 absTick 排序
  commands.sort((a, b) => a.absTick - b.absTick);

  let patched = true;
  let result: Command[] = [...commands];
  let patchedCount = 0;
  let patchIterations = 0; // 诊断：while(patched) 循环次数
  const MAX_ITERATIONS = 100; // 安全计数器，防止 while 循环无限迭代

  while (patched && result.length > 0) {
    // 安全计数器：限制 while 循环次数，防止补丁递归导致死循环
    if (patchIterations >= MAX_ITERATIONS) {
      break;
    }
    patchIterations++;
    patched = false;
    const newResult: Command[] = [];
    // accumulatedMask 每次迭代重置！
    let accumulatedMask = 0;

    for (let i = 0; i < result.length; i++) {
      const curr = result[i];

      // 更新累积状态：NoteOn 加入掩码，NoteOff 移除掩码
      if (curr.isOn && curr.motorCtrl !== 0x00) {
        accumulatedMask |= curr.motorCtrl & 0x1f;
      } else if (!curr.isOn) {
        accumulatedMask &= ~(curr.motorCtrl & 0x1f);
      }

      newResult.push(curr);

      // 检查下一条是否需要补丁
      if (i + 1 < result.length) {
        const next = result[i + 1];
        const currBar = Math.floor(curr.absTick / ticksPerBar);
        const nextBar = Math.floor(next.absTick / ticksPerBar);
        const currRel = curr.absTick % ticksPerBar;
        const nextRel = next.absTick % ticksPerBar;

        // 补丁触发条件：跨小节 且 (相对 tick 递增 或 跨超过 1 小节)
        if (currBar !== nextBar && (nextRel >= currRel || nextBar - currBar > 1)) {
          patched = true;
          const patchMotorCtrl = 0x80 | accumulatedMask;

          // 为每个被跳过的小节边界插入补丁对
          for (let bar = currBar; bar < nextBar; bar++) {
            const endOfBar = (bar + 1) * ticksPerBar - 1;
            newResult.push({
              absTick: endOfBar,
              relTick: 0, // 后面统一计算
              motorCtrl: patchMotorCtrl,
              isOn: true,
            });

            const startOfNextBar = (bar + 1) * ticksPerBar;
            newResult.push({
              absTick: startOfNextBar,
              relTick: 0,
              motorCtrl: patchMotorCtrl,
              isOn: true,
            });
            patchedCount++;
          }
        }
      }
    }

    // 重新排序：按 absTick，同 tick Off (bit7=0) 在前，On (bit7=1) 在后
    newResult.sort((a, b) => {
      if (a.absTick !== b.absTick) return a.absTick - b.absTick;
      // bit7=0 (Off) < bit7=1 (On)，所以 Off 在前
      return (a.motorCtrl & 0x80) - (b.motorCtrl & 0x80);
    });

    result = newResult;
  }

  // 计算相对 tick
  for (const cmd of result) {
    cmd.relTick = cmd.absTick % ticksPerBar;
  }

  console.log(`[applyPatch] 迭代次数: ${patchIterations}, 补丁插入对数: ${patchedCount}, 输入: ${commands.length} 条, 输出: ${result.length} 条`);

  return { result, patchedCount, patchIterations };
}

/**
 * 空小节处理：为所有没有指令的小节插入占位空指令，保证固件能正确检测跨小节。
 *
 * 问题：如果某个小节完全没有指令（整小节休止），固件失去跨小节检测锚点，
 * 导致后续所有指令的时间轴错位。固件仅靠 "相邻 tick 递减" 检测跨小节。
 *
 * 解决：
 * - 完全空的小节：在 tick=0 和 tick=ticksPerBar-1 各插入一条 motorCtrl=0x00 空指令
 * - 第一小节有指令但末尾无标记（relTick < ticksPerBar-1）：在 tick=ticksPerBar-1 插入空指令
 *   （保留原有弱起逻辑，确保第一小节与第二小节之间有跨小节锚点）
 *
 * 必须在 applyPatch 之前调用，这样 applyPatch 能看到完整的指令序列。
 *
 * @param commands 已排序的指令数组（蓝牙绝对 tick）
 * @param sequenceLength 用户选中的小节序列长度
 * @param ticksPerBar 每小节的蓝牙 tick 数（= 32 * beats）
 * @returns 处理后的指令数组（未重新排序，由调用方排序）
 */
function handleEmptyMeasures(
  commands: Command[],
  sequenceLength: number,
  ticksPerBar: number
): Command[] {
  const result = [...commands];

  // 1. 找出哪些片段有指令
  const segmentsWithCommands = new Set<number>();
  for (const cmd of result) {
    const segIdx = Math.floor(cmd.absTick / ticksPerBar);
    segmentsWithCommands.add(segIdx);
  }

  // 2. 遍历所有片段，为空片段插入占位空指令
  let emptyMeasureCount = 0;
  for (let i = 0; i < sequenceLength; i++) {
    if (!segmentsWithCommands.has(i)) {
      const absStart = i * ticksPerBar;
      const absEnd = absStart + ticksPerBar - 1;

      // tick=0 空指令（小节开头，建立时间轴起点）
      result.push({
        absTick: absStart,
        relTick: 0,
        motorCtrl: 0x00,
        isOn: false,
      });

      // tick=ticksPerBar-1 空指令（小节末尾，建立跨小节锚点）
      result.push({
        absTick: absEnd,
        relTick: ticksPerBar - 1,
        motorCtrl: 0x00,
        isOn: false,
      });
      emptyMeasureCount++;
    }
  }

  // 3. 第一小节有指令但末尾无标记：在 tick=ticksPerBar-1 插入空指令
  //    （原有弱起逻辑，确保第一小节与第二小节之间有跨小节锚点）
  const firstBarCommands = result.filter((cmd) => cmd.absTick < ticksPerBar);
  if (firstBarCommands.length > 0) {
    const lastRelTick = Math.max(...firstBarCommands.map((cmd) => cmd.absTick % ticksPerBar));
    if (lastRelTick < ticksPerBar - 1) {
      result.push({
        absTick: ticksPerBar - 1,
        relTick: ticksPerBar - 1,
        motorCtrl: 0x00,
        isOn: false,
      });
    }
  }

  console.log(`[handleEmptyMeasures] 空小节数: ${emptyMeasureCount}, 插入后指令数: ${result.length}`);

  return result;
}

/**
 * 将乐谱 + 指法数据转换为手套蓝牙指令。
 *
 * @param score 当前加载的乐谱（含 measures、timeSignature、ticksPerQuarter）
 * @param annotations 指法标注数据（noteId → fingerNumber）
 * @param targetHand 目标手（'left' | 'right'）
 * @param range 可选，用户输入的小节范围（如 "1-3, 5-7, 9"），空则转换所有小节
 */
export function convertScoreToGloveCommands(
  score: Score,
  annotations: Annotation[],
  targetHand: 'left' | 'right',
  range?: string
): ConvertResult {
  const warnings: string[] = [];

  // === 诊断日志：乐谱基本信息 ===
  const allNotes = score.measures.flatMap((m) => m.notes);
  const notesByHand = allNotes.filter((n) => n.hand === targetHand);
  const notesNotRest = notesByHand.filter((n) => !n.isRest);
  console.log('=== 转换诊断 ===');
  console.log(`乐谱标题: ${score.title}`);
  console.log(`总小节数: ${score.measures.length}`);
  console.log(`总音符数（含休止符）: ${allNotes.length}`);
  console.log(`目标手: ${targetHand}`);
  console.log(`按手过滤后: ${notesByHand.length}`);
  console.log(`过滤休止符后: ${notesNotRest.length}`);
  console.log(`指法标注总数: ${annotations.length}, 其中含 fingerNumber: ${annotations.filter((a) => a.fingerNumber !== undefined).length}`);

  // 第一步：构建指法查找表
  const fingerMap = new Map<string, Finger>();
  for (const ann of annotations) {
    if (ann.fingerNumber !== undefined) {
      fingerMap.set(ann.noteId, ann.fingerNumber);
    }
  }

  // 第二步：计算 tick 参数（提前到音符遍历前，range 偏移需要 ticksPerBar）
  const ppq = score.ticksPerQuarter;
  const beatType = score.timeSignature.beatType;
  const beats = score.timeSignature.beats;
  const ticksPerBar = 32 * beats; // 蓝牙 tick 空间

  // 验证 relTick 是否可能溢出 1 字节
  if (ticksPerBar > 255) {
    warnings.push(
      `Time signature ${beats}/${beatType}: ticksPerBar=${ticksPerBar} exceeds 255, relTick may collide with FF end marker`
    );
  }

  // 第三步：解析用户输入的范围 → 有序小节号列表
  let measureSequence: number[];
  try {
    measureSequence = parseRange(range ?? '');
  } catch (e) {
    return {
      data: '',
      noteCount: 0,
      instructionCount: 0,
      skippedNotes: 0,
      patchedCount: 0,
      warnings: [e instanceof Error ? e.message : String(e)],
    };
  }
  // 空范围 → 所有小节按原始顺序
  if (measureSequence.length === 0) {
    measureSequence = score.measures.map((m) => m.number);
  }

  // 构建小节查找表：measureNumber → Measure
  const measureMap = new Map(score.measures.map((m) => [m.number, m] as const));

  // 诊断日志：范围信息
  console.log(`发送范围: ${range && range.trim() ? range : '(全部)'}, 序列长度: ${measureSequence.length}`);

  // 第四步：按小节序列遍历，生成 On/Off 指令（tick 偏移 + OR 合并）
  let skippedNotes = 0;
  let noteCount = 0;
  const commandMap = new Map<string, Command>();
  let hasNonIntegerTick = false;

  for (let segIdx = 0; segIdx < measureSequence.length; segIdx++) {
    const measureNum = measureSequence[segIdx];
    const measure = measureMap.get(measureNum);
    if (!measure) {
      warnings.push(`Measure ${measureNum} not found, skipped`);
      continue;
    }

    // 该小节在输出序列中的蓝牙 tick 偏移
    const tickOffset = segIdx * ticksPerBar;

    for (const note of measure.notes) {
      if (note.isRest || note.hand !== targetHand) continue;
      const finger = fingerMap.get(note.id);
      if (finger === undefined) {
        skippedNotes++;
        continue;
      }
      noteCount++;

      // 相对于小节开始的 tick → 蓝牙 tick → 加偏移
      const onRelScoreTick = note.startTick - measure.startTick;
      const offRelScoreTick = onRelScoreTick + note.durationTicks;
      const onAbsTick = toBluetoothTick(onRelScoreTick, ppq, beatType) + tickOffset;
      const offAbsTick = toBluetoothTick(offRelScoreTick, ppq, beatType) + tickOffset;

      // 检测非整数 tick
      const onExact = (onRelScoreTick * 32) / (ppq * (4 / beatType));
      const offExact = (offRelScoreTick * 32) / (ppq * (4 / beatType));
      if (!Number.isInteger(onExact) || !Number.isInteger(offExact)) {
        hasNonIntegerTick = true;
      }

      const onKey = `${onAbsTick}-on`;
      const offKey = `${offAbsTick}-off`;

      // NoteOn: bit7=1, 手指掩码 = 1 << (finger-1)
      const onMotorCtrl = 0x80 | (1 << (finger - 1));
      // NoteOff: bit7=0, 手指掩码 = 1 << (finger-1)
      const offMotorCtrl = 0x00 | (1 << (finger - 1));

      // OR 合并同 (absTick, isOn) 的手指
      const existingOn = commandMap.get(onKey);
      if (existingOn) {
        existingOn.motorCtrl |= onMotorCtrl;
      } else {
        commandMap.set(onKey, {
          absTick: onAbsTick,
          relTick: 0,
          motorCtrl: onMotorCtrl,
          isOn: true,
        });
      }

      const existingOff = commandMap.get(offKey);
      if (existingOff) {
        existingOff.motorCtrl |= offMotorCtrl;
      } else {
        commandMap.set(offKey, {
          absTick: offAbsTick,
          relTick: 0,
          motorCtrl: offMotorCtrl,
          isOn: false,
        });
      }
    }
  }

  // === 诊断日志：指法映射结果 ===
  console.log(`指法映射后（有效音符）: ${noteCount}`);
  console.log(`跳过音符（无指法）: ${skippedNotes}`);
  console.log(`fingerMap 大小: ${fingerMap.size}`);

  if (noteCount === 0) {
    return {
      data: '',
      noteCount: 0,
      instructionCount: 0,
      skippedNotes,
      patchedCount: 0,
      warnings: skippedNotes > 0 ? [`${skippedNotes} notes skipped (no fingering)`] : [],
    };
  }

  if (hasNonIntegerTick) {
    warnings.push('Some tick values were rounded (non-integer tick conversion)');
  }

  // 第四步：转换为数组并排序
  const commands = Array.from(commandMap.values());
  commands.sort((a, b) => {
    if (a.absTick !== b.absTick) return a.absTick - b.absTick;
    // 同 tick: Off (bit7=0) 排在 On (bit7=1) 前面
    return (a.motorCtrl & 0x80) - (b.motorCtrl & 0x80);
  });

  // === 诊断日志：指令生成（补丁前）===
  console.log(`生成指令数（含补丁前）: ${commands.length}`);
  console.log(`commandMap 大小: ${commandMap.size} (同 tick OR 合并后)`);
  console.log(`ticksPerBar: ${ticksPerBar}, ppq: ${ppq}, beatType: ${beatType}, beats: ${beats}`);
  if (commands.length > 0) {
    const maxAbsTick = Math.max(...commands.map((c) => c.absTick));
    const maxBar = Math.floor(maxAbsTick / ticksPerBar);
    console.log(`最大 absTick: ${maxAbsTick}, 跨越小节数: ${maxBar + 1}`);
  }

  // 第五步：空小节处理 — 为所有没有指令的小节插入占位空指令（必须在 applyPatch 前）
  const withEmptyMeasures = handleEmptyMeasures(commands, measureSequence.length, ticksPerBar);

  // 重新排序（空指令可能插入到中间）
  withEmptyMeasures.sort((a, b) => {
    if (a.absTick !== b.absTick) return a.absTick - b.absTick;
    return (a.motorCtrl & 0x80) - (b.motorCtrl & 0x80);
  });

  // 第六步：应用补丁（此时能看到完整的指令序列，包括空小节占位指令）
  const { result: patchedCommands, patchedCount, patchIterations } = applyPatch(withEmptyMeasures, ticksPerBar);

  // === 诊断日志：补丁后 ===
  console.log(`补丁插入对数: ${patchedCount}, 补丁迭代次数: ${patchIterations}`);
  console.log(`补丁后指令数: ${patchedCommands.length}`);

  // 第七步：格式化为输出字符串
  const outputParts: string[] = [];
  for (const cmd of patchedCommands) {
    outputParts.push(`${hex2(cmd.relTick)} ${hex2(cmd.motorCtrl)}`);
  }
  // 协议重构后：数据长度已在 WRITE_BEGIN 预声明，数据区不再追加结束标志

  // === 诊断日志：最终输出 ===
  console.log(`空小节+补丁处理后指令数: ${patchedCommands.length}`);
  console.log(`最终指令数: ${patchedCommands.length}`);
  console.log(`是否超过 SRAM 限制(32): ${patchedCommands.length > 32 ? '是 ⚠️' : '否'}`);
  console.log(`输出字节数: ${outputParts.length * 2} , 总 token 数: ${outputParts.length}`);
  if (warnings.length > 0) {
    console.log(`警告: ${warnings.join('; ')}`);
  }
  console.log('=== 诊断结束 ===');

  return {
    data: outputParts.join(' '),
    noteCount: noteCount,
    instructionCount: patchedCommands.length,
    skippedNotes,
    patchedCount,
    warnings,
  };
}
