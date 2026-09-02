import { describe, it, expect } from 'vitest';
import {
  crc16,
  encodeFrame,
  FrameParser,
  parseFramesStream,
  FRAME_FLAG,
  FRAME_ESC,
  FRAME_ESC_FLAG,
  FRAME_ESC_ESC,
  MAX_PAYLOAD,
} from './frame';

/** 编码一帧（不转义整个字节流，只做逻辑断言用）。 */
function decodeEncoded(encoded: Uint8Array): { seq: number; dst: number; cmd: number; payload: Uint8Array } {
  const parser = new FrameParser();
  const frames = parser.feed(encoded);
  expect(frames).toHaveLength(1);
  const f = frames[0];
  expect(f.valid).toBe(true);
  return { seq: f.seq, dst: f.dst, cmd: f.cmd, payload: f.payload };
}

describe('crc16 (CCITT-FALSE)', () => {
  it('produces expected values for known inputs', () => {
    // CRC-16/CCITT-FALSE 参考值：空数据 0xFFFF
    expect(crc16(new Uint8Array(0))).toBe(0xffff);
    // 123456789 -> 0x29B1（CCITT-FALSE 已知向量）
    expect(crc16(new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]))).toBe(0x29b1);
  });
});

describe('encodeFrame / decode round-trip', () => {
  it('round-trips a simple command frame', () => {
    const encoded = encodeFrame(0x12, 0x01, 0x10, new Uint8Array([0x00]));
    const decoded = decodeEncoded(encoded);
    expect(decoded.seq).toBe(0x12);
    expect(decoded.dst).toBe(0x01);
    expect(decoded.cmd).toBe(0x10);
    expect(Array.from(decoded.payload)).toEqual([0x00]);
  });

  it('round-trips a payload containing flag/escape bytes (byte stuffing)', () => {
    // payload 含 0x7E 和 0x7D，必须被正确转义
    const payload = new Uint8Array([0x7e, 0x7d, 0x01, 0x7e, 0x00, 0x7d]);
    const encoded = encodeFrame(0x01, 0x02, 0x21, payload);
    // 转义后：0x7E 只允许出现在帧首(index 0)；任何 0x7D 后面必须跟 0x5E/0x5D
    for (let i = 1; i < encoded.length; i++) {
      expect(encoded[i]).not.toBe(FRAME_FLAG);
      if (encoded[i] === FRAME_ESC) {
        const next = encoded[i + 1];
        expect(next === FRAME_ESC_FLAG || next === FRAME_ESC_ESC).toBe(true);
        i++; // 跳过转义后的真实字节
      }
    }
    const decoded = decodeEncoded(encoded);
    expect(Array.from(decoded.payload)).toEqual(Array.from(payload));
  });

  it('rejects payload longer than MAX_PAYLOAD', () => {
    expect(() => encodeFrame(0, 1, 0x21, new Uint8Array(MAX_PAYLOAD + 1))).toThrow();
  });
});

describe('FrameParser with fragmentation', () => {
  it('reassembles a frame split across multiple BLE writes', () => {
    const encoded = encodeFrame(0x05, 0x01, 0x20, new Uint8Array([0x01, 0x00, 0x02, 0x00]));
    const chunks = [
      encoded.subarray(0, 3),
      encoded.subarray(3, 8),
      encoded.subarray(8),
    ];
    const frames = parseFramesStream(chunks);
    expect(frames).toHaveLength(1);
    expect(frames[0].valid).toBe(true);
    expect(frames[0].cmd).toBe(0x20);
  });

  it('handles multiple frames in one stream', () => {
    const f1 = encodeFrame(0x01, 0x01, 0x10, new Uint8Array([0x00]));
    const f2 = encodeFrame(0x02, 0x01, 0x82, new Uint8Array([0x00]));
    const frames = parseFramesStream([Uint8Array.from([...f1, ...f2])]);
    expect(frames).toHaveLength(2);
    expect(frames[0].cmd).toBe(0x10);
    expect(frames[1].cmd).toBe(0x82);
  });

  it('recovers from a corrupted byte in the middle (CRC fail -> next frame ok)', () => {
    const f1 = encodeFrame(0x01, 0x01, 0x10, new Uint8Array([0x00]));
    const f2 = encodeFrame(0x02, 0x01, 0x82, new Uint8Array([0x00]));
    // 破坏 f1 的 payload
    const corrupted = Uint8Array.from(f1);
    corrupted[6] ^= 0xff;
    const stream = Uint8Array.from([...corrupted, ...f2]);
    const frames = parseFramesStream([stream]);
    // 损坏帧被丢弃（valid=false 不产出），随后帧被正确解析
    expect(frames).toHaveLength(1);
    expect(frames[0].cmd).toBe(0x82);
    expect(frames[0].valid).toBe(true);
  });
});

describe('byte stuffing consistency with firmware constants', () => {
  it('exposes the escaping mapping', () => {
    // 与固件宏保持一致：0x7E -> 0x7D 0x5E, 0x7D -> 0x7D 0x5D
    expect(FRAME_ESC_FLAG).toBe(0x5e);
    expect(FRAME_ESC_ESC).toBe(0x5d);
    expect(FRAME_FLAG).toBe(0x7e);
    expect(FRAME_ESC).toBe(0x7d);
  });
});
