import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { afterEach, describe, it } from 'node:test';

import { buildPacket, ControlPacketBuffer, PacketType, RTP_PAYLOAD_TYPE } from '../src/protocol.js';
import { AqaraTalkClient } from '../src/talk.js';

import type { AddressInfo, Server, Socket } from 'node:net';
import type { ControlPacket } from '../src/protocol.js';

interface FakeCamera {
  server: Server;
  port: number;
  received: ControlPacket[];
  sockets: Socket[];
}

/** A camera that answers control packets with the ack values the test gives. */
async function fakeCamera(answer: (packet: ControlPacket) => number | undefined): Promise<FakeCamera> {
  const received: ControlPacket[] = [];
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    const buffer = new ControlPacketBuffer();
    socket.on('data', (data) => {
      buffer.feed(data);
      for (let packet = buffer.pop(); packet; packet = buffer.pop()) {
        received.push(packet);
        const value = answer(packet);
        if (value !== undefined) socket.write(buildPacket(PacketType.Ack, value));
      }
    });
    socket.on('error', () => undefined);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: (server.address() as AddressInfo).port, received, sockets };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('AqaraTalkClient', () => {
  it('starts a voice session, sends RTP frames and stops politely', async () => {
    const camera = await fakeCamera(() => 0);
    cleanups.push(() => camera.server.close());

    const audio = createSocket('udp4');
    audio.bind(0, '127.0.0.1');
    await once(audio, 'listening');
    cleanups.push(() => audio.close());

    const client = new AqaraTalkClient({ host: '127.0.0.1', controlPort: camera.port, audioPort: audio.address().port });
    await client.connect();
    assert.equal(client.connected, true);
    assert.equal(camera.received[0].type, PacketType.StartVoice);
    assert.ok(camera.received[0].value > 1_600_000_000_000n, 'the session id is the start time in ms');

    const frames: Buffer[] = [];
    audio.on('message', (message) => frames.push(message));
    client.sendFrame(Buffer.from([0xff, 0xf1, 1, 2, 3]));
    client.sendFrame(Buffer.from([0xff, 0xf1, 4, 5, 6]));
    while (frames.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));

    assert.equal(frames[0][1], RTP_PAYLOAD_TYPE);
    assert.equal(frames[0].readUInt16BE(2), 0);
    assert.equal(frames[1].readUInt16BE(2), 1);
    assert.equal(frames[0].readUInt32BE(4), 0);
    assert.equal(frames[1].readUInt32BE(4), 1024, 'the timestamp advances one AAC frame');
    assert.equal(frames[0].readUInt32BE(8), frames[1].readUInt32BE(8), 'one SSRC per session');
    assert.deepEqual([...frames[1].subarray(12)], [0xff, 0xf1, 4, 5, 6]);

    const closed = once(client, 'close');
    await client.disconnect();
    await closed;
    while (camera.received.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(camera.received[1].type, PacketType.StopVoice);
    assert.equal(camera.received[1].value, camera.received[0].value);
  });

  it('reports a camera that refuses the session', async () => {
    const camera = await fakeCamera(() => 1);
    cleanups.push(() => camera.server.close());
    const client = new AqaraTalkClient({ host: '127.0.0.1', controlPort: camera.port });
    await assert.rejects(client.connect(), /refused to start talking/);
    assert.equal(client.connected, false);
  });

  it('times out when the camera never acks', async () => {
    const camera = await fakeCamera(() => undefined);
    cleanups.push(() => camera.server.close());
    const client = new AqaraTalkClient({ host: '127.0.0.1', controlPort: camera.port, timeoutMs: 100 });
    await assert.rejects(client.connect(), /did not answer/);
  });

  it('fails clearly when nothing listens', async () => {
    const camera = await fakeCamera(() => 0);
    const port = camera.port;
    await new Promise((resolve) => camera.server.close(resolve));
    const client = new AqaraTalkClient({ host: '127.0.0.1', controlPort: port, timeoutMs: 500 });
    await assert.rejects(client.connect(), /Could not reach/);
  });

  it('sends heartbeats and ends the session when they stop being answered', async () => {
    let answering = true;
    const camera = await fakeCamera((packet) => (packet.type === PacketType.StartVoice || answering ? 0 : undefined));
    cleanups.push(() => camera.server.close());
    const client = new AqaraTalkClient({ host: '127.0.0.1', controlPort: camera.port, timeoutMs: 30, heartbeatIntervalMs: 20, maxHeartbeatFailures: 2 });
    await client.connect();

    while (camera.received.filter((packet) => packet.type === PacketType.Heartbeat).length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(client.connected, true);

    answering = false;
    await once(client, 'close');
    assert.equal(client.connected, false);
  });

  it('ends the session when the camera hangs up', async () => {
    const camera = await fakeCamera(() => 0);
    cleanups.push(() => camera.server.close());
    const client = new AqaraTalkClient({ host: '127.0.0.1', controlPort: camera.port });
    await client.connect();
    const closed = once(client, 'close');
    camera.sockets[0].destroy();
    await closed;
    assert.equal(client.connected, false);
  });
});
