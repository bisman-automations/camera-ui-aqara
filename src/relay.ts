import { AvSource, BackchannelTranscoder, Relay, RtspServerSink } from '@seydx/rtsp';

import { AqaraTalkback, TALKBACK_ADVERTISE, TALKBACK_TARGET } from './talkback.js';

import type { Logger } from './types.js';

export interface TalkRelayOptions {
  /** The camera stream to relay, with credentials. */
  source: string;
  /** The camera's IP address, where its speaker listens. */
  cameraHost: string;
  /** Address the relay's RTSP server listens on. Defaults to 127.0.0.1. */
  listenHost?: string;
  /** Port the relay listens on. Omit to let the system pick a free port. */
  port?: number;
  /** Path of the relayed stream, e.g. "live". */
  path: string;
  /** Maximum call duration in ms, read when each call starts. */
  maxCallMs?: () => number;
  logger: Logger;
}

/**
 * An RTSP relay of one camera stream that adds a talkback channel.
 *
 * It pulls the camera's stream only while someone watches, serves it on a
 * local RTSP address with an extra backchannel track, and plays audio sent on
 * that track through the camera's speaker over Aqara's LAN talk protocol.
 */
export class TalkRelay {
  private constructor(
    private readonly relay: Relay,
    private readonly server: RtspServerSink,
    private readonly talkback: AqaraTalkback,
  ) {}

  /** The relay's RTSP address, e.g. rtsp://127.0.0.1:8560/front-door. */
  public get url(): string {
    return this.server.url;
  }

  public static async start(options: TalkRelayOptions): Promise<TalkRelay> {
    const { logger } = options;
    const talkback = new AqaraTalkback({
      host: options.cameraHost,
      maxCallMs: options.maxCallMs,
      logger,
      createTranscoder: (output, onError) => {
        const transcoder = new BackchannelTranscoder({ from: { ...TALKBACK_ADVERTISE }, to: { ...TALKBACK_TARGET }, output, onError, logger });
        return {
          start: async () => transcoder.start(),
          push: (rtp) => transcoder.push(rtp),
          close: async () => transcoder.close(),
        };
      },
    });

    const relay = new Relay({
      source: new AvSource(options.source, { transport: 'tcp', reconnect: true, logger }),
      idleTimeout: 30_000,
      stallTimeout: 10_000,
      logger,
    });
    relay.on('stop', () => void talkback.stop());

    try {
      const server = await new RtspServerSink(relay, {
        host: options.listenHost ?? '127.0.0.1',
        port: options.port,
        path: options.path,
        backchannel: { advertise: { ...TALKBACK_ADVERTISE } },
        sdpTimeout: 30_000,
        logger,
      }).listen();
      server.on('backchannel', (rtp) => talkback.push(rtp));
      server.on('backchannel:stop', () => void talkback.stop());
      return new TalkRelay(relay, server, talkback);
    } catch (error) {
      await relay.stop().catch(() => undefined);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    await this.talkback.stop();
    await this.server.shutdown().catch(() => undefined);
    await this.relay.stop().catch(() => undefined);
  }
}
