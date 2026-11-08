import { connect } from 'node:net';

import { authorization, parseChallenge } from './digest.js';

import type { Socket } from 'node:net';
import type { AuthChallenge } from './digest.js';
import { RTSP_PORT } from './protocol.js';

/**
 * Stream paths Aqara cameras are known to serve on port 8554. Most models use
 * ch1 (high), ch2 (medium) and ch3 (low), the G5 Pro adds ch4; some doorbells, the G3 and the G5
 * Pro name the stream after its resolution instead.
 */
export const DEFAULT_RTSP_PATHS = ['ch1', 'ch2', 'ch3'];
export const CANDIDATE_RTSP_PATHS = ['ch1', 'ch2', 'ch3', 'ch4', '1520p', '1296p', '1080p', '720p', '360p'];

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
    if (path === 'ch4' && found.length > 0) break;
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
 * Used to check the credentials and which channels the camera serves,
 * without opening a media session. Everything happens on one connection, the
 * way ffmpeg does it (OPTIONS, then DESCRIBE, then DESCRIBE with the login):
 * cameras tie the digest nonce to the connection that issued it, so a login
 * sent on a fresh connection is refused with 401.
 */
export async function describe(uri: string, timeoutMs = 5000): Promise<DescribeResult> {
  const url = new URL(uri);
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  url.username = '';
  url.password = '';
  const target = url.toString();

  const connection = await RtspConnection.open(url.hostname, Number(url.port) || 554, timeoutMs);
  try {
    let challenge: AuthChallenge | undefined;
    const send = async (method: string): Promise<RtspResponse> => {
      let response = await connection.request(method, target, challenge && authorization(challenge, method, target, username, password));
      if (response.status === 401 && username) {
        const next = parseChallenge(response.headers['www-authenticate']);
        // A second 401 to a login answering the same challenge means the credentials are wrong.
        if (!next || (challenge && next.nonce === challenge.nonce && next.scheme === challenge.scheme)) return response;
        challenge = next;
        response = await connection.request(method, target, authorization(challenge, method, target, username, password));
      }
      return response;
    };

    const options = await send('OPTIONS');
    if (options.status === 401 || options.status === 403) return options;
    return await send('DESCRIBE');
  } finally {
    connection.close();
  }
}

interface RtspResponse extends DescribeResult {
  headers: Record<string, string[]>;
}

/** One RTSP control connection that sends requests in turn and reads their responses. */
class RtspConnection {
  private data = Buffer.alloc(0);
  private cseq = 0;
  private pending?: { resolve: (response: RtspResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
  private closedError?: Error;

  private constructor(
    private readonly socket: Socket,
    private readonly label: string,
    private readonly timeoutMs: number,
  ) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (error) => this.fail(new Error(`Could not reach ${label}: ${error.message}`)));
    socket.on('close', () => this.onClose());
  }

  public static open(host: string, port: number, timeoutMs: number): Promise<RtspConnection> {
    const label = `${host}:${port}`;
    return new Promise<RtspConnection>((resolve, reject) => {
      const socket = connect({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`No RTSP answer from ${label} within ${timeoutMs} ms`));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.removeAllListeners('error');
        resolve(new RtspConnection(socket, label, timeoutMs));
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`Could not reach ${label}: ${error.message}`));
      });
    });
  }

  public request(method: string, uri: string, auth?: string): Promise<RtspResponse> {
    if (this.closedError) return Promise.reject(this.closedError);
    const lines = [`${method} ${uri} RTSP/1.0`, `CSeq: ${++this.cseq}`, 'User-Agent: camera-ui-aqara'];
    if (method === 'DESCRIBE') lines.push('Accept: application/sdp');
    if (auth) lines.push(`Authorization: ${auth}`);
    return new Promise<RtspResponse>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`No RTSP answer from ${this.label} within ${this.timeoutMs} ms`)), this.timeoutMs);
      this.pending = { resolve, reject, timer };
      this.socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
  }

  public close(): void {
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    this.data = Buffer.concat([this.data, chunk]);
    let response: ReturnType<typeof parseResponse>;
    try {
      response = parseResponse(this.data);
    } catch (error) {
      this.fail(new Error(`${this.label} did not answer like an RTSP server: ${(error as Error).message}`));
      return;
    }
    if (!response) return;
    this.data = this.data.subarray(response.consumed);
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve(response);
    }
  }

  private onClose(): void {
    // A server may answer and hang up at once; hand over a response that is already complete.
    let response: RtspResponse | undefined;
    try {
      response = this.data.length > 0 ? parseResponse(this.data, true) : undefined;
    } catch {
      response = undefined;
    }
    if (response && this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.resolve(response);
    }
    this.fail(new Error(`${this.label} closed the connection without an RTSP answer`));
  }

  private fail(error: Error): void {
    this.closedError ??= error;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.socket.destroy();
  }
}

/** Parse a complete RTSP response, or return undefined while more bytes are needed. */
export function parseResponse(data: Buffer, ended = false): (RtspResponse & { consumed: number }) | undefined {
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
  return {
    status: Number(statusMatch[1]),
    headers,
    sdp: length > 0 ? body.subarray(0, length).toString('utf8') : undefined,
    consumed: headerEnd + 4 + Math.min(length, body.length),
  };
}
