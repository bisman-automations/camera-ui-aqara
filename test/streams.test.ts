import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCameraConfig, missingSources, pickStreams, rolesFor, sameStreams, sourceForMissing, streamIndexForRole } from '../src/streams.js';

describe('streams', () => {
  it('hands roles out best first', () => {
    assert.deepEqual(rolesFor(1), ['high-resolution']);
    assert.deepEqual(rolesFor(2), ['high-resolution', 'low-resolution']);
    assert.deepEqual(rolesFor(5), ['high-resolution', 'mid-resolution', 'low-resolution']);
    assert.equal(streamIndexForRole('low-resolution', 3), 2);
    assert.equal(streamIndexForRole('low-resolution', 2), 1);
    assert.equal(streamIndexForRole('mid-resolution', 2), undefined);
  });

  it('builds plugin-served sources with snapshots from the smallest stream', () => {
    const config = buildCameraConfig({ name: 'Front Door', nativeId: 'aqara-lumi3.1', streamCount: 3, doorbell: true, info: { manufacturer: 'Aqara' } });
    assert.equal(config.type, 'doorbell');
    assert.deepEqual(
      config.sources.map((source) => [source.name, source.role, source.useForSnapshot, source.hotMode, 'urls' in source]),
      [
        ['High', 'high-resolution', false, true, false],
        ['Medium', 'mid-resolution', false, false, false],
        ['Low', 'low-resolution', true, false, false],
      ],
    );
  });

  it('picks best, middle and smallest from more than three streams', () => {
    assert.deepEqual(pickStreams(['ch1', 'ch2', 'ch3', 'ch4']), ['ch1', 'ch3', 'ch4']);
    assert.deepEqual(pickStreams(['a', 'b', 'c', 'd', 'e']), ['a', 'd', 'e']);
    assert.deepEqual(pickStreams(['ch1', 'ch3']), ['ch1', 'ch3']);
    assert.deepEqual(pickStreams([]), []);
  });

  it('reports roles the camera could fill but has no source for', () => {
    assert.deepEqual(missingSources(['high-resolution', 'low-resolution'], 3), [{ role: 'mid-resolution', name: 'medium', streamIndex: 1 }]);
    assert.deepEqual(missingSources(['high-resolution', 'mid-resolution', 'low-resolution'], 3), []);
    assert.deepEqual(missingSources(['high-resolution'], 2), [{ role: 'low-resolution', name: 'low', streamIndex: 1 }]);
    assert.deepEqual(missingSources(['high-resolution', 'low-resolution'], 2), []);
  });

  it('adds a missing source as a plugin-served source without URLs', () => {
    const [missing] = missingSources(['high-resolution', 'low-resolution'], 3);
    assert.deepEqual(sourceForMissing(missing), { name: 'medium', role: 'mid-resolution', useForSnapshot: false, hotMode: false, preload: false });
    assert.equal('urls' in sourceForMissing(missing), false);
  });

  it('compares saved stream lists', () => {
    const a = ['rtsp://192.0.2.10/ch1', 'rtsp://192.0.2.10/ch2'];
    assert.equal(sameStreams(a, [...a]), true);
    assert.equal(sameStreams(undefined, []), true);
    assert.equal(sameStreams(undefined, a), false);
    assert.equal(sameStreams(a, [a[1], a[0]]), false);
    assert.equal(sameStreams(a, a.slice(0, 1)), false);
  });
});
