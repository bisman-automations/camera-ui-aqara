import { API_EVENT, BasePlugin } from '@camera.ui/sdk';

import { AqaraCamera } from './camera.js';
import { mergeDiscoveries } from './discovery.js';
import { discoverMdns } from './mdns.js';
import { isDoorbell, modelName } from './models.js';
import { discoverOnvif, OnvifClient } from './onvif.js';
import { probeRtspPaths, redact, stripCredentials } from './rtsp.js';
import { buildCameraConfig } from './streams.js';
import { clampCallSeconds, DEFAULT_MAX_CALL_MS } from './talkback.js';
import { TalkRelayManager } from './talk-relays.js';

import type {
  CameraConfig,
  CameraDevice,
  DeviceStorage,
  DiscoveredCamera,
  DiscoveryProvider,
  FormSubmitResponse,
  JsonSchema,
  JsonSchemaWithoutCallbacks,
  LoggerService,
  PluginAPI,
} from '@camera.ui/sdk';
import type { Candidate } from './discovery.js';
import type { RelayCameraChoice } from './talk-relay-config.js';
import type { AqaraInitialSettings, AqaraPluginStorage, ConnectionMode, Logger } from './types.js';

const DISCOVERY_TIMEOUT_MS = 4000;
/** How often adopted cameras are looked up on the network again, to follow IP changes. */
const REDISCOVER_INTERVAL_MS = 30 * 60_000;

export default class AqaraPlugin extends BasePlugin<AqaraPluginStorage> implements DiscoveryProvider {
  private readonly cameras = new Map<string, AqaraCamera>();
  /** What discovery knew about each candidate, by discovered-camera id, for the adoption form. */
  private readonly candidates = new Map<string, Candidate>();
  /** Adoption-form values, bridged from onAdoptCamera to onCameraAdded (camera.ui keeps only the CameraConfig). */
  private readonly pendingSettings = new Map<string, AqaraInitialSettings>();
  private readonly discoveryLogger: Logger;
  private rediscoverTimer?: NodeJS.Timeout;
  private readonly talkRelays: TalkRelayManager;
  /** Maximum call duration in seconds, from the plugin settings. */
  private maxCallSeconds = DEFAULT_MAX_CALL_MS / 1000;

  constructor(logger: LoggerService, api: PluginAPI, storage: DeviceStorage<AqaraPluginStorage>) {
    super(logger, api, storage);
    this.talkRelays = new TalkRelayManager(storage, logger, () => this.maxCallMs());
    this.discoveryLogger = { debug: (...args) => this.logger.debug(...args) };
    this.api.on(API_EVENT.FINISH_LAUNCHING, () => this.onFinishLaunching());
    this.api.on(API_EVENT.SHUTDOWN, () => this.onShutdown());
  }

  override get storageSchema(): JsonSchema[] {
    return [
      {
        type: 'number',
        key: 'maxCallDuration',
        title: 'Maximum Call Duration',
        description:
          'Seconds a talk call may last before the camera speaker is cut off, for every camera and talk relay. Guards against a call left open. 0 turns the limit off.',
        defaultValue: DEFAULT_MAX_CALL_MS / 1000,
        minimum: 0,
        maximum: 3600,
        store: true,
        required: false,
        onSet: async (value) => {
          this.maxCallSeconds = clampCallSeconds(value);
        },
      },
      {
        type: 'string',
        key: 'manualHost',
        title: 'Add Camera: IP Address',
        description: 'For a camera discovery does not find. Enter its IP address and press Add Camera; it then shows up in the list of cameras to adopt.',
        store: true,
        required: false,
      },
      {
        type: 'string',
        key: 'manualName',
        title: 'Add Camera: Name',
        description: 'Optional name for the camera.',
        store: true,
        required: false,
      },
      {
        type: 'submit',
        key: 'addManual',
        title: 'Add Camera',
        description: 'Offer the camera at this IP address for adoption.',
        color: 'success',
        onClick: async (value) => this.addManualCamera(value),
      },
      ...this.talkRelays.schema(),
    ];
  }

  public async configureCameras(cameras: CameraDevice[]): Promise<void> {
    for (const camera of cameras) await this.startCamera(camera);
  }

  public async onCameraAdded(camera: CameraDevice): Promise<void> {
    const initial = camera.nativeId ? this.pendingSettings.get(camera.nativeId) : undefined;
    await this.startCamera(camera, initial);
    if (camera.nativeId) this.pendingSettings.delete(camera.nativeId);
  }

  public async onCameraReleased(cameraId: string): Promise<void> {
    const camera = this.cameras.get(cameraId);
    this.cameras.delete(cameraId);
    await camera?.destroy();
  }

