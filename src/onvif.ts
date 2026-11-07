import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';

import { authorization, parseChallenge } from './digest.js';

import type { Logger } from './types.js';

/**
 * A small ONVIF client: just what it takes to find a camera and read its
 * stream URLs (device information, media service address, profiles and stream
 * URIs). Requests carry a WS-UsernameToken and fall back to HTTP digest or
 * basic auth when the camera asks for it.
 */

const SOAP_ENV = 'http://www.w3.org/2003/05/soap-envelope';
const NS_DEVICE = 'http://www.onvif.org/ver10/device/wsdl';
const NS_MEDIA = 'http://www.onvif.org/ver10/media/wsdl';
const NS_SCHEMA = 'http://www.onvif.org/ver10/schema';

export interface OnvifDeviceInfo {
  manufacturer?: string;
  model?: string;
  firmwareVersion?: string;
  serialNumber?: string;
  hardwareId?: string;
}

export interface OnvifProfile {
  token: string;
  name: string;
  width?: number;
  height?: number;
  encoding?: string;
}

export interface OnvifStream extends OnvifProfile {
  uri: string;
}

export class OnvifError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'OnvifError';
  }
}

export class OnvifClient {
  private clockOffsetMs = 0;
  private clockChecked = false;
  private mediaAddress?: string;

  constructor(
    public readonly deviceAddress: string,
    private readonly username: string,
    private readonly password: string,
    private readonly options: { timeoutMs?: number; logger?: Logger } = {},
  ) {}

  public async getDeviceInformation(): Promise<OnvifDeviceInfo> {
    const xml = await this.call(this.deviceAddress, '<tds:GetDeviceInformation/>');
    return {
      manufacturer: textOf(xml, 'Manufacturer'),
      model: textOf(xml, 'Model'),
      firmwareVersion: textOf(xml, 'FirmwareVersion'),
      serialNumber: textOf(xml, 'SerialNumber'),
      hardwareId: textOf(xml, 'HardwareId'),
    };
  }

  /** The media service address, from GetCapabilities. Falls back to the device address. */
  public async getMediaAddress(): Promise<string> {
    if (this.mediaAddress) return this.mediaAddress;
    try {
      const xml = await this.call(this.deviceAddress, '<tds:GetCapabilities><tds:Category>Media</tds:Category></tds:GetCapabilities>');
      const media = elementsOf(xml, 'Media')[0];
      const address = media ? textOf(media, 'XAddr') : undefined;
      this.mediaAddress = address ? this.rebase(address) : this.deviceAddress;
    } catch (error) {
      this.options.logger?.debug?.(`GetCapabilities failed, using the device address for media: ${(error as Error).message}`);
      this.mediaAddress = this.deviceAddress;
    }
    return this.mediaAddress;
  }

  public async getProfiles(): Promise<OnvifProfile[]> {
    const xml = await this.call(await this.getMediaAddress(), '<trt:GetProfiles/>');
    return elementsOf(xml, 'Profiles').map((profile) => {
      const encoder = elementsOf(profile, 'VideoEncoderConfiguration')[0] ?? '';
      const resolution = elementsOf(encoder, 'Resolution')[0] ?? '';
      return {
        token: attributeOf(profile, 'token') ?? '',
        name: textOf(profile, 'Name') ?? '',
        width: numberOf(resolution, 'Width'),
        height: numberOf(resolution, 'Height'),
        encoding: textOf(encoder, 'Encoding'),
      };
    });
  }

  public async getStreamUri(profileToken: string): Promise<string> {
    const body =
      '<trt:GetStreamUri><trt:StreamSetup>' +
      '<tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport>' +
      `</trt:StreamSetup><trt:ProfileToken>${escapeXml(profileToken)}</trt:ProfileToken></trt:GetStreamUri>`;
    const xml = await this.call(await this.getMediaAddress(), body);
    const uri = textOf(elementsOf(xml, 'MediaUri')[0] ?? xml, 'Uri');
    if (!uri) throw new OnvifError(`The camera returned no stream URI for profile ${profileToken}`);
    return this.rebase(decodeXml(uri));
  }

