# camera.ui Aqara

[![npm](https://img.shields.io/npm/v/camera-ui-aqara?label=npm&logo=npm)](https://www.npmjs.com/package/camera-ui-aqara)
[![camera.ui](https://img.shields.io/badge/camera.ui-%3E%3D2.4.0-blue)](https://github.com/cameraui)
[![CI](https://github.com/bisman-automations/camera-ui-aqara/actions/workflows/ci.yml/badge.svg)](https://github.com/bisman-automations/camera-ui-aqara/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE.md)

Adds Aqara cameras and doorbells to [camera.ui](https://github.com/cameraui) over your local network, with **two-way audio**.

- Finds Aqara cameras on the network by themselves (mDNS), and ONVIF ones too (WS-Discovery).
- Connects over **RTSP** or **ONVIF**, chosen per camera.
- Serves up to three streams per camera (high, medium and low quality), so live view, detection and snapshots each use a fitting stream.
- **Talk through the camera's speaker** from camera.ui and the apps it streams to, such as HomeKit.
- Follows a camera to its new address when its IP changes.

Everything stays on your network. No Aqara account or cloud connection is needed.

## How two-way audio works

Aqara cameras don't take talkback audio over RTSP or ONVIF. Both only carry audio from the camera. The speaker is reached through a separate protocol of Aqara's own on the local network (TCP port 54324 for control, UDP port 54323 for audio).

This plugin bridges the two. The camera's main stream goes through a small relay inside the plugin that offers camera.ui a standard RTSP talkback channel. Audio you speak into it is converted to the format the camera plays (AAC, 16 kHz) and sent to the speaker over Aqara's protocol. Either connection type works with two-way audio.

## Requirements

- camera.ui 2.4.0 or newer.
- An Aqara camera with **RTSP** or **ONVIF** turned on in the Aqara app.
- camera.ui running on the same network as the camera. Multicast must reach it for discovery; otherwise add the camera by IP address.

## Installation

In camera.ui, open **Plugins**, search for **Aqara** and install it.

To install from the command line instead:

```sh
npm install camera-ui-aqara
```

## Setup

### 1. Turn on RTSP or ONVIF in the Aqara app

Open the camera in the Aqara Home app, then its settings → **More Settings**:

- **RTSP LAN Preview**: turn it on and note the username and password it shows. Aqara serves RTSP on port 8554.
- **ONVIF**, on models and firmware that offer it: turn it on and note its username and password.

### 2. Add the camera

1. In camera.ui, open **Cameras** → **Add camera** and pick the Aqara plugin. Cameras the plugin found show up in the list.
2. Choose the camera and fill in the form:
   - **Connection**: RTSP or ONVIF. ONVIF is preselected when the camera answered ONVIF discovery.
   - **IP Address**: filled in from discovery.
   - **Username** and **Password**: from the Aqara app.
   - **ONVIF Address** (ONVIF only): filled in from discovery. Leave it empty to use `http://<IP address>/onvif/device_service`.
   - **Two-Way Audio**: on by default.
3. Adopt it. The plugin checks the credentials and finds out which streams the camera serves before the camera is added.

### Adding a camera discovery doesn't find

Open the Aqara plugin's settings, enter the camera's IP address (and a name if you like), and press **Add Camera**. The camera then shows up in the adoption list.

## Two-way audio for cameras already in camera.ui

If an Aqara camera is already set up in camera.ui through another plugin (the generic RTSP or ONVIF one, say), you can give it two-way audio without adding it again. It keeps its recordings, events, zones and HomeKit pairing. The Aqara plugin runs a **talk relay** for it: a local address that serves the camera's video with a talkback channel added.

1. Open the Aqara plugin's settings and fill in the **Talk Relay** fields:
   - **Camera**: pick the camera. The list shows the Aqara cameras found on your network that the Aqara plugin hasn't added. Choose **Not listed** to enter the IP address yourself.
   - **Name**: optional for a camera from the list, which brings its own name. The name becomes part of the relay's address.
   - **Camera IP Address**: only for a camera that isn't listed.
   - **RTSP Username** and **RTSP Password**: from the Aqara app.
   - **Stream**: `ch1` (best quality) unless your model names it differently, such as `1080p`.
   - **Port**: leave empty to use the next free port from 8560.
2. Press **Add Talk Relay**. The plugin checks that the camera answers with these credentials, then shows the relay's address, for example `rtsp://127.0.0.1:8560/front-door`.
3. Open the existing camera's settings in camera.ui and set its **High** source URL to that address.

Talk now works for that camera like it does for cameras the Aqara plugin added. Only the source pointed at the relay carries talk, so use it for the High source. The address works only on the machine camera.ui runs on. To undo it, point the High source back at the camera's own stream, then press **Remove** next to the relay.

A relay made for a camera picked from the list follows that camera to a new IP address, like cameras the Aqara plugin added. A relay for a camera entered by hand doesn't, so give that camera a fixed address in your router.

When you add cameras, discovered cameras that already have a talk relay show **(has a talk relay)** after their name, so you don't add one twice by mistake. camera.ui doesn't let the Aqara plugin see cameras other plugins added, so it can only tell for cameras with a relay.

## Moving a camera to the Aqara plugin

camera.ui doesn't let a camera move from one plugin to another, so moving one means adding it again:

1. Note the existing camera's settings you want to keep: room, zones, detection, recording and notifications.
2. Add the camera through the Aqara plugin (see **Setup**), then copy those settings over.
3. Remove the old camera, and any talk relay you made for it, once the new one works.

The old camera's recordings and events stay with the old camera until you remove it, and apps such as HomeKit see the new camera as a new device. If keeping those matters more, use a talk relay instead.

## Camera settings

Each camera's settings page in camera.ui has:

| Setting | What it does |
| --- | --- |
| Connection | RTSP or ONVIF. |
| IP Address | Updated automatically when the camera is found at a new address. |
| Username, Password | The RTSP or ONVIF credentials from the Aqara app. |
| ONVIF Address | The camera's ONVIF device service (ONVIF only). |
| RTSP Streams | The stream paths on port 8554, best first (RTSP only). Usually `ch1`, `ch2`, `ch3`; some models use names like `1080p` and `360p`. They're found by asking the camera when it's added, when you switch it to RTSP, and when its address changes. |
| Two-Way Audio | Turn off to free the speaker for other apps, or to send video straight from the camera without the relay. |

Changes take effect right away.

## Supported models

Any Aqara camera with RTSP or ONVIF should work for video. Two-way audio has been confirmed on the **Camera G100** and the **G400 Video Doorbell**. These models share the same talk protocol and are expected to work too:

Camera Hub G2H, G2H Pro, G3, G5 Pro (Wi-Fi and PoE), Camera E1, G4 Doorbell and G410 Doorbell Camera Hub.

Doorbell models are added to camera.ui as doorbells. Let us know how your model does in an [issue](https://github.com/bisman-automations/camera-ui-aqara/issues), so this list can grow.

## Troubleshooting

**The camera isn't discovered.**
Discovery relies on multicast, which doesn't cross VLANs or reach Docker containers without host networking. Add the camera by IP address instead (see above).

**"The camera rejected the username or password."**
Use the credentials shown in the Aqara app for RTSP or ONVIF, not your Aqara account. Turning RTSP off and on again in the app can give it new credentials.

**"Could not reach …:8554."**
RTSP is off for this camera in the Aqara app, or the camera is on a network camera.ui can't reach.

**Video works but talk does nothing.**
- Make sure **Two-Way Audio** is on for the camera.
- camera.ui has to be able to reach the camera on TCP port 54324 and UDP port 54323.
- The camera takes one voice session at a time. While the Aqara app or another integration is talking, the camera refuses the session. The plugin logs that and tries again 15 seconds later.

**Talk works only for a moment.**
Turn on debug logging for the camera in camera.ui and look for "Voice session" and "heartbeat" lines. A camera that stops answering heartbeats ends the session.

## Development

```sh
npm install
npm test            # unit tests (node:test)
npm run lint
npm run typecheck
npm run bundle      # all checks, then builds bundle/ with the camera.ui CLI
```

`npm run bundle:dev` builds without the checks. To try a build in camera.ui, install the folder or the bundle the way the [camera.ui CLI](https://www.npmjs.com/package/@camera.ui/cli) describes.

Releases: every push to `main` drafts a GitHub release from `CHANGELOG.md`. Publishing the draft publishes the package to npm.

## Credits

The Aqara talk protocol was reverse-engineered by Dan Gibson for [Aqara-Camera-2-Way-Audio](https://github.com/absent42/Aqara-Camera-2-Way-Audio), the Home Assistant integration this plugin's protocol code is ported from. Streaming and the talkback relay are built on [@seydx/rtsp](https://github.com/seydx/rtsp).

## License

[MIT](LICENSE.md). Aqara is a trademark of its owner. This project isn't affiliated with or endorsed by Aqara.
