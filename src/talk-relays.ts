import { TalkRelay } from './relay.js';
import { aqaraRtspUrl, describe } from './rtsp.js';
import { cameraChoices, parseRelays, relayFromForm, relayUrl, serializeRelays } from './talk-relay-config.js';

import type { DeviceStorage, FormSubmitResponse, JsonSchema, LoggerService } from '@camera.ui/sdk';
import type { RelayCameraChoice, RelayFormValues, TalkRelayConfig } from './talk-relay-config.js';
import type { AqaraPluginStorage, Logger } from './types.js';

const STORAGE_KEY = 'talkRelays';

/**
 * Talk relays for Aqara cameras another plugin manages.
 *
 * The plugin settings get a small form to add a relay and, for each relay, a
 * read-only line with its address and a Remove button. Relays run for as long
 * as the plugin does.
 */
export class TalkRelayManager {
  private configs: TalkRelayConfig[] = [];
  private cameras: RelayCameraChoice[] = [];
  private readonly running = new Map<string, TalkRelay>();
  private readonly relayLogger: Logger;

  constructor(
    private readonly storage: DeviceStorage<AqaraPluginStorage>,
    private readonly logger: LoggerService,
  ) {
    this.relayLogger = {
      log: (...args) => this.logger.log(...args),
      warn: (...args) => this.logger.warn(...args),
      error: (...args) => this.logger.error(...args),
      debug: (...args) => this.logger.debug(...args),
    };
  }

  /** The relays as configured, for matching against adopted cameras. */
  public get relays(): readonly TalkRelayConfig[] {
    return this.configs;
  }

  /** Whether a talk relay serves the camera with this device id or address. */
  public hasRelay(deviceId: string | undefined, host: string): boolean {
    return this.configs.some((relay) => (deviceId && relay.deviceId === deviceId) || relay.host === host);
  }

  /** Offer these discovered cameras in the relay form's Camera list. */
  public async setCameras(cameras: RelayCameraChoice[]): Promise<void> {
    this.cameras = cameras;
    await this.storage.changeSchema('relayCamera', this.cameraField()).catch((error: unknown) => this.logger.debug('Could not update the camera list:', error));
  }

  /** A camera found at a new address: move the relays made for it there. */
  public async followCamera(deviceId: string, host: string): Promise<void> {
    for (const relay of this.configs) {
      if (relay.deviceId !== deviceId || relay.host === host) continue;
      this.logger.log(`Talk relay "${relay.name}": camera moved from ${relay.host} to ${host}`);
      relay.host = host;
      await this.save();
      await this.running.get(relay.id)?.stop();
      this.running.delete(relay.id);
      await this.storage.changeSchema(`relay-${relay.id}`, this.relayField(relay)).catch(() => undefined);
      await this.run(relay);
    }
  }

  private cameraField(): JsonSchema {
    const { values, labels } = cameraChoices(this.cameras, this.configs);
    return {
      type: 'string',
      key: 'relayCamera',
      title: 'Talk Relay: Camera',
      description:
        'Two-way audio for an Aqara camera that another plugin manages, so it does not have to be added again. Pick the camera; the list shows the Aqara cameras found on the network.',
      enum: values,
      enumLabels: labels,
      defaultValue: values[0],
      store: false,
      required: false,
    };
  }

  private relayField(relay: TalkRelayConfig): JsonSchema {
    return {
      type: 'string',
      key: `relay-${relay.id}`,
      title: `Talk Relay: ${relay.name}`,
      description: `Camera ${relay.host}, stream ${relay.path}${relay.deviceId ? ', follows the camera when its address changes' : ''}. Use this address as the camera's High source.`,
      defaultValue: relayUrl(relay),
      store: false,
      readonly: true,
    };
  }

  /** The fixed part of the plugin settings: the add-relay form. */
  public schema(): JsonSchema[] {
    return [
      {
        type: 'string',
        key: STORAGE_KEY,
        title: 'Talk Relays',
        description: 'The configured talk relays.',
        store: true,
        hidden: true,
        readonly: true,
      },
      this.cameraField(),
      {
        type: 'string',
        key: 'relayName',
        title: 'Talk Relay: Name',
        description: "Optional for a camera picked from the list, which brings its own name. The name becomes part of the relay's address.",
        store: false,
        required: false,
      },
      {
        type: 'string',
        key: 'relayHost',
        title: 'Talk Relay: Camera IP Address',
        description: `Only for a camera that is not in the list ("Not listed").`,
        store: false,
        required: false,
      },
      {
        type: 'string',
        key: 'relayUsername',
        title: 'Talk Relay: RTSP Username',
        description: 'The RTSP username shown in the Aqara app.',
        store: false,
        required: false,
      },
      {
        type: 'string',
        format: 'password',
        key: 'relayPassword',
        title: 'Talk Relay: RTSP Password',
        description: 'The RTSP password shown in the Aqara app.',
        store: false,
        required: false,
      },
      {
        type: 'string',
        key: 'relayPath',
        title: 'Talk Relay: Stream',
        description: 'The camera stream to relay. ch1 is the best quality; some models call it 1080p or 1520p.',
        defaultValue: 'ch1',
        store: false,
        required: false,
      },
      {
        type: 'number',
        key: 'relayPort',
        title: 'Talk Relay: Port',
        description: 'The local port the relay listens on. Leave empty to use the next free port from 8560.',
        store: false,
        required: false,
      },
      {
        type: 'submit',
        key: 'addRelay',
        title: 'Add Talk Relay',
        description: "Then use the relay's address as the camera's High source in its camera.ui settings.",
        color: 'success',
        onClick: async (value) => this.add(value),
      },
    ];
  }

