import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FIRST_RELAY_PORT, nextFreePort, parseRelays, relayFromForm, relayUrl, serializeRelays, slugify } from '../src/talk-relay-config.js';

import type { TalkRelayConfig } from '../src/talk-relay-config.js';

const frontDoor: TalkRelayConfig = { id: 'front-door', name: 'Front Door', host: '192.0.2.21', username: 'user', password: 'pass', path: 'ch1', port: 8560 };

describe('talk relay settings', () => {
  it('slugifies names for the URL path', () => {
    assert.equal(slugify('Front Door Cam'), 'front-door-cam');
    assert.equal(slugify('  Garage / Side #2 '), 'garage-side-2');
    assert.equal(slugify('Café'), 'cafe');
    assert.equal(slugify('!!!'), '');
  });

  it('round-trips the stored list and skips malformed entries', () => {
    assert.deepEqual(parseRelays(serializeRelays([frontDoor])), [frontDoor]);
    assert.deepEqual(parseRelays('not json'), []);
    assert.deepEqual(parseRelays(undefined), []);
    assert.deepEqual(parseRelays(JSON.stringify([frontDoor, { id: 'x' }, null])), [frontDoor]);
  });

  it('picks the next free port and builds the local address', () => {
    assert.equal(nextFreePort([]), FIRST_RELAY_PORT);
    assert.equal(nextFreePort([frontDoor, { ...frontDoor, id: 'b', port: 8561 }]), 8562);
    assert.equal(relayUrl(frontDoor), 'rtsp://127.0.0.1:8560/front-door');
  });

  it('builds a relay from the form with defaults', () => {
    const result = relayFromForm({ relayName: 'Back Yard', relayHost: ' 192.0.2.22 ', relayUsername: 'u', relayPassword: 'p' }, [frontDoor]);
    assert.deepEqual(result, { relay: { id: 'back-yard', name: 'Back Yard', host: '192.0.2.22', username: 'u', password: 'p', path: 'ch1', port: 8561 } });
  });

  it('explains what is missing or clashing', () => {
    const base = { relayName: 'Back Yard', relayHost: '192.0.2.22', relayUsername: 'u', relayPassword: 'p' };
    const error = (form: Record<string, unknown>): string => {
      const result = relayFromForm(form, [frontDoor]);
      assert.ok('error' in result, 'expected an error');
      return result.error;
    };
    assert.match(error({ ...base, relayName: '' }), /name/);
    assert.match(error({ ...base, relayHost: '' }), /IP address/);
    assert.match(error({ ...base, relayPassword: '' }), /username and password/);
    assert.match(error({ ...base, relayPort: 80 }), /between 1024/);
    assert.match(error({ ...base, relayName: 'Front  Door' }), /already a relay/);
    assert.match(error({ ...base, relayPort: '8560' }), /already used/);
  });
});
