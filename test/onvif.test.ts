import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { elementsOf, isAqaraDevice, OnvifClient, parseProbeMatch, textOf } from '../src/onvif.js';

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const PROBE_MATCH = `<?xml version="1.0"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery">
<SOAP-ENV:Body><d:ProbeMatches><d:ProbeMatch>
<d:Scopes>onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/name/Aqara%20G5%20Pro onvif://www.onvif.org/hardware/lumi.camera.agl003</d:Scopes>
<d:XAddrs>http://10.9.9.9/onvif/device_service http://192.0.2.50:8000/onvif/device_service</d:XAddrs>
</d:ProbeMatch></d:ProbeMatches></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

describe('WS-Discovery', () => {
  it('reads addresses, name and hardware, preferring the address of the host that answered', () => {
    const device = parseProbeMatch(PROBE_MATCH, '192.0.2.50');
    assert.ok(device);
    assert.equal(device.addresses[0], 'http://192.0.2.50:8000/onvif/device_service');
    assert.equal(device.name, 'Aqara G5 Pro');
    assert.equal(device.hardware, 'lumi.camera.agl003');
    assert.equal(isAqaraDevice(device), true);
  });

  it('ignores replies that are not probe matches', () => {
    assert.equal(parseProbeMatch('<Envelope><Body><Hello/></Body></Envelope>', '192.0.2.1'), undefined);
  });
});

describe('XML helpers', () => {
  it('handles prefixes, attributes and nested elements of the same name', () => {
    const xml = '<a:Root><b:Item token="x"><b:Item>inner</b:Item><c:Name>one &amp; two</c:Name></b:Item><b:Item token="y"/></a:Root>';
    const items = elementsOf(xml, 'Item');
    assert.equal(items.length, 2);
    assert.match(items[0], /inner/);
    assert.equal(textOf(items[0], 'Name'), 'one & two');
    assert.equal(textOf(xml, 'Missing'), undefined);
  });
});

/** Canned answers from a camera's ONVIF service, keyed by SOAP action element. */
function soap(body: string): string {
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><s:Body>${body}</s:Body></s:Envelope>`;
}

describe('OnvifClient', () => {
  let server: Server;
  let port: number;
  const requests: { path: string; body: string; authorization?: string }[] = [];
  let requireDigest = false;

  before(async () => {
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        requests.push({ path: request.url ?? '', body, authorization: request.headers.authorization });
        if (requireDigest && !body.includes('GetSystemDateAndTime') && !request.headers.authorization) {
          response.writeHead(401, { 'WWW-Authenticate': 'Digest realm="cam", nonce="abc", qop="auth"' });
          response.end();
          return;
        }
        if (!body.includes('GetSystemDateAndTime') && !body.includes('<wsse:Username>admin</wsse:Username>')) {
          response.writeHead(400);
          response.end(soap('<s:Fault><s:Reason><s:Text>Sender not Authorized</s:Text></s:Reason></s:Fault>'));
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/soap+xml' });
        if (body.includes('GetSystemDateAndTime')) {
          response.end(
            soap(
              '<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:UTCDateTime><tt:Time><tt:Hour>10</tt:Hour><tt:Minute>0</tt:Minute><tt:Second>0</tt:Second></tt:Time><tt:Date><tt:Year>2026</tt:Year><tt:Month>1</tt:Month><tt:Day>2</tt:Day></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>',
            ),
          );
        } else if (body.includes('GetDeviceInformation')) {
          response.end(
            soap(
              '<tds:GetDeviceInformationResponse><tds:Manufacturer>Aqara</tds:Manufacturer><tds:Model>G5 Pro</tds:Model><tds:FirmwareVersion>4.1.0</tds:FirmwareVersion><tds:SerialNumber>SN1</tds:SerialNumber><tds:HardwareId>agl003</tds:HardwareId></tds:GetDeviceInformationResponse>',
            ),
          );
        } else if (body.includes('GetCapabilities')) {
          response.end(
            soap(
              '<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Media><tt:XAddr>http://10.9.9.9:' +
                port +
                '/onvif/media_service</tt:XAddr></tt:Media></tds:Capabilities></tds:GetCapabilitiesResponse>',
            ),
          );
        } else if (body.includes('GetProfiles')) {
          response.end(
            soap(
              '<trt:GetProfilesResponse>' +
                '<trt:Profiles token="sub"><tt:Name>Sub</tt:Name><tt:VideoEncoderConfiguration><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>640</tt:Width><tt:Height>360</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration></trt:Profiles>' +
                '<trt:Profiles token="main"><tt:Name>Main</tt:Name><tt:VideoEncoderConfiguration><tt:Encoding>H265</tt:Encoding><tt:Resolution><tt:Width>2688</tt:Width><tt:Height>1520</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration></trt:Profiles>' +
                '</trt:GetProfilesResponse>',
            ),
          );
        } else if (body.includes('GetStreamUri')) {
          const token = /<trt:ProfileToken>(\w+)</.exec(body)?.[1];
          response.end(
            soap(
              `<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://10.9.9.9:8554/${token}?a=1&amp;b=2</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>`,
            ),
          );
        } else {
          response.end(soap(''));
        }
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as AddressInfo).port;
  });

  after(() => server.close());

  it('lists streams best first, on the host it talks to', async () => {
    const client = new OnvifClient(`http://127.0.0.1:${port}/onvif/device_service`, 'admin', 'secret');
    const streams = await client.getStreams();
    assert.deepEqual(
      streams.map((stream) => [stream.token, stream.width, stream.uri]),
      [
        ['main', 2688, 'rtsp://127.0.0.1:8554/main?a=1&b=2'],
        ['sub', 640, 'rtsp://127.0.0.1:8554/sub?a=1&b=2'],
      ],
    );
    assert.ok(
      requests.some((request) => request.path === '/onvif/media_service'),
      'media calls go to the media service address',
    );
    const authed = requests.find((request) => request.body.includes('GetProfiles'));
    assert.match(authed!.body, /PasswordDigest/);
    assert.match(authed!.body, /<wsu:Created>2026-01-02T10:00:\d\dZ<\/wsu:Created>/, "the token uses the camera's clock");
  });

  it('reads device information', async () => {
    const client = new OnvifClient(`http://127.0.0.1:${port}/onvif/device_service`, 'admin', 'secret');
    assert.deepEqual(await client.getDeviceInformation(), {
      manufacturer: 'Aqara',
      model: 'G5 Pro',
      firmwareVersion: '4.1.0',
      serialNumber: 'SN1',
      hardwareId: 'agl003',
    });
  });

  it('answers an HTTP digest challenge', async () => {
    requireDigest = true;
    try {
      const client = new OnvifClient(`http://127.0.0.1:${port}/onvif/device_service`, 'admin', 'secret');
      await client.getDeviceInformation();
      const last = requests[requests.length - 1];
      assert.match(last.authorization ?? '', /^Digest username="admin", realm="cam", nonce="abc"/);
    } finally {
      requireDigest = false;
    }
  });

  it('says so when the credentials are wrong', async () => {
    const client = new OnvifClient(`http://127.0.0.1:${port}/onvif/device_service`, 'nobody', 'wrong');
    await assert.rejects(client.getDeviceInformation(), /rejected the ONVIF username or password/);
  });
});
