# camera-ui-aqara

camera.ui plugin (TypeScript, camera controller role) for Aqara cameras over
the local network. It's a Node package, not a Home Assistant integration, so
the bisman-automations shared rules apply as adapted below.

## Layout

- `src/index.ts`: plugin entry. Discovery (mDNS + WS-Discovery), adoption form, adoption checks, adding by IP, following IP changes.
- `src/camera.ts`: one camera. Storage schema, stream resolution (RTSP paths or ONVIF), relay with RTSP backchannel, `streamUrl()`.
- `src/talkback.ts`: talkback bridge. Transcoder → ADTS framing → paced frames → talk session, idle stop and cooldown.
- `src/talk.ts`, `src/protocol.ts`: Aqara LAN talk protocol (TCP 54324 control, UDP 54323 RTP AAC), ported from absent42/Aqara-Camera-2-Way-Audio (MIT, see LICENSE.md).
- `src/onvif.ts`, `src/mdns.ts`, `src/discovery.ts`, `src/rtsp.ts`, `src/digest.ts`, `src/streams.ts`, `src/models.ts`: helpers, each covered by `test/`.
- `contract.ts`, `cameraui.config.ts`: read by `cui bundle`.

`@camera.ui/sdk` and `node-av` come from the camera.ui host at runtime (the CLI marks them external). Keep modules that tests import free of `@seydx/rtsp`, which loads `node-av`. Only `src/camera.ts` imports it.

## Releases

- The version lives in `package.json`. Semantic Versioning: patch for fixes and docs, minor for features and settings, major when users have to redo setup or lose something they rely on.
- Check what's released first: `git ls-remote --tags origin | awk -F/ '{print $3}' | sort -V | tail -1`. Never add changes to a released version.
- Every push to `main` ships as a release. In the same commit, named `Release X.Y.Z`, bump `package.json` and write the notes under a new `## [X.Y.Z] - YYYY-MM-DD` heading in `CHANGELOG.md` (Keep a Changelog), with the compare link at the bottom. There is no `## [Unreleased]` section. CI fails if there is one.
- Pushing to `main` runs **Draft release**, which drafts `vX.Y.Z` with that CHANGELOG section plus a Full Changelog link as the notes, and `bundle.zip` attached. **Donavan publishes the draft himself.** Publishing creates the tag and runs **Publish**, which publishes to npm. Never create or push tags, publish releases, or edit published releases.
- Ask Donavan before every push. Fast-forward only: no force-push, rebase or amend of anything pushed.

## Commits

- Author commits as `Donavan Becker <donavan.becker@icloud.com>`. Credit an AI assistant with a `Co-Authored-By:` trailer if you like, never as the author.
- Subject lines are plain and imperative and say what changed for the user. No `fix:`/`feat:` prefixes. Release commits are "Release X.Y.Z".

## Before saying work is done

```
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build && npx cui bundle
```

`npm run bundle` runs all of these.

## Code and docs

- Never put personal details in the repo: no names, addresses, IPs other than documentation ranges (192.0.2.x), credentials, device ids or serial numbers. Use placeholders.
- Never log credentials. Use `redact()` for stream URLs.
- `README.md` is user documentation: plain language, setting names as camera.ui shows them.
