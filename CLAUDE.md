# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

This repository: **Guardian (Elexa)** valve controllers and their paired
leak sensors through their local UDP API, the logic of aioguardian (MIT, see
THIRD_PARTY_NOTICES.md) ported to JavaScript. Decisions and open questions
live in `TODO.md`.

**Valve safety is not negotiable**: closing the valve is the stop of this
module and is never held back (no option, no read, no open in progress, no
configuration, no `/data` wait without a 200 ms bound); it is kept in `/data`
until a read shows the valve closed, never let go by time nor before it
left. `allow_valve_open` stays off by default; an open is serialized per
controller, decided on a fresh read (never on the state in memory), refused
on a leak, a moving or faulty valve, another UID, and never leaves after a
close clicked later. Never a `switch`, never the halt command (19). Keep the
tests that prove it (`test/close.test.js`, `test/open.test.js`).

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
node --test test/devices.test.js          # one file
node --test --test-name-pattern "plug"    # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only (src/handlers.js registers before connect())
src/handlers.js                   the SDK handlers -> GuardianApp (shared with the tests)
src/app.js                        GuardianApp: reads, states, badge, status, open, close (kept)
src/lane.js                       one request at a time per controller, the close first
src/guardian/udp.js               the only network access: a UDP socket per request, bounded
src/guardian/model.js             answers -> readings (pure, strict), °F -> °C
src/devices.js                    readings -> Gladys devices and states (pure)
src/publisher.js                  states to Gladys within 300/min, nothing older than 2 min
src/store.js                      /data/guardian-state.json (addresses, closes kept), bounded
src/config.js                     DEFAULT_CONFIG (mirrors the manifest) + normalization
src/constants.js, src/i18n.js     commands, keys, timings; en/fr texts
gladys-assistant-integration.json manifest: name, config_schema, actions
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, SDK fake Gladys + test/helpers/fakeGuardian.js
test/kit/                         clocks of gladys-testkit (virtual, real x20)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (serial, cloud id, MAC), never a label. Gladys keys
  devices, their history, scenes and dashboards on them: changing one creates a
  new device and orphans the old one. The same goes for every key users store:
  manifest `config_schema`, `actions`, widget and scene keys, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, action, scene and widget handlers): change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network, and pass on Node 22 and 24.
- **Encoding.** Text files are UTF-8 without BOM; `test/manifest.test.js`
  refuses mojibake and a BOM. Write files with an editor, never with
  PowerShell's `Set-Content`/`Out-File` defaults.
