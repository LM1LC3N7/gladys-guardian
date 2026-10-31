# TODO — Guardian v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `gi ci` (Prettier, ESLint, Node 22 and 24, Docker,
  store validator), `npm run audit`, then update README, `docs/en.md`,
  `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum post from a module session: the batch reserved in /t/10385
  (lot 19) gets one recap message there.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No `keywords` nor `countries` in the manifest yet (the core has not
  shipped them; `countries` would be US, CA).

## Status

- [x] **Milestone 1 — core** (2026-10-31): one to eight controllers by
      address over the local UDP API (a socket per request, bounded), a
      device per controller and per paired leak sensor (keyed by UID); valve
      state, onboard leak and temperature, sensors' leak, temperature,
      battery, moved; close never held back, kept in `/data` until seen
      closed; open behind `allow_valve_open`, on a fresh read; docs en/fr,
      cover. Tested against a fake controller built from aioguardian and its
      fixtures only.
- [ ] **Milestone 2 — real controller**: run against a real Guardian (see
      "To check"), turn the answers (anonymized) into fixtures.
- [ ] **Milestone 3 — more**: Wi-Fi signal (command 32), valve diagnostics
      (travel count, current) behind the lifetime-counter rules, scene
      actions.

## To check on a real controller

- The time the valve takes to close (the fake: 6 s) and the states it goes
  through; whether `start_closing` shows within 400 ms of the close (the read
  back of a click).
- Whether a close sent while the valve opens is refused with error 20 (as
  aioguardian's fixtures suggest for open) or stops and reverses.
- Whether the controller answers from port 7777 (the socket is connected to
  it: an answer from another port would be dropped).
- What the onboard sensor and a paired sensor answer once a sensor stops
  reporting (dead battery): the API dates nothing.
- The UID of a controller: the same in ping and diagnostics (assumed).

## Decisions

- **Mutants (milestone 1)**: 36 mutants on the guards, run one at a time;
  32 killed, 4 equivalent, kept as defence in depth: the `protectSeq` test
  of `checkOpen` (a close always aborts the open's line or is still running
  when the open gets it), the `lstat` before the open of `/data` (the
  `fstat` of the opened handle refuses the same files), the
  `memoryUnreadable` test of `saveMemory` (its only caller, `persist`,
  tests it first), `ctl.opening` in `checkMustYield` (a check behind an open
  finds its close let go, or the lane busy).

- **Version 0.1.0** set by hand in `package.json`, the lock, the manifest and
  `docker_image` (the Release workflow takes over from there).
- **SDK** `^0.16.0`, the latest published on 2026-10-31.
- **Categories** `security`, `environment` (as gladys-flo and gladys-yolink).
- **No secret**: the local API has no authentication; said in the manifest
  section and both docs. No option guards the close (protective).
- **Close targets** (src/app.js `stopTargets`): where the valve answered in
  this run, else where `/data` last saw it, else every configured address
  whose controller was never identified ("owner unknown": the address typed).
  Refused unsent only when no address is known, or every known address holds
  another UID.
- **"Moving" (error 20)** is not a try: the controller refuses any command
  while the valve moves; the close is retried every 250 ms for 3 s, then by
  the checks (every 2 s while it says "moving").
- **"Already closed" (error 18)** is an accepted close; **"already open"
  (17)** an accepted open.
- **Resends**: only a close the controller accepted counts; 3 without effect
  hold it (no more writes until a new click), said in the status. A refusal
  by the controller (another error code) is never counted: sent again at
  each check.
- **Opened elsewhere**: after the close was seen closing, two reads in a row
  showing it opening or open let it go (the app or the button of the
  controller); one read alone never does.
- **Open and a close kept**: the open is written even when the valve already
  reads open (never "already done" without a datagram while a close is
  kept); the close is removed from `/data` before the datagram (a save that
  fails refuses the open); an open that left (answered "ok", "already open"
  or silent) lets the close go; one refused or never sent keeps it.
- **/data save before an open** only when a close is kept (that is what the
  save protects); otherwise nothing to guard.
- **Leak before an open**: the onboard sensor must read dry (unreadable
  refuses); paired sensors that answer must read dry, a silent one does not
  block (a dead sensor would block the valve for good).
- **The click's read back** reads the valve state only (the identity is read
  by the checks), so that a controller answering in 900 ms still fits in the
  3.5 s of the answer; one close try lasts 1.2 s at most.
- **Halt (19)** is never offered (a halted Guardian ignores its sensors).
- **°F**: published in °C, (F - 32) x 5 / 9 rounded to the hundredth; only
  -40 to 150 °F accepted.
- **Several controllers**: comma separated, 8 at most; each has its own line,
  timer and close kept.
- **Sensor values are not dated** by the API: published as read (fresh by the
  time of the request), a limit said in the docs.
