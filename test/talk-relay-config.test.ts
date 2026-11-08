import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  cameraChoices,
  FIRST_RELAY_PORT,
  MANUAL_CAMERA,
  nextFreePort,
  parseRelays,
  relayFromForm,
  relayUrl,
  serializeRelays,
  slugify,
} from '../src/talk-relay-config.js';

import type { RelayCameraChoice, TalkRelayConfig } from '../src/talk-relay-config.js';

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

  const g400: RelayCameraChoice = {
    id: 'aqara-lumi3.0004',
    name: 'Aqara Doorbell G400',
    host: '192.0.2.40',
    deviceId: 'lumi3.0004',
    model: 'G400 Video Doorbell',
  };

  it('lists discovered cameras, marks those with a relay, and ends with manual entry', () => {
    const { values, labels } = cameraChoices([g400, { id: 'aqara-192.0.2.21', name: 'Aqara (192.0.2.21)', host: '192.0.2.21' }], [frontDoor]);
    assert.deepEqual(values, ['aqara-lumi3.0004', 'aqara-192.0.2.21', MANUAL_CAMERA]);
    assert.equal(labels['aqara-lumi3.0004'], 'Aqara Doorbell G400 (192.0.2.40, G400 Video Doorbell)');
    assert.match(labels['aqara-192.0.2.21'], /has a talk relay$/);
    assert.match(labels[MANUAL_CAMERA], /enter its IP address/);
  });

  it('takes name, address and device id from a picked camera', () => {
    const result = relayFromForm({ relayCamera: g400.id, relayUsername: 'u', relayPassword: 'p' }, [], [g400]);
    assert.ok('relay' in result);
    assert.deepEqual(result.relay, {
      id: 'aqara-doorbell-g400',
      name: 'Aqara Doorbell G400',
      host: '192.0.2.40',
      username: 'u',
      password: 'p',
      path: 'ch1',
      port: 8560,
      deviceId: 'lumi3.0004',
    });
  });

  it('lets typed values override the picked camera, dropping the device id when the address differs', () => {
    const result = relayFromForm({ relayCamera: g400.id, relayName: 'Porch', relayHost: '192.0.2.99', relayUsername: 'u', relayPassword: 'p' }, [], [g400]);
    assert.ok('relay' in result);
    assert.equal(result.relay.name, 'Porch');
    assert.equal(result.relay.host, '192.0.2.99');
    assert.equal(result.relay.deviceId, undefined);
  });

  it('refuses a second relay for the same camera and a manual entry without an address', () => {
    const existing = [{ ...frontDoor, id: 'doorbell', port: 8561, deviceId: 'lumi3.0004' }];
    const twice = relayFromForm({ relayCamera: g400.id, relayName: 'Doorbell 2', relayUsername: 'u', relayPassword: 'p' }, existing, [g400]);
    assert.ok('error' in twice && /already has a talk relay/.test(twice.error));
    const manual = relayFromForm({ relayCamera: MANUAL_CAMERA, relayName: 'X', relayUsername: 'u', relayPassword: 'p' }, [], [g400]);
    assert.ok('error' in manual && /Pick the camera/.test(manual.error));
  });
});
