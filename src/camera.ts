import { OnvifClient } from './onvif.js';
import { TalkRelay } from './relay.js';
import { aqaraRtspUrl, DEFAULT_RTSP_PATHS, probeRtspPaths, redact, stripCredentials, withCredentials } from './rtsp.js';
import { streamIndexForRole } from './streams.js';

import type { CameraDevice, DeviceStorage, JsonSchema, LoggerService, StreamingInterface } from '@camera.ui/sdk';
import type { AqaraCameraStorage, AqaraInitialSettings, Logger } from './types.js';

class Implementation implements StreamingInterface {
  constructor(private readonly camera: AqaraCamera) {}

  public async streamUrl(sourceId: string): Promise<string> {
    return this.camera.getStreamUrl(sourceId);
  }
}

/**
 * One Aqara camera in camera.ui.
 *
 * Video comes straight from the camera, over RTSP (`rtsp://host:8554/chN`) or
 * from the stream URLs the camera's ONVIF media service reports. When two-way
 * audio is on, the best stream goes through a local relay that adds an RTSP
 * backchannel; talkback arriving there is transcoded to AAC and played on the
 * camera's speaker over Aqara's LAN talk protocol.
 */
export class AqaraCamera {
  private readonly log: LoggerService;
  private readonly relayLogger: Logger;
  private readonly storage: DeviceStorage<AqaraCameraStorage>;

