/**
 * Aqara LAN talk protocol: control packets, CRC and RTP headers.
 *
 * Aqara cameras take two-way audio on a channel of their own, separate from
 * the RTSP and ONVIF streams:
 *
 * - TCP 54324 carries control packets (start voice, stop voice, heartbeat, ack).
 * - UDP 54323 carries RTP, payload type 97, one AAC-LC ADTS frame per packet
 *   (16 kHz mono, 1024 samples = 64 ms per frame).
 *
 * The packet layout was reverse-engineered by Dan Gibson for
 * https://github.com/absent42/Aqara-Camera-2-Way-Audio (MIT); this is a
 * TypeScript port of that work.
 */

export const CONTROL_PORT = 54324;
export const AUDIO_PORT = 54323;
export const RTSP_PORT = 8554;

export const MAGIC = Buffer.from([0xfe, 0xef]);

export enum PacketType {
  StartVoice = 0,
  StopVoice = 1,
  Ack = 2,
  Heartbeat = 3,
}

export const RTP_PAYLOAD_TYPE = 97;
export const AAC_SAMPLE_RATE = 16000;
export const AAC_FRAME_SAMPLES = 1024;
/** Length of one AAC frame in milliseconds (64 ms). */
export const FRAME_DURATION_MS = (AAC_FRAME_SAMPLES / AAC_SAMPLE_RATE) * 1000;

/** Real control packets carry at most an 8-byte payload. Anything larger is a false header. */
const MAX_CONTROL_PAYLOAD = 64;

const CRC16_TABLE = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
    }
    table[i] = crc;
  }
  return table;
})();

/**
 * CRC-16 as the camera computes it: reflected polynomial 0x8408, initial
 * value 0xFFFF, final XOR 0xFFFF.
 */
export function crc16(data: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of data) {
    crc = CRC16_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return ~crc & 0xffff;
}

/**
 * Build a control packet.
 *
 * Wire format: magic (2) | type (1) | payload length (2) | payload | CRC (2).
 * The CRC covers type through the end of the payload. An ack carries a single
 * byte; every other type carries an 8-byte big-endian value (the session's
 * start time in epoch milliseconds).
 */
export function buildPacket(type: PacketType, value: number | bigint): Buffer {
  const payload = type === PacketType.Ack ? Buffer.from([Number(value) & 0xff]) : Buffer.alloc(8);
  if (type !== PacketType.Ack) payload.writeBigUInt64BE(BigInt(value));

  const body = Buffer.alloc(3 + payload.length);
  body.writeUInt8(type, 0);
  body.writeUInt16BE(payload.length, 1);
  payload.copy(body, 3);

  const crc = Buffer.alloc(2);
  crc.writeUInt16BE(crc16(body));
  return Buffer.concat([MAGIC, body, crc]);
}

export interface ControlPacket {
  type: PacketType;
  value: bigint;
}

/** Parse one complete control packet, or return undefined when it is not valid. */
export function parsePacket(data: Buffer): ControlPacket | undefined {
  if (data.length < 8 || data[0] !== MAGIC[0] || data[1] !== MAGIC[1]) return undefined;
  const raw = data[2];
  if (raw > 3) return undefined;
  const type: PacketType = raw;
  const length = data.readUInt16BE(3);
  if (data.length < 7 + length) return undefined;
  const expected = data.readUInt16BE(5 + length);
  if (crc16(data.subarray(2, 5 + length)) !== expected) return undefined;

  const payload = data.subarray(5, 5 + length);
  const value = type === PacketType.Ack ? BigInt(payload[0] ?? 0) : payload.length === 0 ? 0n : BigInt(`0x${payload.toString('hex')}`);
  return { type, value };
}

/**
 * Reassembles control packets from the TCP byte stream.
 *
 * TCP may split one packet across reads or join several into one. Garbage,
 * corrupt packets and unknown types are skipped by resyncing on the next
 * magic, so one bad packet cannot desynchronise the stream.
 */
export class ControlPacketBuffer {
  private buffer = Buffer.alloc(0);

  public get length(): number {
    return this.buffer.length;
  }

  public feed(data: Buffer): void {
    this.buffer = this.buffer.length === 0 ? Buffer.from(data) : Buffer.concat([this.buffer, data]);
  }

  public clear(): void {
    this.buffer = Buffer.alloc(0);
  }

  public pop(): ControlPacket | undefined {
    while (this.buffer.length >= 5) {
      if (this.buffer[0] !== MAGIC[0] || this.buffer[1] !== MAGIC[1]) {
        this.resync(1);
        continue;
      }
      const length = this.buffer.readUInt16BE(3);
      if (length > MAX_CONTROL_PAYLOAD) {
        this.resync(2);
        continue;
      }
      const total = 7 + length;
      if (this.buffer.length < total) return undefined;
      const packet = parsePacket(this.buffer.subarray(0, total));
      if (!packet) {
        // A false header match: a real packet may start inside these bytes.
        this.resync(2);
        continue;
      }
      this.buffer = this.buffer.subarray(total);
      return packet;
    }
    return undefined;
  }

  private resync(start: number): void {
    let index = this.buffer.indexOf(MAGIC, start);
    if (index < 0) {
      // Keep a trailing first magic byte, its partner may still be in flight.
      index = this.buffer[this.buffer.length - 1] === MAGIC[0] ? this.buffer.length - 1 : this.buffer.length;
    }
    this.buffer = this.buffer.subarray(index);
  }
}

/** A 12-byte RTP header (RFC 3550): version 2, no padding, extension, CSRC or marker. */
export function buildRtpHeader(payloadType: number, timestamp: number, ssrc: number, sequence: number): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = payloadType & 0x7f;
  header.writeUInt16BE(sequence & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  return header;
}

/**
 * Splits a byte stream into AAC ADTS frames.
 *
 * Feed it whatever the encoder produced; it returns every complete frame and
 * keeps an incomplete trailing frame for the next call. Bytes before a sync
 * word are dropped.
 */
export class AdtsFramer {
  private buffer = Buffer.alloc(0);

  public push(data: Buffer): Buffer[] {
    this.buffer = this.buffer.length === 0 ? Buffer.from(data) : Buffer.concat([this.buffer, data]);
    const { frames, consumed } = extractAdtsFrames(this.buffer);
    this.buffer = this.buffer.subarray(consumed);
    return frames;
  }

  public clear(): void {
    this.buffer = Buffer.alloc(0);
  }
}

export function extractAdtsFrames(data: Buffer): { frames: Buffer[]; consumed: number } {
  const frames: Buffer[] = [];
  let offset = 0;
  while (offset <= data.length - 7) {
    if (data[offset] !== 0xff || (data[offset + 1] & 0xf0) !== 0xf0) {
      offset++;
      continue;
    }
    const frameLength = ((data[offset + 3] & 0x03) << 11) | (data[offset + 4] << 3) | (data[offset + 5] >> 5);
    if (frameLength < 7) {
      offset++;
      continue;
    }
    if (offset + frameLength > data.length) break;
    frames.push(Buffer.from(data.subarray(offset, offset + frameLength)));
    offset += frameLength;
  }
  return { frames, consumed: offset };
}
