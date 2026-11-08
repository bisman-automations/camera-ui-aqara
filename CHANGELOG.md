# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.3.3] - 2026-11-08

### Fixed

- The RTSP stream check now finds the G5 Pro's fourth channel (`ch4`, 360p). For cameras with more than three streams, over RTSP or ONVIF, High gets the best, Medium the second smallest and Low the smallest, so snapshots and detection use the lightest stream. On the G5 Pro that is 1520p, 720p and 360p.

## [3.3.2] - 2026-11-08

### Fixed

- The plugin crashed right after starting in 3.3.0 and 3.3.1 ("this.storage.getValue(...).then is not a function"), while reading the Maximum Call Duration setting. Settings and talk relays are now read in a way that works however camera.ui hands them over.

## [3.3.1] - 2026-11-08

### Fixed

- Adding a camera over RTSP, switching one to RTSP, and adding a talk relay could fail with "The camera rejected the username or password (RTSP 401)" even with the right credentials. The credentials check now logs in on the same connection the camera issued its login challenge on, as video players do.

## [3.3.0] - 2026-11-08

### Added

- **Maximum Call Duration** in the plugin settings, 180 seconds by default. A talk call that runs longer is cut off, and talk stays muted until the incoming audio pauses, so a call left open (HomeKit can keep the microphone on) can't hold the camera's speaker. 0 turns the limit off.
- Model names for the Camera Hub G3, Camera E1 and Camera Hub G2H Pro model codes, and more Camera Hub G2H variants.
- The RTSP stream check also tries `1296p`, a stream name the Camera Hub G3 uses.

## [3.2.0] - 2026-11-07

### Added

- The talk relay form has a **Camera** list of the Aqara cameras found on the network, so adding a relay only needs the RTSP username and password. **Not listed** still takes an IP address.
- Talk relays made from the list follow their camera to a new IP address.
- When adding cameras, discovered cameras that already have a talk relay show "(has a talk relay)" after their name.

## [3.1.0] - 2026-11-07

### Added

- Talk relays: two-way audio for Aqara cameras that another camera.ui plugin already manages, without adding them again. Add a relay in the plugin settings and point the camera's High source at its address.
- README: how to move a camera from another plugin to the Aqara plugin, and what stays behind.

### Fixed

- Switching a camera from ONVIF to RTSP now asks the camera which RTSP streams it has, instead of assuming `ch1` to `ch3`. The check runs again when the camera's address changes.

### Changed

- Updated ESLint to 10. Dependabot now leaves major versions of TypeScript and the Node.js type definitions alone.

## [3.0.0] - 2026-11-07

### Changed

- First release published to npm. It replaces the earlier `camera-ui-aqara` 2.x releases, which were withdrawn from npm. The version jumps to 3.0.0 so that camera.ui offers it as an update over any 2.x still installed.

### Added

- Everything from 1.0.0: Aqara cameras and doorbells in camera.ui over the local network, by RTSP or ONVIF, with discovery, up to three streams per camera and two-way audio through Aqara's LAN talk protocol.

## [1.0.0] - 2026-11-07

### Added

- First release: Aqara cameras and doorbells in camera.ui over the local network.
- Discovery of Aqara cameras over mDNS and of ONVIF cameras over WS-Discovery, plus adding a camera by IP address.
- RTSP and ONVIF connections, chosen per camera. Adoption checks the credentials and finds which streams the camera serves.
- Up to three streams per camera (high, medium and low quality), with snapshots taken from the smallest.
- Two-way audio through Aqara's LAN talk protocol, offered to camera.ui as an RTSP talkback channel.
- Cameras follow their new address when their IP changes.

[3.3.3]: https://github.com/bisman-automations/camera-ui-aqara/compare/v3.3.2...v3.3.3
[3.3.2]: https://github.com/bisman-automations/camera-ui-aqara/compare/v3.3.1...v3.3.2
[3.3.1]: https://github.com/bisman-automations/camera-ui-aqara/compare/v3.3.0...v3.3.1
[3.3.0]: https://github.com/bisman-automations/camera-ui-aqara/compare/v3.2.0...v3.3.0
[3.2.0]: https://github.com/bisman-automations/camera-ui-aqara/compare/v3.1.0...v3.2.0
[3.1.0]: https://github.com/bisman-automations/camera-ui-aqara/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/bisman-automations/camera-ui-aqara/compare/v1.0.0...v3.0.0
[1.0.0]: https://github.com/bisman-automations/camera-ui-aqara/releases/tag/v1.0.0
