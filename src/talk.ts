import { createSocket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { randomInt } from 'node:crypto';

import { AUDIO_PORT, AAC_FRAME_SAMPLES, buildPacket, buildRtpHeader, CONTROL_PORT, ControlPacketBuffer, PacketType, RTP_PAYLOAD_TYPE } from './protocol.js';

import type { Socket as UdpSocket } from 'node:dgram';
import type { Socket } from 'node:net';
import type { ControlPacket } from './protocol.js';
import type { Logger } from './types.js';

export interface TalkClientOptions {
  host: string;
  controlPort?: number;
  audioPort?: number;
  /** How long to wait for the TCP connection and for each ack. */
  timeoutMs?: number;
  heartbeatIntervalMs?: number;
  /** Heartbeats in a row that may fail before the session counts as dead. */
  maxHeartbeatFailures?: number;
  logger?: Logger;
}

/**
 * One voice session with an Aqara camera over its LAN talk protocol.
 *
 * `connect()` opens the TCP control channel and asks the camera to start a
 * voice session; the camera answers with an ack whose value is 0 when it
 * accepts. While the session is open a heartbeat goes out every 5 seconds,
 * and `sendFrame()` sends AAC ADTS frames to the camera's speaker over RTP.
 *
 * Emits `close` once the session has ended, whichever side ended it.
 */
export class AqaraTalkClient extends EventEmitter<{ close: [] }> {
  private readonly host: string;
  private readonly controlPort: number;
  private readonly audioPort: number;
  private readonly timeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxHeartbeatFailures: number;
  private readonly logger?: Logger;

  private readonly sessionId = BigInt(Date.now());
  private readonly ssrc = randomInt(1, 2 ** 31 - 1);
  private sequence = 0;

  private socket?: Socket;
  private udp?: UdpSocket;
  private readonly packets = new ControlPacketBuffer();
  private waiter?: { resolve: (packet: ControlPacket) => void; reject: (error: Error) => void };
  private heartbeatTimer?: NodeJS.Timeout;
  private heartbeatFailures = 0;
  private open = false;
  private closed = false;

  constructor(options: TalkClientOptions) {
    super();
    this.host = options.host;
    this.controlPort = options.controlPort ?? CONTROL_PORT;
    this.audioPort = options.audioPort ?? AUDIO_PORT;
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5000;
    this.maxHeartbeatFailures = options.maxHeartbeatFailures ?? 5;
    this.logger = options.logger;
  }

  public get connected(): boolean {
    return this.open;
  }

  public async connect(): Promise<void> {
    if (this.open) return;
    if (this.closed) throw new Error('This talk session has already ended');

    this.socket = await this.openSocket();
    this.packets.clear();

    let ack: bigint;
    try {
      ack = await this.requestAck(PacketType.StartVoice);
    } catch (error) {
      this.teardown();
      throw new Error(`The camera did not answer the request to start talking: ${(error as Error).message}`, { cause: error });
    }
    if (ack !== 0n) {
      this.teardown();
      throw new Error(`The camera refused to start talking (ack ${ack}). Another app may be talking to it.`);
    }

    this.udp = createSocket('udp4');
    this.udp.on('error', (error) => this.logger?.warn?.(`Talk audio socket error: ${error.message}`));
    this.open = true;
    this.scheduleHeartbeat();
  }

  /** Send one AAC ADTS frame (1024 samples) to the camera's speaker. */
  public sendFrame(frame: Buffer): void {
    if (!this.open || !this.udp) return;
    const header = buildRtpHeader(RTP_PAYLOAD_TYPE, this.sequence * AAC_FRAME_SAMPLES, this.ssrc, this.sequence);
    this.sequence++;
    this.udp.send(Buffer.concat([header, frame]), this.audioPort, this.host);
  }

  /** End the voice session politely and release both sockets. */
  public async disconnect(): Promise<void> {
    if (this.closed) return;
    const socket = this.socket;
    if (this.open && socket && !socket.destroyed) {
      await new Promise<void>((resolve) => socket.write(buildPacket(PacketType.StopVoice, this.sessionId), () => resolve()));
    }
    this.teardown();
  }

  private openSocket(): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.controlPort });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Could not reach ${this.host}:${this.controlPort} within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.setNoDelay(true);
        socket.on('data', (data) => this.onData(data));
        socket.on('close', () => this.onSocketClosed());
        socket.on('error', (error) => this.logger?.debug?.(`Talk control socket error: ${error.message}`));
        resolve(socket);
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`Could not reach ${this.host}:${this.controlPort}: ${error.message}`));
      });
    });
  }

  private onData(data: Buffer): void {
    this.packets.feed(data);
    for (let packet = this.packets.pop(); packet; packet = this.packets.pop()) {
      if (packet.type !== PacketType.Ack) continue;
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter?.resolve(packet);
    }
  }

  private requestAck(type: PacketType): Promise<bigint> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error('Control connection is closed'));

    // An ack that arrives after its own request gave up must not answer the next one.
    this.waiter?.reject(new Error('Superseded'));
    return new Promise<bigint>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiter?.resolve === done) this.waiter = undefined;
        reject(new Error(`no ack within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      const done = (packet: ControlPacket): void => {
        clearTimeout(timer);
        resolve(packet.value);
      };
      this.waiter = {
        resolve: done,
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      socket.write(buildPacket(type, this.sessionId));
    });
  }

  private scheduleHeartbeat(): void {
    this.heartbeatTimer = setTimeout(() => void this.heartbeat(), this.heartbeatIntervalMs);
  }

  private async heartbeat(): Promise<void> {
    if (!this.open) return;
    try {
      const ack = await this.requestAck(PacketType.Heartbeat);
      this.heartbeatFailures = ack === 0n ? 0 : this.heartbeatFailures + 1;
    } catch {
      this.heartbeatFailures++;
    }
    if (!this.open) return;
    if (this.heartbeatFailures > this.maxHeartbeatFailures) {
      this.logger?.warn?.(`The camera stopped answering talk heartbeats (${this.heartbeatFailures} in a row), ending the session`);
      this.teardown();
      return;
    }
    this.scheduleHeartbeat();
  }

  private onSocketClosed(): void {
    if (!this.closed) this.logger?.debug?.('The camera closed the talk control connection');
    this.teardown();
  }

  private teardown(): void {
    const wasClosed = this.closed;
    this.closed = true;
    this.open = false;
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.waiter?.reject(new Error('Talk session closed'));
    this.waiter = undefined;
    this.socket?.destroy();
    this.socket = undefined;
    try {
      this.udp?.close();
    } catch {
      // already closed
    }
    this.udp = undefined;
    if (!wasClosed) this.emit('close');
  }
}
