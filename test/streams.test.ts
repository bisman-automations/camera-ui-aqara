import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCameraConfig, pickStreams, rolesFor, streamIndexForRole } from '../src/streams.js';

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
});
