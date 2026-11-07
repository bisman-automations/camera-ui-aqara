import { modelName } from './models.js';
import { isAqaraDevice } from './onvif.js';

import type { MdnsCamera } from './mdns.js';
import type { WsDiscoveredDevice } from './onvif.js';

/** One Aqara camera found on the network, by mDNS, ONVIF or both. */
export interface Candidate {
  /** Stable id for camera.ui's adoption list: the Aqara device id when known, else the IP. */
  id: string;
  host: string;
  name: string;
  deviceId?: string;
  modelCode?: string;
  firmware?: string;
  /** ONVIF device service address, when the camera answered WS-Discovery. */
  onvifAddress?: string;
  /** Hardware name from the ONVIF scopes. */
  hardware?: string;
}

/**
 * Combine what mDNS and WS-Discovery found into one list of Aqara cameras.
 *
 * mDNS (`_aqara._tcp`) is how every Aqara camera announces itself and carries
 * the model and the stable device id. WS-Discovery adds the ONVIF address for
 * cameras with ONVIF turned on. An ONVIF device at an mDNS camera's address is
 * the same camera; ONVIF devices elsewhere are kept only when their scopes say
 * Aqara, so other brands on the network are not offered.
 */
export function mergeDiscoveries(mdns: MdnsCamera[], onvif: WsDiscoveredDevice[]): Candidate[] {
  const byHost = new Map<string, Candidate>();

  for (const camera of mdns) {
    byHost.set(camera.host, {
      id: `aqara-${camera.deviceId}`,
      host: camera.host,
      name: friendlyName(camera.instanceName, camera.modelCode),
      deviceId: camera.deviceId,
      modelCode: camera.modelCode,
      firmware: camera.firmware,
    });
  }

  for (const device of onvif) {
    const existing = byHost.get(device.host);
    if (existing) {
      existing.onvifAddress = device.addresses[0];
      existing.hardware = device.hardware;
      continue;
    }
    if (!isAqaraDevice(device)) continue;
    byHost.set(device.host, {
      id: `aqara-${device.host}`,
      host: device.host,
      name: device.name ? `Aqara ${device.name.replace(/^aqara\s*/i, '')}` : `Aqara (${device.host})`,
      onvifAddress: device.addresses[0],
      hardware: device.hardware,
    });
  }

  return [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
}

/** "Camera-G100-1A2B" becomes "Aqara Camera G100 1A2B"; falls back to the model name. */
function friendlyName(instanceName: string, modelCode: string): string {
  const cleaned = instanceName.replace(/[-_]+/g, ' ').trim();
  if (cleaned) return /^aqara\b/i.test(cleaned) ? cleaned : `Aqara ${cleaned}`;
  return `Aqara ${modelName(modelCode) ?? 'Camera'}`;
}
