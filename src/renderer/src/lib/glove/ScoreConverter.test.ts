import { describe, it, expect } from 'vitest';
import { convertScoreToGloveCommands, parseRange } from './ScoreConverter';
import type { Score, Note, Annotation, Finger } from '../../types';

/** 构造简单的 C 大调右手乐谱（4/4，每拍 480 ticks）。 */
function createCmajorScore(): Score {
  const ppq = 480;
  const quarterTicks = ppq; // 1 拍 = 480 ticks

  const notes: Note[] = [
    {
      id: 'P1-M1-N0',
      partId: 'P1',
      measureNumber: 1,
      noteIndex: 0,
      pitch: { step: 'C', octave: 4 },
      midiNumber: 60,
      duration: 1,
      startTick: 0,
      durationTicks: quarterTicks,
      startSeconds: 0,
      durationSeconds: 0.5,
      voice: 1,
      isChord: false,
      isRest: false,
      staff: 1,
      hand: 'right',
    },
    {
      id: 'P1-M1-N1',
      partId: 'P1',
      measureNumber: 1,
      noteIndex: 1,
      pitch: { step: 'E', octave: 4 },
      midiNumber: 64,
      duration: 1,
      startTick: quarterTicks,
      durationTicks: quarterTicks,
      startSeconds: 0.5,
      durationSeconds: 0.5,
      voice: 1,
      isChord: false,
      isRest: false,
      staff: 1,
      hand: 'right',
    },
    {
      id: 'P1-M1-N2',
      partId: 'P1',
      measureNumber: 1,
      noteIndex: 2,
      pitch: { step: 'G', octave: 4 },
      midiNumber: 67,
      duration: 1,
      startTick: quarterTicks * 2,
      durationTicks: quarterTicks,
      startSeconds: 1.0,
      durationSeconds: 0.5,
      voice: 1,
      isChord: false,
      isRest: false,
      staff: 1,
      hand: 'right',
    },
    {
      id: 'P1-M1-N3',
      partId: 'P1',
      measureNumber: 1,
      noteIndex: 3,
      pitch: { step: 'C', octave: 5 },
      midiNumber: 72,
      duration: 1,
      startTick: quarterTicks * 3,
      durationTicks: quarterTicks,
      startSeconds: 1.5,
      durationSeconds: 0.5,
      voice: 1,
      isChord: false,
      isRest: false,
      staff: 1,
      hand: 'right',
    },
  ];

  return {
    title: 'C Major',
    parts: [
      { id: 'P1', name: 'Right Hand', hand: 'right', clef: 'treble' },
    ],
    measures: [
      { number: 1, startTick: 0, notes },
    ],
    tempo: 120,
    ticksPerQuarter: ppq,
    tempoMap: [{ tick: 0, bpm: 120 }],
    timeSignature: { beats: 4, beatType: 4 },
    keySignature: 0,
    pedalSpans: [],
  };
}

/** C 大调指法（右手）：C4=拇指, E4=食指, G4=中指, C5=小指。 */
function createCmajorAnnotations(): Annotation[] {
  return [
    { noteId: 'P1-M1-N0', fingerNumber: 1 as Finger, isAISuggested: true, isApproved: false },
    { noteId: 'P1-M1-N1', fingerNumber: 2 as Finger, isAISuggested: true, isApproved: false },
    { noteId: 'P1-M1-N2', fingerNumber: 3 as Finger, isAISuggested: true, isApproved: false },
    { noteId: 'P1-M1-N3', fingerNumber: 5 as Finger, isAISuggested: true, isApproved: false },
  ];
}

