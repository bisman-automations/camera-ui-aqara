/**
 * Talk relays: two-way audio for Aqara cameras that another camera.ui plugin
 * already manages. The relay serves the camera's stream with a talkback
 * channel on a fixed local address; the user points the existing camera's
 * High source at it. This module holds the settings logic, free of streaming
 * code so it can be tested on its own.
 */

export interface TalkRelayConfig {
  /** Stable id, also the URL path. */
  id: string;
  name: string;
  host: string;
  username: string;
  password: string;
  /** Camera stream path, e.g. ch1. */
  path: string;
  port: number;
  /** Aqara device id when the relay was made from a discovered camera; lets the relay follow IP changes. */
  deviceId?: string;
}

/** A camera discovery found, offered in the relay form's Camera list. */
export interface RelayCameraChoice {
  /** Discovered-camera id, the value of the Camera list. */
  id: string;
  name: string;
  host: string;
  deviceId?: string;
  model?: string;
}

/** The Camera list's entry for typing the IP address in. */
export const MANUAL_CAMERA = 'manual';

/** Values and labels for the relay form's Camera list: discovered cameras first, then manual entry. */
export function cameraChoices(cameras: RelayCameraChoice[], relays: TalkRelayConfig[]): { values: string[]; labels: Record<string, string> } {
  const values: string[] = [];
  const labels: Record<string, string> = {};
  for (const camera of cameras) {
    values.push(camera.id);
    const hasRelay = relays.some((relay) => (camera.deviceId && relay.deviceId === camera.deviceId) || relay.host === camera.host);
    labels[camera.id] = `${camera.name} (${camera.host}${camera.model ? `, ${camera.model}` : ''})${hasRelay ? ' · has a talk relay' : ''}`;
  }
  values.push(MANUAL_CAMERA);
  labels[MANUAL_CAMERA] = 'Not listed: enter its IP address';
  return { values, labels };
}

export const FIRST_RELAY_PORT = 8560;

/** "Front Door Cam" becomes "front-door-cam". */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Read the stored relay list, skipping anything malformed. */
export function parseRelays(stored: unknown): TalkRelayConfig[] {
  let value = stored;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value || '[]');
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is TalkRelayConfig =>
      !!item &&
      typeof item === 'object' &&
      typeof (item as TalkRelayConfig).id === 'string' &&
      typeof (item as TalkRelayConfig).host === 'string' &&
      Number.isInteger((item as TalkRelayConfig).port),
  );
}

export function serializeRelays(relays: TalkRelayConfig[]): string {
  return JSON.stringify(relays);
}

/** The first port at or above FIRST_RELAY_PORT that no relay uses. */
export function nextFreePort(relays: TalkRelayConfig[]): number {
  const used = new Set(relays.map((relay) => relay.port));
  let port = FIRST_RELAY_PORT;
  while (used.has(port)) port++;
  return port;
}

/** The relay's address for camera.ui to pull from. go2rtc runs on the same machine. */
export function relayUrl(relay: TalkRelayConfig): string {
  return `rtsp://127.0.0.1:${relay.port}/${relay.id}`;
}

export interface RelayFormValues {
  relayCamera?: unknown;
  relayName?: unknown;
  relayHost?: unknown;
  relayUsername?: unknown;
  relayPassword?: unknown;
  relayPath?: unknown;
  relayPort?: unknown;
}

/**
 * Turn the add-relay form into a relay, or explain what is wrong with it.
 * Names, paths and ports must be unique among the relays.
 */
export function relayFromForm(
  form: RelayFormValues,
  existing: TalkRelayConfig[],
  cameras: RelayCameraChoice[] = [],
): { relay: TalkRelayConfig } | { error: string } {
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '');
  const picked = cameras.find((camera) => camera.id === text(form.relayCamera));
  // A camera picked from the list supplies the address and a default name; typed values still win.
  const name = text(form.relayName) || picked?.name || '';
  const host = text(form.relayHost) || picked?.host || '';
  const username = text(form.relayUsername);
  const password = typeof form.relayPassword === 'string' ? form.relayPassword : '';
  const path = text(form.relayPath).replace(/^\/+/, '') || 'ch1';
  const portText = text(form.relayPort);
  const port = portText ? Number(portText) : nextFreePort(existing);

  if (!name) return { error: 'Enter a name for the relay, e.g. the camera name.' };
  if (!host) return { error: 'Pick the camera from the list, or enter its IP address.' };
  if (!username || !password) return { error: "Enter the camera's RTSP username and password from the Aqara app." };
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return { error: 'Use a port between 1024 and 65535.' };

  const id = slugify(name);
  if (!id) return { error: 'Use a name with letters or numbers.' };
  if (existing.some((relay) => relay.id === id)) return { error: `There is already a relay named "${name}".` };
  if (existing.some((relay) => relay.port === port)) return { error: `Port ${port} is already used by another relay.` };

  if (picked?.deviceId && existing.some((relay) => relay.deviceId === picked.deviceId)) {
    return { error: `${picked.name} already has a talk relay.` };
  }

  const relay: TalkRelayConfig = { id, name, host, username, password, path, port };
  if (picked?.deviceId && picked.host === host) relay.deviceId = picked.deviceId;
  return { relay };
}
