# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[3.1.0]: https://github.com/bisman-automations/camera-ui-aqara/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/bisman-automations/camera-ui-aqara/compare/v1.0.0...v3.0.0
[1.0.0]: https://github.com/bisman-automations/camera-ui-aqara/releases/tag/v1.0.0
