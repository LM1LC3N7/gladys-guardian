# gladys-guardian

[Gladys Assistant](https://gladysassistant.com) external integration for
**Guardian (Elexa) valve controllers** and the leak sensors paired with them,
through their local UDP API (port 7777; no password: the API has none; the
Guardian cloud is never used): valve state, leaks, temperatures (°F converted
exactly to °C), sensor batteries; closing the valve held back by no option,
read nor command, kept in `/data` until seen closed; opening behind an
off-by-default option, decided on a fresh read, refused on a leak. **Never
tested with a real device. Not affiliated with Elexa.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (GuardianApp)
                                  ├─ src/lane.js              one request at a time per controller (the close first)
                                  ├─ src/guardian/udp.js      the only network access (a socket per request, bounded)
                                  ├─ src/guardian/model.js    the answers (strict, bounded), °F -> °C
                                  ├─ src/devices.js           devices and states (pure)
                                  ├─ src/publisher.js         states within 300/min, nothing older than 2 min
                                  └─ src/store.js             /data/guardian-state.json (addresses, closes kept)
```

- **API** (aioguardian 2026.1.1): one JSON datagram
  `{ "command": <code>, "silent": true }` to UDP 7777, one JSON datagram back
  echoing `command` with `status` `ok` or `error` (+ `error_code`: 17 already
  open, 18 already closed, 20 moving). Read: 0 ping (UID, identity, first in
  every read), 16 valve status (the core); secondary, never blocking: 80
  onboard sensor, 48 paired sensors (every 10 min), 51 each sensor, 1
  diagnostics (every 6 h). Written: 18 close, 17 open. Nothing else (never 19
  halt: a halted Guardian ignores its leak sensors).
- **UDP**: a socket per request, connected to the controller (answers from
  elsewhere dropped by the kernel, a late answer reaches a closed socket),
  only an answer echoing the command sent, 4 KiB at most, no broadcast.
- **Reads**: each controller every 30 s (10 s – 1 h), never sooner (button,
  scan, reconnection, restart) but the reads 5 and 20 s after a command;
  requests numbered when they leave, values applied in that order.
- **Devices**: `guardian:<uid>`, `guardian-sensor:<uid>`; buttons only, never
  a switch.
- **Close**: never behind an option, a read, a command, the configuration or
  `/data`; kept in `/data` until seen closed, checked every 15 s (5 s while it
  closes), sent again 3 times at most once accepted, never let go by time.

## Credits

Ported from [aioguardian](https://github.com/bachya/aioguardian) (Aaron Bach,
MIT, 2026.1.1) and its test fixtures. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Modelled on the sibling
integrations [gladys-rainmachine](https://github.com/LM1LC3N7/gladys-rainmachine)
(stops kept, lane) and [gladys-flo](https://github.com/LM1LC3N7/gladys-flo)
(water valve).

## Development

```bash
npm install
npm test                                        # node --test, no network but loopback
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npm run cover                                   # cover.png, plain Node
npx github:GladysAssistant/integration-store .  # store admission checks
```

The controllers are fakes behind the injected exchange
(`test/helpers/fakeGuardian.js`) on the virtual clock of the kit;
`test/io.test.js` runs the real UDP transport and the `/data` file against
loopback, `test/realclock.test.js` the app on the real clock (×20) over real
UDP.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0 (`LICENSE`). The ported logic comes from an MIT project, credited
in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (also shipped in the
Docker image).