  /** Load the saved relays, show them in the settings and start them. */
  public async start(): Promise<void> {
    this.configs = parseRelays(await this.storage.getValue<string>(STORAGE_KEY));
    for (const relay of this.configs) {
      await this.showRelay(relay);
      await this.run(relay);
    }
  }

  public async stop(): Promise<void> {
    const relays = [...this.running.values()];
    this.running.clear();
    await Promise.allSettled(relays.map((relay) => relay.stop()));
  }

  private async add(value: unknown): Promise<FormSubmitResponse> {
    const raw = (value ?? {}) as Record<string, unknown>;
    const form = (raw.config ?? raw) as RelayFormValues;
    const result = relayFromForm(form, this.configs, this.cameras);
    if ('error' in result) return { toast: { type: 'warning', message: result.error } };
    const relay = result.relay;

    const check = await this.checkCamera(relay);
    if (check) return { toast: { type: 'error', message: check } };

    this.configs = [...this.configs, relay];
    await this.save();
    await this.showRelay(relay);
    await this.setCameras(this.cameras);
    const started = await this.run(relay);
    if (!started) {
      return { toast: { type: 'warning', message: `Saved, but the relay could not listen on port ${relay.port}. Remove it and pick another port.` } };
    }
    return { toast: { type: 'success', message: `Relay added. Set the camera's High source to ${relayUrl(relay)}` } };
  }

  private async remove(id: string): Promise<void> {
    const relay = this.configs.find((item) => item.id === id);
    if (!relay) return;
    this.configs = this.configs.filter((item) => item.id !== id);
    await this.save();
    await this.running.get(id)?.stop();
    this.running.delete(id);
    await this.storage.removeSchema(`relay-${id}`).catch(() => undefined);
    await this.storage.removeSchema(`relay-remove-${id}`).catch(() => undefined);
    await this.setCameras(this.cameras);
    this.logger.log(`Removed the talk relay "${relay.name}"`);
  }

  /** Make sure the camera answers with these credentials before saving the relay. */
  private async checkCamera(relay: TalkRelayConfig): Promise<string | undefined> {
    try {
      const result = await describe(aqaraRtspUrl(relay.host, relay.username, relay.password, relay.path));
      if (result.status === 401 || result.status === 403) return 'The camera rejected the RTSP username or password.';
      if (result.status === 404) return `The camera has no stream called ${relay.path}.`;
      if (result.status !== 200) return `The camera answered RTSP ${result.status} for ${relay.path}.`;
      return undefined;
    } catch (error) {
      return `${(error as Error).message}. Make sure RTSP is turned on for this camera in the Aqara app.`;
    }
  }

  private async run(relay: TalkRelayConfig): Promise<boolean> {
    try {
      const running = await TalkRelay.start({
        source: aqaraRtspUrl(relay.host, relay.username, relay.password, relay.path),
        cameraHost: relay.host,
        port: relay.port,
        path: relay.id,
        logger: this.relayLogger,
      });
      this.running.set(relay.id, running);
      this.logger.log(`Talk relay "${relay.name}" ready at ${relayUrl(relay)}`);
      return true;
    } catch (error) {
      this.logger.error(`Talk relay "${relay.name}" could not start on port ${relay.port}:`, error);
      return false;
    }
  }

  private async showRelay(relay: TalkRelayConfig): Promise<void> {
    await this.storage.addSchema(this.relayField(relay));
    await this.storage.addSchema({
      type: 'button',
      key: `relay-remove-${relay.id}`,
      title: `Remove ${relay.name}`,
      description: 'Stop and delete this relay. Point the camera back at its own stream first.',
      color: 'danger',
      onSet: async () => this.remove(relay.id),
    });
  }

  private async save(): Promise<void> {
    await this.storage.setValue(STORAGE_KEY, serializeRelays(this.configs));
  }
}
