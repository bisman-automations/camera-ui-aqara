import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import { AqaraTalkback, clampCallSeconds } from '../src/talkback.js';

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
  constructor(
    private readonly refuse = false,
    private readonly connectMs = 10,
    /** Like AqaraTalkClient: connect() rejects when disconnect() ran while it connected. */
    private readonly stopAware = false,
  ) {
    super();
  }
  public async connect(): Promise<void> {
    const disconnectsBefore = this.disconnects;
    await new Promise((resolve) => setTimeout(resolve, this.connectMs));
    if (this.refuse) throw new Error('The camera refused to start talking (ack 1).');
    if (this.stopAware && this.disconnects !== disconnectsBefore) throw new Error('The talk session was stopped while connecting');
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

  it('ends a call at the maximum duration and stays muted until the audio pauses', async () => {
    const clients: FakeClient[] = [];
    const talkback = new AqaraTalkback({
      host: '192.0.2.10',
      createTranscoder: fakeTranscoder().factory,
      createClient: (() => {
        const client = new FakeClient();
        clients.push(client);
        return client;
      }) as unknown as TalkClientFactory,
      idleTimeoutMs: 150,
      maxCallMs: () => 120,
    });

    // A talker that never stops sending, like an open HomeKit mic.
    let marker = 0;
    const sender = setInterval(() => talkback.push(Buffer.from([++marker & 0xff])), 20);
    await wait(500);
    assert.equal(clients.length, 1, 'no new call while the audio keeps coming');
    assert.equal(clients[0].disconnects, 1, 'the call was cut off');
    assert.equal(talkback.active, false);

    // Once the talker pauses, the next press starts a fresh call.
    clearInterval(sender);
    await wait(250);
    talkback.push(Buffer.from([1]));
    await wait(60);
    assert.equal(clients.length, 2);
    await talkback.stop();
  });

  it('closes a session that finishes opening after stop()', async () => {
    const clients: FakeClient[] = [];
    const logs: string[] = [];
    const talkback = new AqaraTalkback({
      host: '192.0.2.10',
      createTranscoder: fakeTranscoder().factory,
      createClient: (() => {
        const client = new FakeClient(false, 60);
        clients.push(client);
        return client;
      }) as unknown as TalkClientFactory,
      idleTimeoutMs: 1000,
      maxCallMs: () => 30,
      logger: { log: (...args: unknown[]) => logs.push(args.join(' ')) },
    });
    talkback.push(Buffer.from([1]));
    await wait(10);
    await talkback.stop();
    await wait(150);
    assert.equal(clients.length, 1);
    assert.equal(clients[0].connected, false, 'the late session was closed');
    assert.deepEqual(clients[0].frames, []);
    assert.ok(!logs.some((message) => message.includes('maximum call duration')), logs.join('\n'));
    assert.equal(talkback.active, false);
  });

  it('does not wait out the cooldown after stopping a session that was opening', async () => {
    const clients: FakeClient[] = [];
    const logs: string[] = [];
    const talkback = new AqaraTalkback({
      host: '192.0.2.10',
      createTranscoder: fakeTranscoder().factory,
      createClient: (() => {
        const client = new FakeClient(false, 60, true);
        clients.push(client);
        return client;
      }) as unknown as TalkClientFactory,
      idleTimeoutMs: 1000,
      cooldownMs: 10_000,
      maxCallMs: () => 30,
      logger: { log: (...args: unknown[]) => logs.push(args.join(' ')) },
    });
    talkback.push(Buffer.from([1]));
    await wait(10);
    await talkback.stop();
    await wait(100);
    assert.equal(clients[0].disconnects, 1);
    assert.ok(!logs.some((message) => message.includes('maximum call duration')), logs.join('\n'));

    talkback.push(Buffer.from([2]));
    await wait(100);
    assert.equal(clients.length, 2, 'the next burst is not blocked');
    assert.deepEqual(
      clients[1].frames.map((frame) => frame[7]),
      [2],
    );
    await talkback.stop();
  });

  it('ends the session shortly after the last of many packets', async () => {
    const clients: FakeClient[] = [];
    const talkback = new AqaraTalkback({
      host: '192.0.2.10',
      createTranscoder: fakeTranscoder().factory,
      createClient: (() => {
        const client = new FakeClient();
        clients.push(client);
        return client;
      }) as unknown as TalkClientFactory,
      idleTimeoutMs: 100,
      maxQueuedFrames: 1,
    });
    let endedAt = 0;
    for (let i = 0; i < 100; i++) {
      talkback.push(Buffer.from([i & 0xff]));
      await wait(2);
    }
    const lastAt = Date.now();
    assert.equal(clients.length, 1);
    clients[0].once('close', () => (endedAt = Date.now()));
    while (!endedAt && Date.now() - lastAt < 2000) await wait(5);
    const after = endedAt - lastAt;
    // The idle timeout, then the drain (one queued frame at most, plus 250 ms).
    assert.ok(after >= 90 && after <= 100 + 64 + 250 + 150, `ended ${after} ms after the last packet`);
    assert.equal(clients[0].disconnects, 1);
    assert.equal(talkback.active, false);
  });

  it('reads the call limit setting', () => {
    assert.equal(clampCallSeconds(180), 180);
    assert.equal(clampCallSeconds('45'), 45);
    assert.equal(clampCallSeconds(0), 0);
    assert.equal(clampCallSeconds(-5), 0);
    assert.equal(clampCallSeconds(3), 10);
    assert.equal(clampCallSeconds(99_999), 3600);
    assert.equal(clampCallSeconds('nope'), 180);
  });
});
