import { AdtsFramer, FRAME_DURATION_MS } from './protocol.js';
import { AqaraTalkClient } from './talk.js';

import type { Logger } from './types.js';

/**
 * The talkback codec advertised to camera.ui on the RTSP backchannel: G.711
 * A-law at 8 kHz, which go2rtc can produce from any browser or HomeKit mic.
 * The transcoder turns it into what the camera plays.
 */
export const TALKBACK_ADVERTISE = { codec: 'pcm_alaw', payloadType: 8, clockRate: 8000, channels: 1 } as const;

/** What the camera's speaker plays: AAC-LC in ADTS, 16 kHz mono, about 32 kbps. */
export const TALKBACK_TARGET = { codec: 'aac', sampleRate: 16000, channels: 1, format: 'adts', bitRate: 32000 } as const;

/** Turns inbound talkback RTP into AAC ADTS bytes. Implemented by @seydx/rtsp's BackchannelTranscoder. */
export interface Transcoder {
  start(): Promise<void>;
  push(rtp: Buffer): void;
  close(): Promise<void>;
}

export type TranscoderFactory = (output: (chunk: Buffer) => void, onError: (error: unknown) => void) => Transcoder;
export type TalkClientFactory = (host: string) => Pick<AqaraTalkClient, 'connect' | 'disconnect' | 'sendFrame' | 'connected' | 'once'>;

export interface TalkbackOptions {
  host: string;
  createTranscoder: TranscoderFactory;
  createClient?: TalkClientFactory;
  /** A session ends after this long without talkback audio. */
  idleTimeoutMs?: number;
  /** After the camera refused a session, wait this long before trying again. */
  cooldownMs?: number;
  /** Frames queued beyond this are dropped oldest first, so talk never lags far behind. */
  maxQueuedFrames?: number;
  /**
   * Longest a call may last, in ms, read when each call starts. The speaker
   * is cut off after this, and talk stays muted until the incoming audio
   * pauses, so a call left open (HomeKit can keep the mic streaming silence)
   * cannot hold the camera's speaker. 0 means no limit.
   */
  maxCallMs?: () => number;
  logger?: Logger;
}

/** Default maximum call duration, 3 minutes. */
export const DEFAULT_MAX_CALL_MS = 180_000;

/** Seconds from the Maximum Call Duration setting: 0 (no limit) or 10 to 3600. */
export function clampCallSeconds(value: unknown): number {
  const seconds = Math.round(Number(value));
  if (!Number.isFinite(seconds)) return DEFAULT_MAX_CALL_MS / 1000;
  if (seconds <= 0) return 0;
  return Math.min(Math.max(seconds, 10), 3600);
}

/**
 * Bridges camera.ui's talkback to the camera's speaker.
 *
 * The first RTP packet of a talk burst starts the transcoder and opens a voice
 * session with the camera. Frames are sent at the speaker's real-time pace
 * (one 64 ms frame at a time); anything that piles up while the session opens
 * is trimmed to the newest frames. When no audio has arrived for a while the
 * queue drains and the session ends, freeing the camera for the Aqara app.
 */
export class AqaraTalkback {
  private host: string;
  private readonly createTranscoder: TranscoderFactory;
  private readonly createClient: TalkClientFactory;
  private readonly idleTimeoutMs: number;
  private readonly cooldownMs: number;
  private readonly maxQueuedFrames: number;
  private readonly maxCallMs: () => number;
  private readonly logger?: Logger;

  private transcoder?: Transcoder;
  private transcoderReady?: Promise<void>;
  private client?: ReturnType<TalkClientFactory>;
  private opening?: Promise<void>;
  private readonly framer = new AdtsFramer();
  private queue: Buffer[] = [];
  private pacer?: NodeJS.Timeout;
  private nextSendAt = 0;
  private idleTimer?: NodeJS.Timeout;
  private blockedUntil = 0;
  private callTimer?: NodeJS.Timeout;
  /** Set when a call hit the maximum duration; cleared once incoming audio pauses. */
  private cutOff = false;
  private cutOffTimer?: NodeJS.Timeout;
  private lastPacketAt = 0;
  private stopping?: Promise<void>;

  constructor(options: TalkbackOptions) {
    this.host = options.host;
    this.createTranscoder = options.createTranscoder;
    this.createClient = options.createClient ?? ((host) => new AqaraTalkClient({ host, logger: options.logger }));
    this.idleTimeoutMs = options.idleTimeoutMs ?? 1500;
    this.cooldownMs = options.cooldownMs ?? 15_000;
    this.maxQueuedFrames = options.maxQueuedFrames ?? 8;
    this.maxCallMs = options.maxCallMs ?? (() => DEFAULT_MAX_CALL_MS);
    this.logger = options.logger;
  }

  /** True while a voice session with the camera is open. */
  public get active(): boolean {
    return this.client?.connected ?? false;
  }