describe('ScoreConverter', () => {
  describe('convertScoreToGloveCommands', () => {
    it('应将 C 大调转换为正确的蓝牙指令', () => {
      const score = createCmajorScore();
      const annotations = createCmajorAnnotations();

      const result = convertScoreToGloveCommands(score, annotations, 'right');

      // 4 个音符，每个生成 2 条指令（On + Off），共 8 条
      // 弱起小节处理：第 1 小节末尾(absTick=96) < 127，插入 1 条空指令 → 9 条
      expect(result.noteCount).toBe(4);
      expect(result.instructionCount).toBe(9);
      expect(result.skippedNotes).toBe(0);

      // 预期输出（同 tick Off 在前，On 在后）：
      // 00 81  C4 On (abs=0, rel=0)
      // 20 01  C4 Off (abs=32, rel=32) ← 同 tick Off
      // 20 82  E4 On (abs=32, rel=32)  ← 同 tick On
      // 40 02  E4 Off (abs=64, rel=64)
      // 40 84  G4 On (abs=64, rel=64)
      // 60 04  G4 Off (abs=96, rel=96)
      // 60 90  C5 On (abs=96, rel=96)
      // 7F 00  弱起小节空指令 (abs=127, rel=127)
      // 00 10  C5 Off (abs=128, rel=0) ← 第 2 小节 relTick 重新从 0 开始
      // FF 00  结束标志
      const expected = [
        '00 81', // C4 On
        '20 01', // C4 Off
        '20 82', // E4 On
        '40 02', // E4 Off
        '40 84', // G4 On
        '60 04', // G4 Off
        '60 90', // C5 On
        '7F 00', // 弱起小节空指令
        '00 10', // C5 Off (relTick = 128 % 128 = 0)
        'FF 00', // 结束
      ].join(' ');

      expect(result.data).toBe(expected);
    });

    it('跳过无指法的音符', () => {
      const score = createCmajorScore();
      // 只给第一个音符加指法
      const annotations: Annotation[] = [
        { noteId: 'P1-M1-N0', fingerNumber: 1 as Finger, isAISuggested: true, isApproved: false },
      ];

      const result = convertScoreToGloveCommands(score, annotations, 'right');

      expect(result.noteCount).toBe(1);
      expect(result.skippedNotes).toBe(3);
      // 只有 C4 的 2 条指令 + 弱起小节空指令 1 条 = 3 条
      expect(result.instructionCount).toBe(3);
    });

    it('空乐谱返回只有结束标志', () => {
      const score: Score = {
        title: 'Empty',
        parts: [],
        measures: [],
        tempo: 120,
        ticksPerQuarter: 480,
        tempoMap: [{ tick: 0, bpm: 120 }],
        timeSignature: { beats: 4, beatType: 4 },
        keySignature: 0,
        pedalSpans: [],
      };

      const result = convertScoreToGloveCommands(score, [], 'right');

      expect(result.data).toBe('FF 00');
      expect(result.noteCount).toBe(0);
      expect(result.instructionCount).toBe(0);
    });

    it('左手曲目过滤右手音符', () => {
      const score = createCmajorScore(); // 全部是右手

      const result = convertScoreToGloveCommands(score, createCmajorAnnotations(), 'left');

      expect(result.noteCount).toBe(0);
      expect(result.data).toBe('FF 00');
    });

    it('同 tick 多手指应 OR 合并', () => {
      // 两个音符在同一 tick（和弦）
      const score: Score = {
        ...createCmajorScore(),
        measures: [
          {
            number: 1,
            startTick: 0,
            notes: [
              {
                id: 'P1-M1-N0',
                partId: 'P1',
                measureNumber: 1,
                noteIndex: 0,
                pitch: { step: 'C', octave: 4 },
                midiNumber: 60,
                duration: 0.5,
                startTick: 0,
                durationTicks: 240,
                startSeconds: 0,
                durationSeconds: 0.25,
                voice: 1,
                isChord: true,
                isRest: false,
                staff: 1,
                hand: 'right',
              },
              {
                id: 'P1-M1-N1',
                partId: 'P1',
                measureNumber: 1,
                noteIndex: 1,
                pitch: { step: 'G', octave: 4 },
                midiNumber: 67,
                duration: 0.5,
                startTick: 0,
                durationTicks: 240,
                startSeconds: 0,
                durationSeconds: 0.25,
                voice: 1,
                isChord: true,
                isRest: false,
                staff: 1,
                hand: 'right',
              },
            ],
          },
        ],
      };

      const annotations: Annotation[] = [
        { noteId: 'P1-M1-N0', fingerNumber: 1 as Finger, isAISuggested: true, isApproved: false },
        { noteId: 'P1-M1-N1', fingerNumber: 5 as Finger, isAISuggested: true, isApproved: false },
      ];

      const result = convertScoreToGloveCommands(score, annotations, 'right');

      // C4 (finger=1) → motorCtrl = 0x80 | 0x01 = 0x81
      // G4 (finger=5) → motorCtrl = 0x80 | 0x10 = 0x90
      // OR 合并: 0x81 | 0x90 = 0x91, Off: 0x01 | 0x10 = 0x11
      // 同 tick 的 On 合并为 1 条，Off 合并为 1 条，共 2 条
      // 弱起小节处理：第 1 小节末尾(absTick=16) < 127，插入 1 条空指令 → 3 条
      expect(result.instructionCount).toBe(3);
      expect(result.data).toContain('91'); // 合并后的 On (0x81 | 0x90)
      expect(result.data).toContain('11'); // 合并后的 Off (0x01 | 0x10)
    });
  });

  describe('applyPatch', () => {
    it('空小节由 handleEmptyMeasures 处理，applyPatch 不需要补丁', () => {
      // 构造一个跨 2 小节的场景：
      // 第 1 小节末尾有音符，第 2 小节空，第 3 小节中间有音符
      // handleEmptyMeasures 会为空小节 2 插入占位指令，applyPatch 不需要再补丁
      const ppq = 480;
      const quarterTicks = ppq;

      const score: Score = {
        ...createCmajorScore(),
        measures: [
          {
            number: 1,
            startTick: 0,
            notes: [
              {
                id: 'P1-M1-N0',
                partId: 'P1',
                measureNumber: 1,
                noteIndex: 0,
                pitch: { step: 'B', octave: 4 },
                midiNumber: 71,
                duration: 0.25,
                startTick: quarterTicks * 3, // 第 1 小节最后一拍
                durationTicks: quarterTicks / 2, // 0.5 拍
                startSeconds: 1.5,
                durationSeconds: 0.25,
                voice: 1,
                isChord: false,
                isRest: false,
                staff: 1,
                hand: 'right',
              },
            ],
          },
          {
            number: 2,
            startTick: quarterTicks * 4,
            notes: [], // 第 2 小节空
          },
          {
            number: 3,
            startTick: quarterTicks * 8,
            notes: [
              {
                id: 'P1-M3-N0',
                partId: 'P1',
                measureNumber: 3,
                noteIndex: 0,
                pitch: { step: 'C', octave: 5 },
                midiNumber: 72,
                duration: 1,
                startTick: quarterTicks * 9, // 第 3 小节第 2 拍
                durationTicks: quarterTicks,
                startSeconds: 4.5,
                durationSeconds: 0.5,
                voice: 1,
                isChord: false,
                isRest: false,
                staff: 1,
                hand: 'right',
              },
            ],
          },
        ],
      };

      const annotations: Annotation[] = [
        { noteId: 'P1-M1-N0', fingerNumber: 4 as Finger, isAISuggested: true, isApproved: false },
        { noteId: 'P1-M3-N0', fingerNumber: 5 as Finger, isAISuggested: true, isApproved: false },
      ];

      const result = convertScoreToGloveCommands(score, annotations, 'right');

      // handleEmptyMeasures 为空小节 2 插入占位指令（tick=0 和 tick=127）
      // applyPatch 看到完整序列后，relTick 已递减，不需要补丁
      expect(result.patchedCount).toBe(0);

      // 验证补丁后 relTick 不会有递减（除了小节边界）
      // 跳过 FF 00 结束标志
      const dataParts = result.data.replace('FF 00', '').trim().split(/\s+/);
      const commands: { rel: number; ctrl: number }[] = [];
      for (let i = 0; i < dataParts.length - 1; i += 2) {
        const rel = parseInt(dataParts[i], 16);
        const ctrl = parseInt(dataParts[i + 1], 16);
        commands.push({ rel, ctrl });
      }

      // 验证所有指令的 relTick 在 0~127 范围内（ticksPerBar=128）
      for (const cmd of commands) {
        expect(cmd.rel).toBeGreaterThanOrEqual(0);
        expect(cmd.rel).toBeLessThan(128);
      }
    });

    it('相邻小节且相对 tick 递减不需要补丁', () => {
      // 场景：第 1 小节末尾音符 → 第 2 小节开头音符
      // 固件能正确处理这种情况
      const ppq = 480;

      const score: Score = {
        ...createCmajorScore(),
        measures: [
          {
            number: 1,
            startTick: 0,
            notes: [
              {
                id: 'P1-M1-N0',
                partId: 'P1',
                measureNumber: 1,
                noteIndex: 0,
                pitch: { step: 'B', octave: 4 },
                midiNumber: 71,
                duration: 0.25,
                startTick: ppq * 3.5, // 第 1 小节最后半拍
                durationTicks: ppq / 4,
                startSeconds: 1.75,
                durationSeconds: 0.125,
                voice: 1,
                isChord: false,
                isRest: false,
                staff: 1,
                hand: 'right',
              },
            ],
          },
          {
            number: 2,
            startTick: ppq * 4,
            notes: [
              {
                id: 'P1-M2-N0',
                partId: 'P1',
                measureNumber: 2,
                noteIndex: 0,
                pitch: { step: 'C', octave: 5 },
                midiNumber: 72,
                duration: 0.25,
                startTick: ppq * 4, // 第 2 小节第一拍
                durationTicks: ppq / 4,
                startSeconds: 2.0,
                durationSeconds: 0.125,
                voice: 1,
                isChord: false,
                isRest: false,
                staff: 1,
                hand: 'right',
              },
            ],
          },
        ],
      };

      const annotations: Annotation[] = [
        { noteId: 'P1-M1-N0', fingerNumber: 4 as Finger, isAISuggested: true, isApproved: false },
        { noteId: 'P1-M2-N0', fingerNumber: 5 as Finger, isAISuggested: true, isApproved: false },
      ];

      const result = convertScoreToGloveCommands(score, annotations, 'right');

      // B4 Off 在 absTick ≈ 116, C5 On 在 absTick ≈ 128
      // B4 Off: bar=0, rel≈116
      // C5 On: bar=1, rel≈0
      // currRel(116) > nextRel(0), 相邻小节，固件能处理
      expect(result.patchedCount).toBe(0);
    });
  });

  describe('空小节处理 (handleEmptyMeasures)', () => {
    it('第一小节有音符但末尾无指令时，应在 ticksPerBar-1 插入空指令', () => {
      // 场景：4/4 拍，第一小节只在第 1 拍有音符（tick=0），末尾没有指令
      const ppq = 480;

      const score: Score = {
        ...createCmajorScore(),
        measures: [
          {
            number: 1,
            startTick: 0,
            notes: [
              {
                id: 'P1-M1-N0',
                partId: 'P1',
                measureNumber: 1,
                noteIndex: 0,
                pitch: { step: 'C', octave: 4 },
                midiNumber: 60,
                duration: 0.5,
                startTick: 0,
                durationTicks: ppq / 2, // 半拍
                startSeconds: 0,
                durationSeconds: 0.25,
                voice: 1,
                isChord: false,
                isRest: false,
                staff: 1,
                hand: 'right',
              },
            ],
          },
          {
            number: 2,
            startTick: ppq * 4,
            notes: [
              {
                id: 'P1-M2-N0',
                partId: 'P1',
                measureNumber: 2,
                noteIndex: 0,
                pitch: { step: 'E', octave: 4 },
                midiNumber: 64,
                duration: 0.5,
                startTick: ppq * 4, // 第 2 小节第 1 拍
                durationTicks: ppq / 2,
                startSeconds: 2.0,
                durationSeconds: 0.25,
                voice: 1,
                isChord: false,
                isRest: false,
                staff: 1,
                hand: 'right',
              },
            ],
          },
        ],
      };

      const annotations: Annotation[] = [
        { noteId: 'P1-M1-N0', fingerNumber: 1 as Finger, isAISuggested: true, isApproved: false },
        { noteId: 'P1-M2-N0', fingerNumber: 2 as Finger, isAISuggested: true, isApproved: false },
      ];

      const result = convertScoreToGloveCommands(score, annotations, 'right');

      // ticksPerBar = 32 * 4 = 128
      // 预期在 relTick=127 (0x7F) 处有空指令 motorCtrl=0x00
      const dataParts = result.data.replace(' FF 00', '').trim().split(/\s+/);
      const commands: { rel: number; ctrl: number }[] = [];
      for (let i = 0; i < dataParts.length - 1; i += 2) {
        commands.push({
          rel: parseInt(dataParts[i], 16),
          ctrl: parseInt(dataParts[i + 1], 16),
        });
      }

      // 应包含 relTick=127, motorCtrl=0x00 的空指令
      const hasEndMarker = commands.some(
        (cmd) => cmd.rel === 127 && cmd.ctrl === 0x00
      );
      expect(hasEndMarker).toBe(true);
    });

    it('第一小节整小节休止时，应插入 tick=0 和 tick=127 两条空指令', () => {
      // 场景：弱起小节，左手在第 1 小节完全休止，从第 2 小节开始
      const ppq = 480;

      const score: Score = {
        ...createCmajorScore(),
        measures: [
          {
            number: 1,
            startTick: 0,
            notes: [], // 第 1 小节完全空（整小节休止）
          },
          {
            number: 2,
            startTick: ppq * 4,
            notes: [
              {
                id: 'P1-M2-N0',
                partId: 'P1',
                measureNumber: 2,
                noteIndex: 0,
                pitch: { step: 'C', octave: 3 },
                midiNumber: 48,
                duration: 1,
                startTick: ppq * 4,
                durationTicks: ppq,
                startSeconds: 2.0,
                durationSeconds: 0.5,
                voice: 1,
                isChord: false,
                isRest: false,
                staff: 2,
                hand: 'left',
              },
            ],
          },
        ],
      };

      const annotations: Annotation[] = [
        { noteId: 'P1-M2-N0', fingerNumber: 1 as Finger, isAISuggested: true, isApproved: false },
      ];

      const result = convertScoreToGloveCommands(score, annotations, 'left');

      // ticksPerBar = 128
      // 预期指令序列包含：
      // 00 00 (tick=0 空指令)
      // 7F 00 (tick=127 空指令)
      // 00 81 (第 2 小节 C3 On, finger=1, motorCtrl=0x80|0x01=0x81)
      // ...
      const dataParts = result.data.replace(' FF 00', '').trim().split(/\s+/);
      const commands: { rel: number; ctrl: number }[] = [];
      for (let i = 0; i < dataParts.length - 1; i += 2) {
        commands.push({
          rel: parseInt(dataParts[i], 16),
          ctrl: parseInt(dataParts[i + 1], 16),
        });
      }

      // 第 1 条应为 tick=0 空指令
      expect(commands[0].rel).toBe(0);
      expect(commands[0].ctrl).toBe(0x00);

      // 应包含 tick=127 空指令
      const has127 = commands.some(
        (cmd) => cmd.rel === 127 && cmd.ctrl === 0x00
      );
      expect(has127).toBe(true);

      // 跨小节检测：127 → 0 递减，固件能正确触发
      const idx127 = commands.findIndex((cmd) => cmd.rel === 127 && cmd.ctrl === 0x00);
      if (idx127 >= 0 && idx127 + 1 < commands.length) {
        expect(commands[idx127 + 1].rel).toBeLessThan(commands[idx127].rel);
      }
    });

    it('第一小节末尾已有音符时不重复插入空指令', () => {
      // 场景：第一小节最后一条指令正好在 tick=127
      // 使用 createCmajorScore 的 C 大调，但调整音符位置
      const score = createCmajorScore();
      const annotations = createCmajorAnnotations();

      const result = convertScoreToGloveCommands(score, annotations, 'right');

      // C 大调测试中，最后一条指令是 C5 Off 在 absTick=128 (relTick=0，第 2 小节)
      // 第 1 小节最后一条是 C5 On 在 absTick=96 (relTick=96)
      // 96 < 127，所以应该插入 127 空指令
      const dataParts = result.data.replace(' FF 00', '').trim().split(/\s+/);
      const commands: { rel: number; ctrl: number }[] = [];
      for (let i = 0; i < dataParts.length - 1; i += 2) {
        commands.push({
          rel: parseInt(dataParts[i], 16),
          ctrl: parseInt(dataParts[i + 1], 16),
        });
      }

      // 应只有一条 relTick=127 的指令（不重复）
      const count127 = commands.filter((cmd) => cmd.rel === 127).length;
      expect(count127).toBeLessThanOrEqual(1);
    });

    it('中间小节为空时，应插入 tick=0 和 tick=127 占位指令', () => {
      // 场景：3 小节，第 2 小节完全空（目标手无音符）
      const ppq = 480;

      const score: Score = {
        ...createCmajorScore(),
        measures: [
          {
            number: 1,
            startTick: 0,
            notes: [
              {
                id: 'P1-M1-N0',
                partId: 'P1',
                measureNumber: 1,
                noteIndex: 0,
                pitch: { step: 'C', octave: 4 },
                midiNumber: 60,
                duration: 1,
                startTick: 0,
                durationTicks: ppq,
                startSeconds: 0,
                durationSeconds: 0.5,
                voice: 1,
                isChord: false,
                isRest: false,
                staff: 1,
                hand: 'right',
              },
            ],
          },
          {
            number: 2,
            startTick: ppq * 4,
            notes: [], // 第 2 小节完全空
          },
          {
            number: 3,
            startTick: ppq * 8,
            notes: [
              {
                id: 'P1-M3-N0',
                partId: 'P1',
                measureNumber: 3,
                noteIndex: 0,
                pitch: { step: 'G', octave: 4 },
                midiNumber: 67,
                duration: 1,
                startTick: ppq * 8,
                durationTicks: ppq,
                startSeconds: 4,
                durationSeconds: 0.5,
                voice: 1,
                isChord: false,
                isRest: false,
                staff: 1,
                hand: 'right',
              },
            ],
          },
        ],
      };

      const annotations: Annotation[] = [
        { noteId: 'P1-M1-N0', fingerNumber: 1 as Finger, isAISuggested: true, isApproved: false },
        { noteId: 'P1-M3-N0', fingerNumber: 3 as Finger, isAISuggested: true, isApproved: false },
      ];

      const result = convertScoreToGloveCommands(score, annotations, 'right');

      // 解析输出
      const dataParts = result.data.replace(' FF 00', '').trim().split(/\s+/);
      const commands: { rel: number; ctrl: number }[] = [];
      for (let i = 0; i < dataParts.length - 1; i += 2) {
        commands.push({
          rel: parseInt(dataParts[i], 16),
          ctrl: parseInt(dataParts[i + 1], 16),
        });
      }

      // 第 2 小节（segment index=1）应插入 tick=0 和 tick=127 的空指令
      // segment 1 对应 absTick 128~255，relTick 分别为 0 和 127
      const hasEmptyStart = commands.some((cmd) => cmd.rel === 0 && cmd.ctrl === 0x00);
      const hasEmptyEnd = commands.some((cmd) => cmd.rel === 127 && cmd.ctrl === 0x00);
      expect(hasEmptyStart).toBe(true);
      expect(hasEmptyEnd).toBe(true);

      // 验证所有 relTick 在 0~127 范围内
      for (const cmd of commands) {
        expect(cmd.rel).toBeGreaterThanOrEqual(0);
        expect(cmd.rel).toBeLessThan(128);
      }
    });
  });

  describe('parseRange', () => {
    it('空字符串返回空数组', () => {
      expect(parseRange('')).toEqual([]);
      expect(parseRange('   ')).toEqual([]);
    });

    it('单个小节号', () => {
      expect(parseRange('1')).toEqual([1]);
      expect(parseRange('9')).toEqual([9]);
    });

    it('范围 1-3 → [1, 2, 3]', () => {
      expect(parseRange('1-3')).toEqual([1, 2, 3]);
    });

    it('逗号分隔 1-3, 5-7 → [1, 2, 3, 5, 6, 7]', () => {
      expect(parseRange('1-3, 5-7')).toEqual([1, 2, 3, 5, 6, 7]);
    });

    it('支持重复 1-3, 1-3 → [1, 2, 3, 1, 2, 3]', () => {
      expect(parseRange('1-3, 1-3')).toEqual([1, 2, 3, 1, 2, 3]);
    });

    it('混合格式 1-3, 5-7, 9 → [1, 2, 3, 5, 6, 7, 9]', () => {
      expect(parseRange('1-3, 5-7, 9')).toEqual([1, 2, 3, 5, 6, 7, 9]);
    });

    it('允许空格', () => {
      expect(parseRange(' 1 - 3 , 5 ')).toEqual([1, 2, 3, 5]);
    });

    it('允许尾逗号', () => {
      expect(parseRange('1-3,')).toEqual([1, 2, 3]);
    });

    it('无效输入抛出错误', () => {
      expect(() => parseRange('abc')).toThrow();
      expect(() => parseRange('0-3')).toThrow();
      expect(() => parseRange('3-1')).toThrow();
      expect(() => parseRange('1--3')).toThrow();
    });
  });

  describe('范围过滤 (convertScoreToGloveCommands with range)', () => {
    /** 构造 4 小节右手乐谱，每小节 1 个音符（C4, E4, G4, C5）。 */
    function createMultiMeasureScore(): Score {
      const ppq = 480;
      const quarterTicks = ppq;
      const notesData = [
        { id: 'P1-M1-N0', step: 'C', octave: 4, midi: 60, finger: 1 as Finger },
        { id: 'P1-M2-N0', step: 'E', octave: 4, midi: 64, finger: 2 as Finger },
        { id: 'P1-M3-N0', step: 'G', octave: 4, midi: 67, finger: 3 as Finger },
        { id: 'P1-M4-N0', step: 'C', octave: 5, midi: 72, finger: 5 as Finger },
      ];

      const measures = notesData.map((nd, i) => ({
        number: i + 1,
        startTick: i * quarterTicks * 4,
        notes: [
          {
            id: nd.id,
            partId: 'P1',
            measureNumber: i + 1,
            noteIndex: 0,
            pitch: { step: nd.step, octave: nd.octave },
            midiNumber: nd.midi,
            duration: 1,
            startTick: i * quarterTicks * 4,
            durationTicks: quarterTicks,
            startSeconds: i * 2,
            durationSeconds: 0.5,
            voice: 1,
            isChord: false,
            isRest: false,
            staff: 1,
            hand: 'right' as const,
          },
        ],
      }));

      const annotations: Annotation[] = notesData.map((nd) => ({
        noteId: nd.id,
        fingerNumber: nd.finger,
        isAISuggested: true,
        isApproved: false,
      }));

      return {
        title: 'Multi Measure',
        parts: [{ id: 'P1', name: 'Right Hand', hand: 'right' as const, clef: 'treble' }],
        measures,
        tempo: 120,
        ticksPerQuarter: ppq,
        tempoMap: [{ tick: 0, bpm: 120 }],
        timeSignature: { beats: 4, beatType: 4 },
        keySignature: 0,
        pedalSpans: [],
      };
    }

    function getAnnotationsForMultiMeasure(): Annotation[] {
      return [
        { noteId: 'P1-M1-N0', fingerNumber: 1 as Finger, isAISuggested: true, isApproved: false },
        { noteId: 'P1-M2-N0', fingerNumber: 2 as Finger, isAISuggested: true, isApproved: false },
        { noteId: 'P1-M3-N0', fingerNumber: 3 as Finger, isAISuggested: true, isApproved: false },
        { noteId: 'P1-M4-N0', fingerNumber: 5 as Finger, isAISuggested: true, isApproved: false },
      ];
    }

    it('留空范围转换所有小节', () => {
      const score = createMultiMeasureScore();
      const annotations = getAnnotationsForMultiMeasure();

      const result = convertScoreToGloveCommands(score, annotations, 'right');

      // 4 个音符 × 2 (On+Off) = 8 条 + 弱起空指令 1 条 = 9 条
      expect(result.noteCount).toBe(4);
      expect(result.instructionCount).toBe(9);
    });

    it('范围 1-2 只转换前两个小节', () => {
      const score = createMultiMeasureScore();
      const annotations = getAnnotationsForMultiMeasure();

      const result = convertScoreToGloveCommands(score, annotations, 'right', '1-2');

      // 2 个音符 × 2 = 4 条 + 弱起空指令 1 条 = 5 条
      expect(result.noteCount).toBe(2);
      expect(result.instructionCount).toBe(5);
    });

    it('范围 1-2, 4 跳过第3小节', () => {
      const score = createMultiMeasureScore();
      const annotations = getAnnotationsForMultiMeasure();

      const result = convertScoreToGloveCommands(score, annotations, 'right', '1-2, 4');

      // 3 个音符 × 2 = 6 条 + 弱起空指令 1 条 = 7 条
      expect(result.noteCount).toBe(3);
      expect(result.instructionCount).toBe(7);
    });

    it('范围 1-2, 1-2 重复前两小节（tick 偏移）', () => {
      const score = createMultiMeasureScore();
      const annotations = getAnnotationsForMultiMeasure();

      const result = convertScoreToGloveCommands(score, annotations, 'right', '1-2, 1-2');

      // 4 个音符 × 2 = 8 条 + 弱起空指令 1 条 = 9 条
      expect(result.noteCount).toBe(4);
      expect(result.instructionCount).toBe(9);

      // 验证 tick 偏移：第二次的小节1 On 应在 absTick = 2 * ticksPerBar = 256
      // 而不是 absTick = 0（如果没偏移，会与第一次的 On OR 合并）
      const dataParts = result.data.replace(' FF 00', '').trim().split(/\s+/);
      // 9 条指令 × 2 字节 = 18 个 hex token
      expect(dataParts.length).toBe(18);
    });

    it('无效范围返回警告', () => {
      const score = createMultiMeasureScore();
      const annotations = getAnnotationsForMultiMeasure();

      const result = convertScoreToGloveCommands(score, annotations, 'right', 'abc');

      expect(result.noteCount).toBe(0);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.data).toBe('FF 00');
    });

    it('不存在的小节号跳过并添加警告', () => {
      const score = createMultiMeasureScore();
      const annotations = getAnnotationsForMultiMeasure();

      const result = convertScoreToGloveCommands(score, annotations, 'right', '1-2, 99');

      // 小节 99 不存在，跳过；实际只有小节 1、2 的 2 个音符
      expect(result.noteCount).toBe(2);
      expect(result.warnings.some((w) => w.includes('99'))).toBe(true);
    });
  });
});