  public async onDiscoverCameras(): Promise<DiscoveredCamera[]> {
    const [mdns, onvif] = await Promise.all([
      discoverMdns(DISCOVERY_TIMEOUT_MS, this.discoveryLogger),
      discoverOnvif(DISCOVERY_TIMEOUT_MS, this.discoveryLogger),
    ]);
    const candidates = mergeDiscoveries(mdns, onvif);
    this.logger.debug(`Discovery: ${mdns.length} over mDNS, ${onvif.length} ONVIF devices, ${candidates.length} Aqara cameras`);
    await this.followMovedCameras(candidates);

    const offered: DiscoveredCamera[] = [];
    for (const candidate of candidates) {
      this.candidates.set(candidate.id, candidate);
      if (this.isAdopted(candidate)) continue;
      offered.push({
        id: candidate.id,
        // Cameras another plugin already has, with a talk relay made for them, are labeled so they are not added twice by mistake.
        name: this.talkRelays.hasRelay(candidate.deviceId, candidate.host) ? `${candidate.name} (has a talk relay)` : candidate.name,
        manufacturer: 'Aqara',
        model: modelName(candidate.modelCode, candidate.hardware),
        address: candidate.host,
      });
    }
    await this.talkRelays.setCameras(candidates.filter((candidate) => !this.isAdopted(candidate)).map((candidate) => this.relayChoice(candidate)));
    return offered;
  }

  public async onGetCameraSettings(camera: DiscoveredCamera): Promise<JsonSchemaWithoutCallbacks[]> {
    const candidate = this.candidates.get(camera.id);
    const onvifAddress = candidate?.onvifAddress;
    return [
      {
        type: 'string',
        key: 'connection',
        title: 'Connection',
        description: onvifAddress
          ? 'The camera answers ONVIF. ONVIF asks it which streams it has; RTSP uses the streams Aqara serves on port 8554.'
          : 'RTSP uses the streams Aqara serves on port 8554 (turn on RTSP in the Aqara app). Choose ONVIF if you turned on ONVIF instead.',
        enum: ['rtsp', 'onvif'],
        enumLabels: { rtsp: 'RTSP', onvif: 'ONVIF' },
        defaultValue: onvifAddress ? 'onvif' : 'rtsp',
        required: true,
      },
      {
        type: 'string',
        key: 'host',
        title: 'IP Address',
        description: "The camera's IP address.",
        defaultValue: camera.address,
        required: true,
      },
      {
        type: 'string',
        key: 'username',
        title: 'Username',
        description: 'The RTSP or ONVIF username shown in the Aqara app.',
        required: true,
      },
      {
        type: 'string',
        format: 'password',
        key: 'password',
        title: 'Password',
        description: 'The RTSP or ONVIF password shown in the Aqara app.',
        required: true,
      },
      {
        type: 'string',
        key: 'onvifAddress',
        title: 'ONVIF Address',
        description: 'Device service address. Leave empty to use http://<IP address>/onvif/device_service.',
        defaultValue: onvifAddress,
        required: false,
        condition: { key: 'connection', value: 'onvif' },
      },
      {
        type: 'boolean',
        key: 'twoWayAudio',
        title: 'Two-Way Audio',
        description: "Talk through the camera's speaker from camera.ui and the apps it streams to.",
        defaultValue: true,
      },
    ];
  }

  public async onAdoptCamera(camera: DiscoveredCamera, settings: Record<string, unknown>): Promise<CameraConfig> {
    const candidate = this.candidates.get(camera.id);
    const connection: ConnectionMode = settings.connection === 'onvif' ? 'onvif' : 'rtsp';
    const host = stringSetting(settings.host) || camera.address || '';
    const username = stringSetting(settings.username);
    const password = stringSetting(settings.password);
    const twoWayAudio = settings.twoWayAudio !== false;
    if (!host || !username || !password) throw new Error('IP address, username and password are required');

    const initial: AqaraInitialSettings = { connection, host, username, password, twoWayAudio, deviceId: candidate?.deviceId, model: candidate?.modelCode };
    const info: CameraConfig['info'] = {
      manufacturer: 'Aqara',
      model: modelName(candidate?.modelCode, candidate?.hardware),
      firmwareVersion: candidate?.firmware,
    };
    let streamCount: number;

    if (connection === 'onvif') {
      const onvifAddress = stringSetting(settings.onvifAddress) || candidate?.onvifAddress || `http://${host}/onvif/device_service`;
      const client = new OnvifClient(onvifAddress, username, password, { logger: this.discoveryLogger });
      const device = await client.getDeviceInformation().catch(() => undefined);
      const streams = (await client.getStreams()).slice(0, 3);
      if (streams.length === 0) throw new Error('The camera answered ONVIF but reported no video streams');
      initial.onvifAddress = onvifAddress;
      initial.onvifStreams = streams.map((stream) => stripCredentials(stream.uri));
      streamCount = streams.length;
      info.model ??= device?.model;
      info.firmwareVersion = device?.firmwareVersion ?? info.firmwareVersion;
      info.serialNumber = device?.serialNumber;
      this.logger.log(`ONVIF streams: ${streams.map((stream) => `${stream.width ?? '?'}x${stream.height ?? '?'} ${redact(stream.uri)}`).join(', ')}`);
    } else {
      const probe = await probeRtspPaths(host, username, password);
      if ('error' in probe) {
        const hint = probe.error === 'unreachable' ? ' Make sure RTSP is turned on for this camera in the Aqara app.' : '';
        throw new Error(`${probe.message}.${hint}`);
      }
      initial.rtspPaths = probe.paths.slice(0, 3);
      initial.rtspCheckedHost = host;
      streamCount = initial.rtspPaths.length;
      this.logger.log(`RTSP streams: ${initial.rtspPaths.join(', ')}`);
    }

    const relay = this.talkRelays.relays.find((item) => item.host === host);
    if (relay) {
      this.logger.log(`The talk relay "${relay.name}" also serves this camera. Remove it once the camera it was for is gone.`);
    }

    const nativeId = candidate?.deviceId ? `aqara-${candidate.deviceId}` : `aqara-${host}`;
    const name = camera.name || `Aqara ${info.model ?? host}`;
    this.pendingSettings.set(nativeId, initial);
    return buildCameraConfig({ name, nativeId, streamCount, doorbell: isDoorbell(candidate?.modelCode, `${name} ${info.model ?? ''}`), info });
  }

