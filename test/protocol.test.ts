import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AdtsFramer,
  buildPacket,
  buildRtpHeader,
  ControlPacketBuffer,
  crc16,
  extractAdtsFrames,
  PacketType,
  parsePacket,
  RTP_PAYLOAD_TYPE,
} from '../src/protocol.js';

/** A fake ADTS frame of the given total length (header + zero payload). */
function adtsFrame(length: number, fill = 0): Buffer {
  const frame = Buffer.alloc(length, fill);
  frame[0] = 0xff;
  frame[1] = 0xf1;
  frame[2] = 0x60;
  frame[3] = 0x40 | ((length >> 11) & 0x03);
  frame[4] = (length >> 3) & 0xff;
  frame[5] = ((length & 0x07) << 5) | 0x1f;
  frame[6] = 0xfc;
  return frame;
}

describe('crc16', () => {
  it('matches the check value for "123456789"', () => {
    assert.equal(crc16(Buffer.from('123456789')), 0x906e);
  });

  it('is 0 for no data', () => {
    assert.equal(crc16(Buffer.alloc(0)), 0x0000);
  });
});

describe('control packets', () => {
  it('builds the documented layout for a start-voice packet', () => {
    const packet = buildPacket(PacketType.StartVoice, 0x0102030405060708n);
    assert.deepEqual([...packet.subarray(0, 5)], [0xfe, 0xef, 0x00, 0x00, 0x08]);
    assert.deepEqual([...packet.subarray(5, 13)], [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(packet.length, 15);
    assert.equal(packet.readUInt16BE(13), crc16(packet.subarray(2, 13)));
  });

  it('gives an ack a one-byte payload', () => {
    const packet = buildPacket(PacketType.Ack, 0);
    assert.equal(packet.length, 8);
    assert.equal(packet.readUInt16BE(3), 1);
  });

  it('round-trips every type', () => {
    for (const [type, value] of [
      [PacketType.StartVoice, 1_700_000_000_000n],
      [PacketType.StopVoice, 42n],
      [PacketType.Heartbeat, 0n],
      [PacketType.Ack, 3n],
    ] as const) {
      assert.deepEqual(parsePacket(buildPacket(type, value)), { type, value });
    }
  });

  it('rejects a bad CRC, a bad magic, an unknown type and a short packet', () => {
    const good = buildPacket(PacketType.Heartbeat, 7);
    const badCrc = Buffer.from(good);
    badCrc[badCrc.length - 1] ^= 0xff;
    assert.equal(parsePacket(badCrc), undefined);

    const badMagic = Buffer.from(good);
    badMagic[0] = 0x00;
    assert.equal(parsePacket(badMagic), undefined);

    const unknownType = Buffer.from(good);
    unknownType[2] = 9;
    assert.equal(parsePacket(unknownType), undefined);

    assert.equal(parsePacket(good.subarray(0, 7)), undefined);
  });
});

describe('ControlPacketBuffer', () => {
  it('reassembles a packet split across reads', () => {
    const buffer = new ControlPacketBuffer();
    const ack = buildPacket(PacketType.Ack, 0);
    for (const byte of ack.subarray(0, -1)) {
      buffer.feed(Buffer.from([byte]));
      assert.equal(buffer.pop(), undefined);
    }
    buffer.feed(ack.subarray(-1));
    assert.deepEqual(buffer.pop(), { type: PacketType.Ack, value: 0n });
    assert.equal(buffer.length, 0);
  });

  it('splits packets that arrive together', () => {
    const buffer = new ControlPacketBuffer();
    buffer.feed(Buffer.concat([buildPacket(PacketType.Heartbeat, 7), buildPacket(PacketType.Ack, 1)]));
    assert.deepEqual(buffer.pop(), { type: PacketType.Heartbeat, value: 7n });
    assert.deepEqual(buffer.pop(), { type: PacketType.Ack, value: 1n });
    assert.equal(buffer.pop(), undefined);
  });

  it('skips garbage and corrupt packets', () => {
    const buffer = new ControlPacketBuffer();
    const corrupt = buildPacket(PacketType.Ack, 0);
    corrupt[corrupt.length - 1] ^= 0xff;
    buffer.feed(Buffer.concat([Buffer.from([0x01, 0x02]), corrupt, buildPacket(PacketType.Ack, 3)]));
    assert.deepEqual(buffer.pop(), { type: PacketType.Ack, value: 3n });
  });

  it('drops a header that claims an impossible length', () => {
    const buffer = new ControlPacketBuffer();
    buffer.feed(Buffer.from([0xfe, 0xef, 0x02, 0xff, 0xff]));
    buffer.feed(buildPacket(PacketType.Ack, 5));
    assert.deepEqual(buffer.pop(), { type: PacketType.Ack, value: 5n });
  });
});

describe('buildRtpHeader', () => {
  it('writes version, payload type, sequence, timestamp and SSRC', () => {
    const header = buildRtpHeader(RTP_PAYLOAD_TYPE, 0xabcd, 0x12345678, 0x4242);
    assert.equal(header.length, 12);
    assert.equal(header[0], 0x80);
    assert.equal(header[1], RTP_PAYLOAD_TYPE);
    assert.equal(header.readUInt16BE(2), 0x4242);
    assert.equal(header.readUInt32BE(4), 0xabcd);
    assert.equal(header.readUInt32BE(8), 0x12345678);
  });

  it('wraps the sequence and timestamp', () => {
    const header = buildRtpHeader(RTP_PAYLOAD_TYPE, 2 ** 32 + 5, 1, 0x1_0003);
    assert.equal(header.readUInt16BE(2), 3);
    assert.equal(header.readUInt32BE(4), 5);
  });
});

describe('ADTS framing', () => {
  it('extracts complete frames and skips leading garbage', () => {
    const a = adtsFrame(20, 1);
    const b = adtsFrame(33, 2);
    const { frames, consumed } = extractAdtsFrames(Buffer.concat([Buffer.from([9, 9, 9]), a, b]));
    assert.deepEqual(frames, [a, b]);
    assert.equal(consumed, 3 + a.length + b.length);
  });

  it('keeps an incomplete frame for the next chunk', () => {
    const framer = new AdtsFramer();
    const a = adtsFrame(40, 3);
    assert.deepEqual(framer.push(a.subarray(0, 25)), []);
    assert.deepEqual(framer.push(a.subarray(25)), [a]);
  });

  it('steps over a header with an impossible length', () => {
    const bad = Buffer.from([0xff, 0xf1, 0x60, 0x40, 0x00, 0x1f, 0xfc]);
    const good = adtsFrame(12, 4);
    assert.deepEqual(extractAdtsFrames(Buffer.concat([bad, good])).frames, [good]);
  });
});
