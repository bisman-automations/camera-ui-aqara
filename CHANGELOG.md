# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-07

### Added

- First release: Aqara cameras and doorbells in camera.ui over the local network.
- Discovery of Aqara cameras over mDNS and of ONVIF cameras over WS-Discovery, plus adding a camera by IP address.
- RTSP and ONVIF connections, chosen per camera. Adoption checks the credentials and finds which streams the camera serves.
- Up to three streams per camera (high, medium and low quality), with snapshots taken from the smallest.
- Two-way audio through Aqara's LAN talk protocol, offered to camera.ui as an RTSP talkback channel.
- Cameras follow their new address when their IP changes.

[1.0.0]: https://github.com/bisman-automations/camera-ui-aqara/releases/tag/v1.0.0