  private async startCamera(camera: CameraDevice, initial?: AqaraInitialSettings): Promise<void> {
    const controller = new AqaraCamera(camera, () => this.maxCallMs());
    this.cameras.set(camera.id, controller);
    try {
      await controller.initialize(initial);
    } catch (error) {
      camera.logger.error('Could not start this camera:', error);
    }
  }

  private isAdopted(candidate: Candidate): boolean {
    for (const camera of this.cameras.values()) {
      if (candidate.deviceId && camera.deviceId === candidate.deviceId) return true;
      if (!candidate.deviceId && camera.host === candidate.host) return true;
    }
    return false;
  }

  /** Point adopted cameras and talk relays at their new address when mDNS finds them somewhere else. */
  private async followMovedCameras(candidates: Candidate[]): Promise<void> {
    for (const candidate of candidates) {
      if (!candidate.deviceId) continue;
      for (const camera of this.cameras.values()) {
        if (camera.deviceId === candidate.deviceId && camera.host !== candidate.host) await camera.updateHost(candidate.host);
      }
      await this.talkRelays.followCamera(candidate.deviceId, candidate.host);
    }
  }

  private relayChoice(candidate: Candidate): RelayCameraChoice {
    return {
      id: candidate.id,
      name: candidate.name,
      host: candidate.host,
      deviceId: candidate.deviceId,
      model: modelName(candidate.modelCode, candidate.hardware),
    };
  }

  /**
   * Look for Aqara cameras in the background: to follow cameras and relays to
   * new addresses, and to keep the talk relay form's Camera list current.
   * Adopted cameras are left out of that list, they have two-way audio already.
   */
  private async rediscover(): Promise<void> {
    try {
      const candidates = mergeDiscoveries(await discoverMdns(DISCOVERY_TIMEOUT_MS, this.discoveryLogger), []);
      for (const candidate of candidates) this.candidates.set(candidate.id, candidate);
      await this.followMovedCameras(candidates);
      await this.talkRelays.setCameras(candidates.filter((candidate) => !this.isAdopted(candidate)).map((candidate) => this.relayChoice(candidate)));
    } catch (error) {
      this.logger.debug('Background discovery failed:', error);
    }
  }

  private async addManualCamera(value: unknown): Promise<FormSubmitResponse> {
    const raw = (value ?? {}) as Record<string, unknown>;
    const fields = (raw.config ?? raw) as AqaraPluginStorage;
    const host = (fields.manualHost ?? '').trim();
    if (!host) return { toast: { type: 'warning', message: 'Enter an IP address first.' } };

    const id = `aqara-${host}`;
    if ([...this.cameras.values()].some((camera) => camera.host === host)) {
      return { toast: { type: 'info', message: `The camera at ${host} is already added.` } };
    }
    const name = (fields.manualName ?? '').trim() || `Aqara (${host})`;
    this.candidates.set(id, { id, host, name });
    try {
      await this.api.deviceManager.pushDiscoveredCameras([{ id, name, manufacturer: 'Aqara', address: host }]);
    } catch (error) {
      this.logger.error('Could not add the camera:', error);
      return { toast: { type: 'error', message: `Could not add ${host}: ${String(error)}` } };
    }
    return { toast: { type: 'success', message: `${name} added. Adopt it from the camera list.` } };
  }

  private maxCallMs(): number {
    return this.maxCallSeconds * 1000;
  }

  private onFinishLaunching(): void {
    void this.storage
      .getValue<number>('maxCallDuration')
      .then((value) => {
        if (value !== undefined && value !== null) this.maxCallSeconds = clampCallSeconds(value);
      })
      .catch(() => undefined);
    this.rediscoverTimer = setInterval(() => void this.rediscover(), REDISCOVER_INTERVAL_MS);
    // Relays load first, so discovery can move them and label the Camera list.
    void this.talkRelays
      .start()
      .catch((error: unknown) => this.logger.error('Could not start the talk relays:', error))
      .then(() => this.rediscover());
  }

  private async onShutdown(): Promise<void> {
    clearInterval(this.rediscoverTimer);
    const cameras = [...this.cameras.values()];
    this.cameras.clear();
    await Promise.allSettled([...cameras.map((camera) => camera.destroy()), this.talkRelays.stop()]);
  }
}

function stringSetting(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
