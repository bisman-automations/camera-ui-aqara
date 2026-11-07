import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import { AqaraTalkback } from '../src/talkback.js';

import type { TalkClientFactory, Transcoder } from '../src/talkback.js';

function adtsFrame(marker: number): Buffer {
  const length = 12;
  const frame = Buffer.alloc(length, marker);
  frame[0] = 0xff;
  frame[1] = 0xf1;
  frame[2] = 0x60;
  frame[3] = 0x40;
  frame[4] = (length >> 3) & 0xff;
  frame[5] = ((length & 0x07) << 5) | 0x1f;
  frame[6] = 0xfc;
  return frame;
}

class FakeClient extends EventEmitter {
  public connected = false;
  public frames: Buffer[] = [];
  public sentAt: number[] = [];
  public disconnects = 0;
  constructor(private readonly refuse = false) {
    super();
  }
  public async connect(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (this.refuse) throw new Error('The camera refused to start talking (ack 1).');
    this.connected = true;
  }
  public sendFrame(frame: Buffer): void {
    this.frames.push(frame);
    this.sentAt.push(Date.now());
  }
  public async disconnect(): Promise<void> {
    this.disconnects++;
    this.connected = false;
    this.emit('close');
  }
}

/** A transcoder that turns each pushed packet into one ADTS frame tagged with the packet's first byte. */
function fakeTranscoder(): { factory: (output: (chunk: Buffer) => void) => Transcoder; started: () => number; closed: () => number } {
  let started = 0;
  let closed = 0;
  return {
    factory: (output) => ({
      start: async () => void started++,
      push: (rtp) => output(adtsFrame(rtp[0])),
      close: async () => void closed++,
    }),
    started: () => started,
    closed: () => closed,
  };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('AqaraTalkback', () => {
  it('opens one session per talk burst and plays frames in order at real-time pace', async () => {
    const clients: FakeClient[] = [];
    const transcoder = fakeTranscoder();
    const talkback = new AqaraTalkback({
      host: '192.0.2.10',
      createTranscoder: transcoder.factory,
      createClient: ((host: string) => {
        assert.equal(host, '192.0.2.10');
        const client = new FakeClient();
        clients.push(client);
        return client;
      }) as unknown as TalkClientFactory,
      idleTimeoutMs: 200,
    });

    for (let i = 1; i <= 4; i++) talkback.push(Buffer.from([i]));
    await wait(300);

    assert.equal(clients.length, 1);
    assert.equal(transcoder.started(), 1);
    assert.deepEqual(
      clients[0].frames.map((frame) => frame[7]),
      [1, 2, 3, 4],
    );
    const gaps = clients[0].sentAt.slice(1).map((at, i) => at - clients[0].sentAt[i]);
    assert.ok(
      gaps.every((gap) => gap >= 50),
      `frames 64 ms apart, got ${gaps.join(', ')}`,
    );

    // The burst went quiet, so the session drains and ends.
    await wait(500);
    assert.equal(clients[0].disconnects, 1);
    assert.equal(transcoder.closed(), 1);
    assert.equal(talkback.active, false);
  });

  it('keeps only the newest frames when audio piles up while the session opens', async () => {
    const clients: FakeClient[] = [];
    const talkback = new AqaraTalkback({
      host: '192.0.2.10',
      createTranscoder: fakeTranscoder().factory,
      createClient: (() => {
        const client = new FakeClient();
        clients.push(client);
        return client;
      }) as unknown as TalkClientFactory,
      maxQueuedFrames: 3,
      idleTimeoutMs: 100,
    });
    for (let i = 1; i <= 10; i++) talkback.push(Buffer.from([i]));
    await wait(400);
    assert.deepEqual(
      clients[0].frames.map((frame) => frame[7]),
      [8, 9, 10],
    );
    await talkback.stop();
  });

  it('waits out a cooldown after the camera refuses a session', async () => {
    const clients: FakeClient[] = [];
    const talkback = new AqaraTalkback({
      host: '192.0.2.10',
      createTranscoder: fakeTranscoder().factory,
      createClient: (() => {
        const client = new FakeClient(true);
        clients.push(client);
        return client;
      }) as unknown as TalkClientFactory,
      cooldownMs: 10_000,
      idleTimeoutMs: 50,
    });
    talkback.push(Buffer.from([1]));
    await wait(100);
    talkback.push(Buffer.from([2]));
    await wait(100);
    assert.equal(clients.length, 1, 'no new session during the cooldown');
    await talkback.stop();
  });

  it('starts a fresh session for the next burst after stop()', async () => {
    const clients: FakeClient[] = [];
    const talkback = new AqaraTalkback({
      host: '192.0.2.10',
      createTranscoder: fakeTranscoder().factory,
      createClient: (() => {
        const client = new FakeClient();
        clients.push(client);
        return client;
      }) as unknown as TalkClientFactory,
      idleTimeoutMs: 1000,
    });
    talkback.push(Buffer.from([1]));
    await wait(50);
    await talkback.stop();
    talkback.push(Buffer.from([2]));
    await wait(50);
    assert.equal(clients.length, 2);
    assert.deepEqual(
      clients[1].frames.map((frame) => frame[7]),
      [2],
    );
    await talkback.stop();
  });
});
