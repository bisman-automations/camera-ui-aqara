import { createHash, randomBytes } from 'node:crypto';

/** A parsed `WWW-Authenticate` challenge. */
export interface AuthChallenge {
  scheme: 'basic' | 'digest';
  realm?: string;
  nonce?: string;
  qop?: string;
  opaque?: string;
  algorithm?: string;
}

/** Pick the strongest challenge from one or more `WWW-Authenticate` header values. */
export function parseChallenge(headers: string | string[] | undefined): AuthChallenge | undefined {
  const values = (Array.isArray(headers) ? headers : headers ? [headers] : []).flatMap((value) => splitChallenges(value));
  let basic: AuthChallenge | undefined;
  for (const value of values) {
    const space = value.indexOf(' ');
    const scheme = (space < 0 ? value : value.slice(0, space)).toLowerCase();
    const params = parseParams(space < 0 ? '' : value.slice(space + 1));
    if (scheme === 'digest') {
      return { scheme: 'digest', realm: params.realm, nonce: params.nonce, qop: params.qop, opaque: params.opaque, algorithm: params.algorithm };
    }
    if (scheme === 'basic') basic = { scheme: 'basic', realm: params.realm };
  }
  return basic;
}

/** Build the `Authorization` header value answering a challenge. */
export function authorization(
  challenge: AuthChallenge,
  method: string,
  uri: string,
  username: string,
  password: string,
  cnonce = randomBytes(8).toString('hex'),
): string {
  if (challenge.scheme === 'basic') {
    return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }

  const algorithm = (challenge.algorithm ?? 'MD5').toUpperCase();
  const hashName = algorithm.startsWith('SHA-256') ? 'sha256' : 'md5';
  const hash = (text: string): string => createHash(hashName).update(text).digest('hex');
  const realm = challenge.realm ?? '';
  const nonce = challenge.nonce ?? '';
  const qop = challenge.qop
    ?.split(',')
    .map((value) => value.trim())
    .find((value) => value === 'auth');
  const nc = '00000001';

  let ha1 = hash(`${username}:${realm}:${password}`);
  if (algorithm.endsWith('-SESS')) ha1 = hash(`${ha1}:${nonce}:${cnonce}`);
  const ha2 = hash(`${method}:${uri}`);
  const response = qop ? hash(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : hash(`${ha1}:${nonce}:${ha2}`);

  const parts = [`username="${username}"`, `realm="${realm}"`, `nonce="${nonce}"`, `uri="${uri}"`, `response="${response}"`];
  if (challenge.algorithm) parts.push(`algorithm=${challenge.algorithm}`);
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${parts.join(', ')}`;
}

/** Split a header that may hold several challenges ("Digest a=1, Basic realm=x"). */
function splitChallenges(value: string): string[] {
  const result: string[] = [];
  const pattern = /(?:^|,)\s*(basic|digest)\s/gi;
  const starts: number[] = [];
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    starts.push(match.index + match[0].search(/\S/));
  }
  if (starts.length === 0) return value.trim() ? [value.trim()] : [];
  for (let i = 0; i < starts.length; i++) {
    result.push(
      value
        .slice(starts[i], starts[i + 1])
        .replace(/,\s*$/, '')
        .trim(),
    );
  }
  return result;
}

function parseParams(text: string): Record<string, string> {
  const params: Record<string, string> = {};
  const pattern = /([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/gi;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    params[match[1].toLowerCase()] = match[2] ?? match[3] ?? '';
  }
  return params;
}