  public setHost(host: string): void {
    if (host === this.host) return;
    this.host = host;
    void this.stop();
  }

  /** Feed one talkback RTP packet in the advertised codec. */
  public push(rtp: Buffer): void {
    if (this.cutOff) {
      // Keep muting until the talker stops sending; a new press then starts a new call.
      clearTimeout(this.cutOffTimer);
      this.cutOffTimer = setTimeout(() => (this.cutOff = false), this.idleTimeoutMs);
      return;
    }
    if (Date.now() < this.blockedUntil || this.stopping) return;
    this.lastPacketAt = Date.now();
    this.armIdleTimer();

    if (!this.transcoder) {
      this.logger?.debug?.('Talkback started');
      const transcoder = this.createTranscoder(
        (chunk) => this.onEncoded(chunk),
        (error) => {
          this.logger?.error?.('Talkback transcoding failed:', error);
          void this.stop();
        },
      );
      this.transcoder = transcoder;
      this.transcoderReady = transcoder.start().catch((error: unknown) => {
        this.logger?.error?.('Talkback transcoder did not start:', error);
        this.block();
        void this.stop();
        throw error;
      });
    }
    const transcoder = this.transcoder;
    this.transcoderReady?.then(() => transcoder.push(rtp)).catch(() => undefined);
  }

  /** End the talk burst now: drop queued audio and close the session. */
  public stop(): Promise<void> {
    this.stopping ??= this.teardown().finally(() => (this.stopping = undefined));
    return this.stopping;
  }

  private onEncoded(chunk: Buffer): void {
    for (const frame of this.framer.push(chunk)) {
      this.queue.push(frame);
      if (this.queue.length > this.maxQueuedFrames) this.queue.shift();
    }
    if (this.queue.length === 0) return;
    if (this.client?.connected) {
      this.startPacer();
    } else {
      void this.openSession();
    }
  }

  private openSession(): Promise<void> {
    this.opening ??= (async () => {
      const client = this.createClient(this.host);
      this.client = client;
      client.once('close', () => {
        if (this.client === client) {
          this.client = undefined;
          this.stopPacer();
        }
      });
      try {
        await client.connect();
        this.logger?.debug?.('Voice session open');
        this.armCallTimer();
        if (this.client === client) this.startPacer();
      } catch (error) {
        this.logger?.warn?.((error as Error).message);
        if (this.client === client) this.client = undefined;
        this.block();
        await this.stop();
      }
    })().finally(() => (this.opening = undefined));
    return this.opening;
  }

  private startPacer(): void {
    if (this.pacer) return;
    this.nextSendAt = Date.now();
    this.tick();
  }

  private tick(): void {
    this.pacer = undefined;
    const frame = this.queue.shift();
    if (!frame || !this.client?.connected) return;
    this.client.sendFrame(frame);
    this.nextSendAt += FRAME_DURATION_MS;
    // Never let the schedule fall far behind real time, or a burst would play fast.
    this.nextSendAt = Math.max(this.nextSendAt, Date.now() - FRAME_DURATION_MS);
    this.pacer = setTimeout(() => this.tick(), Math.max(0, this.nextSendAt - Date.now()));
  }

  private stopPacer(): void {
    clearTimeout(this.pacer);
    this.pacer = undefined;
  }

  private armIdleTimer(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.finish(), this.idleTimeoutMs);
  }

  /** Talk went quiet: let queued frames play out, then end the session. */
  private async finish(): Promise<void> {
    const quietSince = this.lastPacketAt;
    const drainMs = this.queue.length * FRAME_DURATION_MS + 250;
    await new Promise((resolve) => setTimeout(resolve, drainMs));
    // Talk resumed while the queue drained: the new burst keeps the session.
    if (this.lastPacketAt !== quietSince) return;
    await this.stop();
  }

  private armCallTimer(): void {
    clearTimeout(this.callTimer);
    const limit = this.maxCallMs();
    if (!(limit > 0)) return;
    this.callTimer = setTimeout(() => {
      this.logger?.log?.(`Talkback reached the maximum call duration (${Math.round(limit / 1000)} s), ending the call`);
      this.cutOff = true;
      clearTimeout(this.cutOffTimer);
      this.cutOffTimer = setTimeout(() => (this.cutOff = false), this.idleTimeoutMs);
      void this.stop();
    }, limit);
  }

  private block(): void {
    this.blockedUntil = Date.now() + this.cooldownMs;
  }

  private async teardown(): Promise<void> {
    clearTimeout(this.callTimer);
    this.callTimer = undefined;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.stopPacer();
    this.queue = [];
    this.framer.clear();

    const transcoder = this.transcoder;
    const client = this.client;
    this.transcoder = undefined;
    this.transcoderReady = undefined;
    this.client = undefined;

    await Promise.allSettled([transcoder?.close(), client?.disconnect()]);
    if (client) this.logger?.debug?.('Talkback ended');
  }
}
