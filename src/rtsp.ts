import { connect } from 'node:net';

import { authorization, parseChallenge } from './digest.js';
import { RTSP_PORT } from './protocol.js';

/**
 * Stream paths Aqara cameras are known to serve on port 8554. Most models use
 * ch1 (high), ch2 (medium) and ch3 (low); some doorbells, the G3 and the G5
 * Pro name the stream after its resolution instead.
 */
export const DEFAULT_RTSP_PATHS = ['ch1', 'ch2', 'ch3'];
export const CANDIDATE_RTSP_PATHS = ['ch1', 'ch2', 'ch3', '1520p', '1296p', '1080p', '720p', '360p'];

/** The camera's own RTSP stream at a path such as ch1. */
export function aqaraRtspUrl(host: string, username: string, password: string, path: string, port = RTSP_PORT): string {
  return withCredentials(`rtsp://${host}:${port}/${path.replace(/^\/+/, '')}`, username, password);
}

export type ProbeOutcome = { paths: string[] } | { error: 'unauthorized' | 'unreachable' | 'no-streams'; message: string };

/**
 * Find which of the known stream paths the camera serves, best first. Stops
 * early when the camera rejects the credentials or cannot be reached.
 */
export async function probeRtspPaths(
  host: string,
  username: string,
  password: string,
  { candidates = CANDIDATE_RTSP_PATHS, timeoutMs = 4000, port = RTSP_PORT }: { candidates?: string[]; timeoutMs?: number; port?: number } = {},
): Promise<ProbeOutcome> {
  const found: string[] = [];
  for (const path of candidates) {
    let result: DescribeResult;
    try {
      result = await describe(aqaraRtspUrl(host, username, password, path, port), timeoutMs);
    } catch (error) {
      if (found.length > 0) continue;
      return { error: 'unreachable', message: (error as Error).message };
    }
    if (result.status === 401 || result.status === 403) {
      return { error: 'unauthorized', message: `The camera rejected the username or password (RTSP ${result.status})` };
    }
    if (result.status === 200) found.push(path);
    // Cameras that use the chN names do not also serve resolution names.
    if (path === 'ch3' && found.length > 0) break;
  }
  if (found.length === 0) return { error: 'no-streams', message: `The camera serves none of the known stream paths (${candidates.join(', ')})` };
  return { paths: found };
}

/** Put credentials into a stream URL, replacing any it already has. */
export function withCredentials(uri: string, username: string, password: string): string {
  if (!username) return uri;
  try {
    const url = new URL(uri);
    url.username = encodeURIComponent(username);
    url.password = encodeURIComponent(password);
    return url.toString();
  } catch {
    return uri;
  }
}

/** A stream URL without credentials, for storing. */
export function stripCredentials(uri: string): string {
  try {
    const url = new URL(uri);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return uri;
  }
}

/** A stream URL that is safe to log. */
export function redact(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return uri;
  }
}

export interface DescribeResult {
  status: number;
  /** The SDP body when the camera answered 200. */
  sdp?: string;
}

/**
 * Send an RTSP DESCRIBE for a stream, answering an auth challenge once.
 *
 * Used at adoption to check the credentials and which channels the camera
 * serves, without opening a media session.
 */
export async function describe(uri: string, timeoutMs = 5000): Promise<DescribeResult> {
  const url = new URL(uri);
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  url.username = '';
  url.password = '';
  const target = url.toString();

  const first = await request(url.hostname, Number(url.port) || 554, describeRequest(target, 1), timeoutMs);
  if (first.status !== 401 || !username) return first;

  const challenge = parseChallenge(first.headers['www-authenticate']);
  if (!challenge) return first;
  return request(
    url.hostname,
    Number(url.port) || 554,
    describeRequest(target, 2, authorization(challenge, 'DESCRIBE', target, username, password)),
    timeoutMs,
  );
}

function describeRequest(uri: string, cseq: number, auth?: string): string {
  const lines = [`DESCRIBE ${uri} RTSP/1.0`, `CSeq: ${cseq}`, 'Accept: application/sdp', 'User-Agent: camera-ui-aqara'];
  if (auth) lines.push(`Authorization: ${auth}`);
  return `${lines.join('\r\n')}\r\n\r\n`;
}

interface RtspResponse extends DescribeResult {
  headers: Record<string, string[]>;
}

function request(host: string, port: number, message: string, timeoutMs: number): Promise<RtspResponse> {
  return new Promise<RtspResponse>((resolve, reject) => {
    const socket = connect({ host, port });
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`No RTSP answer from ${host}:${port} within ${timeoutMs} ms`));
    }, timeoutMs);
    const finish = (result: RtspResponse | Error): void => {
      clearTimeout(timer);
      socket.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    socket.once('connect', () => socket.write(message));
    socket.on('error', (error) => finish(new Error(`Could not reach ${host}:${port}: ${error.message}`)));
    socket.on('data', (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      try {
        const parsed = parseResponse(data);
        if (parsed) finish(parsed);
      } catch (error) {
        finish(new Error(`${host}:${port} did not answer like an RTSP server: ${(error as Error).message}`));
      }
    });
    socket.on('end', () => {
      try {
        finish(parseResponse(data, true) ?? new Error(`${host}:${port} closed the connection without an RTSP answer`));
      } catch (error) {
        finish(error as Error);
      }
    });
  });
}

/** Parse a complete RTSP response, or return undefined while more bytes are needed. */
export function parseResponse(data: Buffer, ended = false): RtspResponse | undefined {
  const headerEnd = data.indexOf('\r\n\r\n');
  if (headerEnd < 0) return undefined;
  const lines = data.subarray(0, headerEnd).toString('utf8').split('\r\n');
  const statusMatch = /^RTSP\/\d\.\d\s+(\d{3})/.exec(lines[0] ?? '');
  if (!statusMatch) throw new Error('Not an RTSP response');

  const headers: Record<string, string[]> = {};
  for (const line of lines.slice(1)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim().toLowerCase();
    (headers[key] ??= []).push(line.slice(index + 1).trim());
  }
  const length = Number(headers['content-length']?.[0] ?? 0);
  const body = data.subarray(headerEnd + 4);
  if (body.length < length && !ended) return undefined;
  return { status: Number(statusMatch[1]), headers, sdp: length > 0 ? body.subarray(0, length).toString('utf8') : undefined };
}