  /**
   * Every video profile with its stream URI, highest resolution first. Profiles
   * that share a URI are listed once, and profiles without video are skipped.
   */
  public async getStreams(): Promise<OnvifStream[]> {
    const profiles = (await this.getProfiles()).filter((profile) => profile.token);
    const streams: OnvifStream[] = [];
    for (const profile of profiles) {
      try {
        const uri = await this.getStreamUri(profile.token);
        if (!streams.some((stream) => stream.uri === uri)) streams.push({ ...profile, uri });
      } catch (error) {
        this.options.logger?.debug?.(`No stream URI for ONVIF profile ${profile.name || profile.token}: ${(error as Error).message}`);
      }
    }
    return streams.sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));
  }

  /**
   * Some cameras report service and stream addresses with an IP they no longer
   * have, or with a hostname this machine cannot resolve. Keep the path and
   * port, but use the host this client talks to.
   */
  private rebase(address: string): string {
    try {
      const target = new URL(address);
      const device = new URL(this.deviceAddress);
      target.hostname = device.hostname;
      return target.toString();
    } catch {
      return address;
    }
  }

  private async syncClock(): Promise<void> {
    if (this.clockChecked) return;
    this.clockChecked = true;
    try {
      const xml = await this.post(this.deviceAddress, envelope('<tds:GetSystemDateAndTime/>'));
      const utc = elementsOf(xml, 'UTCDateTime')[0];
      if (!utc) return;
      const date = elementsOf(utc, 'Date')[0] ?? '';
      const time = elementsOf(utc, 'Time')[0] ?? '';
      const camera = Date.UTC(
        numberOf(date, 'Year') ?? 0,
        (numberOf(date, 'Month') ?? 1) - 1,
        numberOf(date, 'Day') ?? 1,
        numberOf(time, 'Hour') ?? 0,
        numberOf(time, 'Minute') ?? 0,
        numberOf(time, 'Second') ?? 0,
      );
      if (camera > 0) this.clockOffsetMs = camera - Date.now();
    } catch {
      // Unauthenticated time queries are optional; the local clock will do.
    }
  }

  private async call(address: string, body: string): Promise<string> {
    await this.syncClock();
    return this.post(address, envelope(body, this.securityHeader()));
  }

  private securityHeader(): string {
    if (!this.username) return '';
    const nonce = randomBytes(16);
    const created = new Date(Date.now() + this.clockOffsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const digest = createHash('sha1')
      .update(Buffer.concat([nonce, Buffer.from(created + this.password)]))
      .digest('base64');
    return (
      '<wsse:Security s:mustUnderstand="1" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" ' +
      'xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">' +
      `<wsse:UsernameToken><wsse:Username>${escapeXml(this.username)}</wsse:Username>` +
      '<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">' +
      `${digest}</wsse:Password>` +
      '<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">' +
      `${nonce.toString('base64')}</wsse:Nonce><wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security>`
    );
  }

  private async post(address: string, xml: string): Promise<string> {
    const send = (auth?: string): Promise<Response> =>
      fetch(address, {
        method: 'POST',
        headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', ...(auth ? { Authorization: auth } : {}) },
        body: xml,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
      });

    let response = await send();
    if (response.status === 401 && this.username) {
      const challenge = parseChallenge(response.headers.get('www-authenticate') ?? undefined);
      await response.body?.cancel();
      if (challenge) {
        const url = new URL(address);
        response = await send(authorization(challenge, 'POST', url.pathname + url.search, this.username, this.password));
      }
    }

    const text = await response.text();
    if (!response.ok) {
      const reason = textOf(text, 'Text') ?? textOf(text, 'Reason') ?? response.statusText;
      if (response.status === 401 || /not ?authori[sz]ed|sender not authorized/i.test(text)) {
        throw new OnvifError('The camera rejected the ONVIF username or password', response.status);
      }
      throw new OnvifError(`ONVIF request failed (${response.status}): ${reason}`, response.status);
    }
    return text;
  }
}

function envelope(body: string, header = ''): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="${SOAP_ENV}" xmlns:tds="${NS_DEVICE}" ` +
    `xmlns:trt="${NS_MEDIA}" xmlns:tt="${NS_SCHEMA}">` +
    `${header ? `<s:Header>${header}</s:Header>` : ''}<s:Body>${body}</s:Body></s:Envelope>`
  );
}

/** One ONVIF device answering a WS-Discovery probe. */
export interface WsDiscoveredDevice {
  host: string;
  /** Device service addresses (XAddrs). */
  addresses: string[];
  scopes: string[];
  name?: string;
  hardware?: string;
}

const WS_DISCOVERY_ADDRESS = '239.255.255.250';
const WS_DISCOVERY_PORT = 3702;

export function buildProbe(messageId = `uuid:${randomUUID()}`): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<s:Envelope xmlns:s="${SOAP_ENV}" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" ` +
    'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">' +
    `<s:Header><a:MessageID>${messageId}</a:MessageID><a:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To>` +
    '<a:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action></s:Header>' +
    '<s:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></s:Body></s:Envelope>'
  );
}