  /** Stream URLs with credentials, best first. */
  private streams: string[] = [];
  private relay?: TalkRelay;
  private implemented = false;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly cameraDevice: CameraDevice,
    private readonly maxCallMs?: () => number,
  ) {
    this.log = cameraDevice.logger;
    this.relayLogger = {
      log: (...args) => this.log.log(...args),
      warn: (...args) => this.log.warn(...args),
      error: (...args) => this.log.error(...args),
      debug: (...args) => this.log.debug(...args),
    };
    this.storage = cameraDevice.createStorage<AqaraCameraStorage>(this.schema());
  }

  public get deviceId(): string | undefined {
    return this.storage.values.deviceId;
  }

  public get host(): string | undefined {
    return this.storage.values.host;
  }

  /**
   * Start the camera. On a fresh adoption the plugin passes the adoption form
   * values, which camera.ui does not keep on its own; they are saved here.
   */
  public initialize(initial?: AqaraInitialSettings): Promise<void> {
    return this.serialize(async () => {
      if (initial) {
        Object.assign(this.storage.values, initial);
        await this.storage.save();
      }
      await this.start();
    });
  }

  /** The camera moved to a new IP address (found again over mDNS). */
  public updateHost(host: string): Promise<void> {
    return this.serialize(async () => {
      if (!host || host === this.storage.values.host) return;
      this.log.log(`Camera moved from ${this.storage.values.host} to ${host}`);
      if (this.storage.values.onvifAddress) {
        try {
          const address = new URL(this.storage.values.onvifAddress);
          address.hostname = host;
          this.storage.values.onvifAddress = address.toString();
        } catch {
          // leave a malformed address for the user to fix
        }
      }
      this.storage.values.host = host;
      await this.storage.save();
      await this.restart();
    });
  }

  public async getStreamUrl(sourceId: string): Promise<string> {
    if (this.streams.length === 0) throw new Error('The camera has no stream yet. Check its connection settings.');
    const role = this.cameraDevice.sources.find((source) => source._id === sourceId)?.role;
    const index = streamIndexForRole(role, this.streams.length) ?? 0;
    if (index === 0 && this.relay) return `${this.relay.url}#timeout=30`;
    return this.streams[index];
  }

  public destroy(): Promise<void> {
    this.stopped = true;
    return this.serialize(() => this.stopStreaming());
  }

  private async start(): Promise<void> {
    if (this.stopped) return;
    const { host, username, password, connection } = this.storage.values;
    if (!host || !username || !password) {
      this.log.attention('Enter the camera address, username and password in the camera settings.');
      return;
    }

    try {
      if (connection === 'onvif') {
        this.streams = await this.resolveOnvifStreams();
      } else {
        const paths = await this.resolveRtspPaths();
        this.streams = paths.slice(0, 3).map((path) => aqaraRtspUrl(host, username, password, path));
      }
    } catch (error) {
      this.log.error(`Could not get the camera's streams: ${(error as Error).message}`);
      return;
    }
    this.log.debug(`Streams: ${this.streams.map(redact).join(', ')}`);

    if (this.storage.values.twoWayAudio !== false) await this.startRelay(host);
    if (!this.implemented) {
      await this.cameraDevice.implement(new Implementation(this));
      this.implemented = true;
    }
    await this.cameraDevice.connect();
  }

  /**
   * The RTSP stream paths to use. They are found by asking the camera the
   * first time a camera runs over RTSP at an address, for example after
   * switching from ONVIF, and kept after that, so paths edited by hand stay.
   */
  private async resolveRtspPaths(): Promise<string[]> {
    const { host, username, password, rtspPaths, rtspCheckedHost } = this.storage.values;
    if (rtspPaths?.length && rtspCheckedHost === host) return rtspPaths;

    const probe = await probeRtspPaths(host, username, password);
    if ('error' in probe) {
      const fallback = rtspPaths?.length ? rtspPaths : DEFAULT_RTSP_PATHS;
      this.log.warn(`Could not check which RTSP streams the camera serves (${probe.message}), using ${fallback.join(', ')}`);
      return fallback;
    }
    this.storage.values.rtspPaths = probe.paths.slice(0, 3);
    this.storage.values.rtspCheckedHost = host;
    await this.storage.save();
    this.log.log(`RTSP streams: ${this.storage.values.rtspPaths.join(', ')}`);
    return this.storage.values.rtspPaths;
  }

  /**
   * Ask the camera's ONVIF service for its streams. When the camera cannot be
   * reached right now, the streams it reported last time are used, so a camera
   * that is slow to wake still comes up.
   */
  private async resolveOnvifStreams(): Promise<string[]> {
    const { host, username, password } = this.storage.values;
    const address = this.storage.values.onvifAddress || `http://${host}/onvif/device_service`;
    try {
      const client = new OnvifClient(address, username, password, { logger: this.relayLogger });
      const streams = (await client.getStreams()).slice(0, 3).map((stream) => stream.uri);
      if (streams.length === 0) throw new Error('the camera reported no video streams');
      this.storage.values.onvifStreams = streams.map(stripCredentials);
      await this.storage.save();
      return streams.map((uri) => withCredentials(uri, username, password));
    } catch (error) {
      const saved = this.storage.values.onvifStreams ?? [];
      if (saved.length === 0) throw new Error(`ONVIF at ${address} failed: ${(error as Error).message}`, { cause: error });
      this.log.warn(`ONVIF at ${address} failed (${(error as Error).message}), using the streams it reported last time`);
      return saved.map((uri) => withCredentials(uri, username, password));
    }
  }

  private async startRelay(host: string): Promise<void> {
    try {
      this.relay = await TalkRelay.start({ source: this.streams[0], cameraHost: host, path: 'live', maxCallMs: this.maxCallMs, logger: this.relayLogger });
      this.log.debug('Two-way audio relay ready');
    } catch (error) {
      this.log.error('Could not start the two-way audio relay, video goes direct without talkback:', error);
    }
  }

  private async stopStreaming(): Promise<void> {
    const relay = this.relay;
    this.relay = undefined;
    await relay?.stop();
  }

  private async restart(): Promise<void> {
    await this.stopStreaming();
    await this.start();
  }

  private serialize(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task, task);
    this.queue = run.catch((error: unknown) => this.log.error('Camera task failed:', error));
    return run;
  }

  private onSettingChanged(): Promise<void> {
    return this.serialize(() => this.restart());
  }

  private schema(): JsonSchema[] {
    const onSet = async (): Promise<void> => this.onSettingChanged();
    return [
      {
        type: 'string',
        key: 'connection',
        title: 'Connection',
        description: 'RTSP uses the streams Aqara serves on port 8554. ONVIF asks the camera which streams it has (needs ONVIF turned on in the Aqara app).',
        enum: ['rtsp', 'onvif'],
        enumLabels: { rtsp: 'RTSP', onvif: 'ONVIF' },
        defaultValue: 'rtsp',
        store: true,
        required: true,
        onSet,
      },
      {
        type: 'string',
        key: 'host',
        title: 'IP Address',
        description: "The camera's IP address. It follows the camera automatically when the camera is found on the network at a new address.",
        store: true,
        required: true,
        onSet,
      },
      {
        type: 'string',
        key: 'username',
        title: 'Username',
        description: 'The RTSP or ONVIF username shown in the Aqara app.',
        store: true,
        required: true,
        onSet,
      },
      {
        type: 'string',
        format: 'password',
        key: 'password',
        title: 'Password',
        description: 'The RTSP or ONVIF password shown in the Aqara app.',
        store: true,
        required: true,
        onSet,
      },
      {
        type: 'string',
        key: 'onvifAddress',
        title: 'ONVIF Address',
        description: 'The device service address, e.g. http://192.0.2.50/onvif/device_service. Filled in from discovery.',
        store: true,
        required: false,
        condition: { key: 'connection', value: 'onvif' },
        onSet,
      },
      {
        type: 'boolean',
        key: 'twoWayAudio',
        title: 'Two-Way Audio',
        description: "Talk through the camera's speaker. Turn off if another app needs the speaker, or to send video straight from the camera.",
        defaultValue: true,
        store: true,
        onSet,
      },
      {
        type: 'array',
        key: 'rtspPaths',
        title: 'RTSP Streams',
        description: 'Stream paths on port 8554, best first. Found when the camera was added.',
        items: { type: 'string', title: 'Path', description: '' },
        store: true,
        condition: { key: 'connection', value: 'rtsp' },
        onSet,
      },
      {
        type: 'string',
        key: 'rtspCheckedHost',
        title: 'RTSP Streams Checked At',
        description: 'The address the RTSP streams were last checked at.',
        store: true,
        readonly: true,
        hidden: true,
      },
      {
        type: 'string',
        key: 'deviceId',
        title: 'Device ID',
        description: 'Aqara device id, used to find the camera after an IP change.',
        store: true,
        readonly: true,
        hidden: true,
      },
      {
        type: 'string',
        key: 'model',
        title: 'Model',
        description: 'Aqara model code.',
        store: true,
        readonly: true,
        hidden: true,
      },
      {
        type: 'array',
        key: 'onvifStreams',
        title: 'ONVIF Streams',
        description: 'The stream URLs ONVIF reported last time.',
        items: { type: 'string', title: 'Stream', description: '' },
        store: true,
        hidden: true,
      },
    ];
  }
}
