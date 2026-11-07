import multicastDns from 'multicast-dns';

import type { Logger } from './types.js';

export const AQARA_SERVICE = '_aqara._tcp.local';
const MODEL_PREFIX = 'lumi.camera.';

/** An Aqara camera found through its `_aqara._tcp` mDNS advertisement. */
export interface MdnsCamera {
  host: string;
  /** TXT `id`, e.g. lumi3.0000000000000001. Stable across IP changes. */
  deviceId: string;
  /** TXT `md`, e.g. lumi.camera.agl005. */
  modelCode: string;
  /** mDNS instance name, e.g. Camera-G100-0001. */
  instanceName: string;
  firmware?: string;
}

/** The subset of a DNS record this module reads. */
export interface DnsRecord {
  name: string;
  type: string;
  data: unknown;
}

/**
 * Turn the records of any number of mDNS responses into cameras.
 *
 * Responses arrive piecemeal: the PTR names an instance, the SRV gives its
 * host name, the TXT its model and id, and an A record the address. Records
 * for anything that is not an Aqara camera are ignored, and each camera is
 * listed once (by device id) even when it answers more than once.
 */
export function camerasFromRecords(records: DnsRecord[]): MdnsCamera[] {
  const instances = new Set<string>();
  const srv = new Map<string, string>();
  const txt = new Map<string, Record<string, string>>();
  const addresses = new Map<string, string>();

  for (const record of records) {
    const name = record.name.toLowerCase();
    switch (record.type) {
      case 'PTR':
        if (name === AQARA_SERVICE && typeof record.data === 'string') instances.add(record.data);
        break;
      case 'SRV':
        srv.set(name, String((record.data as { target?: string }).target ?? '').toLowerCase());
        break;
      case 'TXT':
        txt.set(name, parseTxt(record.data));
        break;
      case 'A':
        if (typeof record.data === 'string') addresses.set(name, record.data);
        break;
    }
  }

  const cameras = new Map<string, MdnsCamera>();
  for (const instance of instances) {
    const key = instance.toLowerCase();
    const props = txt.get(key) ?? {};
    const modelCode = (props.md ?? '').toLowerCase();
    const deviceId = props.id ?? '';
    if (!modelCode.startsWith(MODEL_PREFIX) || !deviceId) continue;
    const target = srv.get(key);
    const host = (target && addresses.get(target)) ?? undefined;
    if (!host) continue;
    if (cameras.has(deviceId)) continue;
    cameras.set(deviceId, {
      host,
      deviceId,
      modelCode,
      instanceName: instance.endsWith(`.${AQARA_SERVICE}`) ? instance.slice(0, -AQARA_SERVICE.length - 1) : instance,
      firmware: props.fw,
    });
  }
  return [...cameras.values()].sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
}

function parseTxt(data: unknown): Record<string, string> {
  const entries = Array.isArray(data) ? data : [data];
  const props: Record<string, string> = {};
  for (const entry of entries) {
    const text = Buffer.isBuffer(entry) ? entry.toString('utf8') : String(entry ?? '');
    const index = text.indexOf('=');
    if (index > 0) props[text.slice(0, index).toLowerCase()] = text.slice(index + 1);
  }
  return props;
}

/** Ask the network for Aqara cameras and collect answers for `timeoutMs`. */
export async function discoverMdns(timeoutMs = 4000, logger?: Logger): Promise<MdnsCamera[]> {
  const mdns = multicastDns();
  const records: DnsRecord[] = [];
  mdns.on('response', (response) => {
    for (const record of [...(response.answers ?? []), ...(response.additionals ?? [])]) {
      records.push(record as DnsRecord);
    }
  });
  mdns.on('error', (error: Error) => logger?.debug?.(`mDNS error: ${error.message}`));

  const query = (): void => mdns.query({ questions: [{ name: AQARA_SERVICE, type: 'PTR' }] });
  query();
  // A second query catches cameras whose first answer was lost.
  const retry = setTimeout(query, Math.min(1000, timeoutMs / 2));
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  clearTimeout(retry);
  mdns.destroy();

  return camerasFromRecords(records);
}
