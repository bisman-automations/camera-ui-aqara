import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mergeDiscoveries } from '../src/discovery.js';
import { AQARA_SERVICE, camerasFromRecords } from '../src/mdns.js';
import { isDoorbell, modelName } from '../src/models.js';

import type { DnsRecord, MdnsCamera } from '../src/mdns.js';
import type { WsDiscoveredDevice } from '../src/onvif.js';

function aqaraRecords(instance: string, host: string, ip: string, txt: string[]): DnsRecord[] {
  const name = `${instance}.${AQARA_SERVICE}`;
  return [
    { name: AQARA_SERVICE, type: 'PTR', data: name },
    { name, type: 'SRV', data: { port: 40000, target: host } },
    { name, type: 'TXT', data: txt.map((entry) => Buffer.from(entry)) },
    { name: host, type: 'A', data: ip },
  ];
}

describe('camerasFromRecords', () => {
  it('reads model, device id and address from an Aqara advertisement', () => {
    const cameras = camerasFromRecords(
      aqaraRecords('Camera-G100-0001', 'lumi-camera.local', '192.0.2.21', ['md=lumi.camera.agl005', 'id=lumi3.0001', 'fw=4.5.20']),
    );
    assert.deepEqual(cameras, [
      { host: '192.0.2.21', deviceId: 'lumi3.0001', modelCode: 'lumi.camera.agl005', instanceName: 'Camera-G100-0001', firmware: '4.5.20' },
    ]);
  });

  it('ignores Aqara hubs that are not cameras and records missing an address', () => {
    const hub = aqaraRecords('Hub-M3', 'hub.local', '192.0.2.30', ['md=lumi.gateway.acn012', 'id=lumi1.0002']);
    const noAddress = aqaraRecords('Camera-E1', 'e1.local', '192.0.2.31', ['md=lumi.camera.acn007', 'id=lumi1.0003']).filter((r) => r.type !== 'A');
    assert.deepEqual(camerasFromRecords([...hub, ...noAddress]), []);
  });

  it('lists a camera once when it answers twice', () => {
    const records = aqaraRecords('Doorbell-G400', 'g400.local', '192.0.2.40', ['md=lumi.camera.agl013', 'id=lumi3.0004']);
    assert.equal(camerasFromRecords([...records, ...records]).length, 1);
  });
});

describe('mergeDiscoveries', () => {
  const g100: MdnsCamera = { host: '192.0.2.21', deviceId: 'lumi3.0001', modelCode: 'lumi.camera.agl005', instanceName: 'Camera-G100-0001' };

  it('adds the ONVIF address to the mDNS camera at the same IP', () => {
    const onvif: WsDiscoveredDevice[] = [{ host: '192.0.2.21', addresses: ['http://192.0.2.21:8000/onvif/device_service'], scopes: [] }];
    const [candidate] = mergeDiscoveries([g100], onvif);
    assert.equal(candidate.id, 'aqara-lumi3.0001');
    assert.equal(candidate.onvifAddress, 'http://192.0.2.21:8000/onvif/device_service');
    assert.equal(candidate.name, 'Aqara Camera G100 0001');
  });

  it('keeps ONVIF-only devices that say they are Aqara and drops other brands', () => {
    const onvif: WsDiscoveredDevice[] = [
      {
        host: '192.0.2.50',
        addresses: ['http://192.0.2.50/onvif/device_service'],
        scopes: ['onvif://www.onvif.org/name/Aqara%20G5%20Pro'],
        name: 'Aqara G5 Pro',
      },
      { host: '192.0.2.60', addresses: ['http://192.0.2.60/onvif/device_service'], scopes: ['onvif://www.onvif.org/name/OtherBrand'], name: 'OtherBrand' },
    ];
    const candidates = mergeDiscoveries([], onvif);
    assert.deepEqual(
      candidates.map((c) => [c.id, c.name]),
      [['aqara-192.0.2.50', 'Aqara G5 Pro']],
    );
  });
});

describe('models', () => {
  it('names known models and spots doorbells', () => {
    assert.equal(modelName('lumi.camera.agl005'), 'Camera G100');
    assert.equal(isDoorbell('lumi.camera.agl013'), true);
    assert.equal(isDoorbell('lumi.camera.agl005'), false);
    assert.equal(isDoorbell(undefined, 'Front Doorbell'), true);
    assert.equal(modelName('lumi.camera.new1', 'G9'), 'G9');
  });
});