/** Read a WS-Discovery ProbeMatch reply. Returns undefined for anything else. */
export function parseProbeMatch(xml: string, fromHost: string): WsDiscoveredDevice | undefined {
  const match = elementsOf(xml, 'ProbeMatch')[0];
  if (!match) return undefined;
  const addresses = (textOf(match, 'XAddrs') ?? '').split(/\s+/).filter(Boolean);
  const scopes = (textOf(match, 'Scopes') ?? '').split(/\s+/).filter(Boolean);
  const scope = (kind: string): string | undefined => {
    const prefix = `onvif://www.onvif.org/${kind}/`;
    const value = scopes.find((item) => item.toLowerCase().startsWith(prefix));
    return value ? decodeURIComponent(value.slice(prefix.length)) : undefined;
  };
  // Prefer an address on the host that answered; a camera may list stale IPs.
  const local = addresses.find((address) => hostOf(address) === fromHost);
  return {
    host: fromHost,
    addresses: local ? [local, ...addresses.filter((address) => address !== local)] : addresses,
    scopes,
    name: scope('name'),
    hardware: scope('hardware'),
  };
}

/** Whether a discovered ONVIF device looks like an Aqara camera. */
export function isAqaraDevice(device: WsDiscoveredDevice): boolean {
  return device.scopes.some((scope) => /aqara|lumi/i.test(decodeURIComponentSafe(scope)));
}

/** Probe the network for ONVIF cameras with WS-Discovery. */
export async function discoverOnvif(timeoutMs = 4000, logger?: Logger): Promise<WsDiscoveredDevice[]> {
  const socket = createSocket({ type: 'udp4', reuseAddr: true });
  const found = new Map<string, WsDiscoveredDevice>();
  socket.on('message', (message, remote) => {
    const device = parseProbeMatch(message.toString('utf8'), remote.address);
    if (device && !found.has(device.host)) found.set(device.host, device);
  });
  socket.on('error', (error) => logger?.debug?.(`WS-Discovery error: ${error.message}`));

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, () => {
        socket.off('error', reject);
        resolve();
      });
    });
    const probe = Buffer.from(buildProbe());
    socket.send(probe, WS_DISCOVERY_PORT, WS_DISCOVERY_ADDRESS);
    const retry = setTimeout(() => socket.send(probe, WS_DISCOVERY_PORT, WS_DISCOVERY_ADDRESS), Math.min(1000, timeoutMs / 2));
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    clearTimeout(retry);
  } catch (error) {
    logger?.debug?.(`WS-Discovery could not run: ${(error as Error).message}`);
  } finally {
    socket.close();
  }
  return [...found.values()];
}

// Namespace-agnostic XML helpers. ONVIF replies are small and regular, which
// keeps this from needing an XML parser dependency.

/** The inner XML of every element with this local name, in document order. */
export function elementsOf(xml: string, localName: string): string[] {
  const results: string[] = [];
  const open = new RegExp(`<(?:[\\w-]+:)?${localName}(?=[\\s/>])[^>]*?(/?)>`, 'g');
  for (let match = open.exec(xml); match; match = open.exec(xml)) {
    if (match[1] === '/') {
      results.push(match[0]);
      continue;
    }
    const tag = match[0].slice(1).split(/[\s>]/)[0];
    const start = match.index + match[0].length;
    // Track nesting of the same element so <Profiles> inside <Profiles> cannot cut a match short.
    const sameTag = new RegExp(`<(/?)${tag.replace(':', '\\:')}(?=[\\s/>])[^>]*?(/?)>`, 'g');
    sameTag.lastIndex = start;
    let depth = 1;
    let end = -1;
    for (let inner = sameTag.exec(xml); inner; inner = sameTag.exec(xml)) {
      if (inner[1] === '/') depth--;
      else if (inner[2] !== '/') depth++;
      if (depth === 0) {
        end = inner.index;
        break;
      }
    }
    if (end < 0) break;
    results.push(match[0] + xml.slice(start, end));
    open.lastIndex = end;
  }
  return results;
}

export function textOf(xml: string, localName: string): string | undefined {
  const element = elementsOf(xml, localName)[0];
  if (element === undefined) return undefined;
  const text = element
    .replace(/^<[^>]*>/, '')
    .replace(/<[^>]+>/g, '')
    .trim();
  return text ? decodeXml(text) : undefined;
}

function numberOf(xml: string, localName: string): number | undefined {
  const value = Number(textOf(xml, localName));
  return Number.isFinite(value) ? value : undefined;
}

function attributeOf(element: string, name: string): string | undefined {
  const openTag = /^<[^>]*>/.exec(element)?.[0] ?? '';
  const match = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(openTag);
  return match ? decodeXml(match[1]) : undefined;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function hostOf(address: string): string | undefined {
  try {
    return new URL(address).hostname;
  } catch {
    return undefined;
  }
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
