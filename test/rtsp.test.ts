import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { authorization, parseChallenge } from '../src/digest.js';
import {
  aqaraRtspUrl,
  describe as rtspDescribe,
  parseResponse,
  probeRtspPaths,
  redact,
  stripCredentials,
  withCredentials,
  withPasswordPlaceholder,
} from '../src/rtsp.js';

import type { AddressInfo, Server } from 'node:net';

describe('digest auth', () => {
  it('matches the RFC 2617 example', () => {
    const challenge = parseChallenge(
      'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
    );
    assert.ok(challenge);
    const header = authorization(challenge, 'GET', '/dir/index.html', 'Mufasa', 'Circle Of Life', '0a4f113b');
    assert.match(header, /response="6629fae49393a05397450978507c4ef1"/);
    assert.match(header, /qop=auth, nc=00000001, cnonce="0a4f113b"/);
  });

  it('prefers digest over basic and falls back to basic', () => {
    assert.equal(parseChallenge(['Basic realm="x"', 'Digest realm="y", nonce="n"'])?.scheme, 'digest');
    assert.equal(parseChallenge('Basic realm="x"')?.scheme, 'basic');
    assert.equal(authorization({ scheme: 'basic' }, 'DESCRIBE', '/', 'a', 'b'), 'Basic YTpi');
  });
});

describe('stream URLs', () => {
  it('builds, credentials, strips and redacts', () => {
    const url = aqaraRtspUrl('192.0.2.21', 'user', 'p@ss word', 'ch2');
    assert.equal(url, 'rtsp://user:p%40ss%20word@192.0.2.21:8554/ch2');
    assert.equal(redact(url), 'rtsp://user:***@192.0.2.21:8554/ch2');
    assert.equal(stripCredentials(url), 'rtsp://192.0.2.21:8554/ch2');
    assert.equal(withPasswordPlaceholder(url), 'rtsp://user:<password>@192.0.2.21:8554/ch2');
    assert.equal(withCredentials('rtsp://old:x@192.0.2.21:554/main', 'new', 'y'), 'rtsp://new:y@192.0.2.21:554/main');
  });

  it('parses an RTSP response with a body', () => {
    const data = Buffer.from('RTSP/1.0 200 OK\r\nCSeq: 1\r\nContent-Length: 4\r\n\r\nv=0\n');
    assert.deepEqual(parseResponse(data)?.sdp, 'v=0\n');
    assert.equal(parseResponse(data.subarray(0, 30)), undefined);
  });
});

describe('RTSP probing', () => {
  let server: Server;
  let port: number;
  const served = new Set(['ch1', 'ch2']);

  before(async () => {
    // A camera like Aqara's: digest auth for admin/secret, a nonce per
    // connection (a login from another connection is refused), several
    // requests per connection, and ch1 and ch2 served.
    let connections = 0;
    server = createServer((socket) => {
      const nonce = `n${++connections}`;
      let buffer = '';
      socket.on('data', (data) => {
        buffer += data.toString();
        for (let end = buffer.indexOf('\r\n\r\n'); end >= 0; end = buffer.indexOf('\r\n\r\n')) {
          const text = buffer.slice(0, end + 4);
          buffer = buffer.slice(end + 4);
          const [method, uri] = text.split(' ');
          const path = /^rtsp:\/\/[^/]+\/(\S+)$/.exec(uri)?.[1] ?? '';
          const cseq = /CSeq: (\d+)/.exec(text)?.[1];
          const auth = /Authorization: (.*)\r\n/.exec(text)?.[1];
          const challenge = `RTSP/1.0 401 Unauthorized\r\nCSeq: ${cseq}\r\nWWW-Authenticate: Digest realm="aqara", nonce="${nonce}"\r\n\r\n`;
          let reply: string;
          if (!auth) {
            reply = challenge;
          } else {
            const field = (name: string): string => new RegExp(`${name}="([^"]*)"`).exec(auth)?.[1] ?? '';
            const md5 = (value: string): string => createHash('md5').update(value).digest('hex');
            const expected = md5(`${md5(`admin:aqara:secret`)}:${nonce}:${md5(`${method}:${uri}`)}`);
            const valid = field('username') === 'admin' && field('nonce') === nonce && field('response') === expected;
            if (!valid) reply = challenge;
            else if (method === 'OPTIONS') reply = `RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nPublic: OPTIONS, DESCRIBE, SETUP, PLAY\r\n\r\n`;
            else if (served.has(path)) reply = `RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nContent-Type: application/sdp\r\nContent-Length: 5\r\n\r\nv=0\r\n`;
            else reply = `RTSP/1.0 404 Not Found\r\nCSeq: ${cseq}\r\n\r\n`;
          }
          socket.write(reply);
        }
      });
      socket.on('error', () => undefined);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as AddressInfo).port;
  });

  after(() => server.close());

  it('authenticates a DESCRIBE', async () => {
    const result = await rtspDescribe(`rtsp://admin:secret@127.0.0.1:${port}/ch1`);
    assert.equal(result.status, 200);
    assert.equal(result.sdp, 'v=0\r\n');
  });

  it('finds the channels the camera serves without trying resolution names', async () => {
    const outcome = await probeRtspPaths('127.0.0.1', 'admin', 'secret', { port });
    assert.deepEqual(outcome, { paths: ['ch1', 'ch2'] });
  });

  it("finds the G5 Pro's four channels", async () => {
    served.add('ch3').add('ch4');
    try {
      assert.deepEqual(await probeRtspPaths('127.0.0.1', 'admin', 'secret', { port }), { paths: ['ch1', 'ch2', 'ch3', 'ch4'] });
    } finally {
      served.delete('ch3');
      served.delete('ch4');
    }
  });

  it('falls back to resolution-named paths', async () => {
    served.clear();
    served.add('1296p').add('360p');
    try {
      assert.deepEqual(await probeRtspPaths('127.0.0.1', 'admin', 'secret', { port }), { paths: ['1296p', '360p'] });
    } finally {
      served.clear();
      served.add('ch1').add('ch2');
    }
  });

  it('stops at wrong credentials', async () => {
    const outcome = await probeRtspPaths('127.0.0.1', 'intruder', 'nope', { port });
    assert.ok('error' in outcome && outcome.error === 'unauthorized');
  });

  it('says when nothing answers', async () => {
    const outcome = await probeRtspPaths('127.0.0.1', 'admin', 'secret', { port: 1, timeoutMs: 500 });
    assert.ok('error' in outcome && outcome.error === 'unreachable');
  });

  it('reports wrong credentials', async () => {
    const result = await rtspDescribe(`rtsp://intruder:nope@127.0.0.1:${port}/ch1`);
    assert.equal(result.status, 401);
  });
});
