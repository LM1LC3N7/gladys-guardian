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
- Whether the valve status can lag behind the motor: a controller answering
  "moving" (20) to a close while its status still reads "closed" for a moment
  (an open just started). The module never lets a close go on a "closed" read
  right after "moving" (kept, the next check 5 s later confirms it); a lag
  longer than that would still be read as closed.

## Decisions

- **Review r4 (2026-10-31)**:
  - I1: a test where a click for Y cuts the check of a close of X kept at the
    same address: the click's guard carries X (`prepareGuard`), X goes on to
    its valve and closes.
  - m1: "closed" read right after a "moving" answer is never a success nor
    lets the close go: answered "not confirmed yet", kept, next check in 5 s.
- **Review r3 (2026-10-31)**:
  - I1: `test/review3.test.js`, one test per surviving guard: r13 (the check
    of a close never sent waits for an open in flight), r07 (a resend check
    waits for a poll read, a click cuts it), r04 (one identity probe per
    address every 5 s), r11 (a guard emptied by `foundValve` is dropped: the
    offline controller, back, is never closed for another valve).
  - m1: the check of a close never sent takes the line as a _preemptible_
    close (`Lane.acquire('stop', { preemptible: true })`): it still cuts a
    stuck read, but a clicked close cuts it at once (the click's guard holds
    its valves, nothing is lost), so the click's datagram never waits for the
    check's answer. A click refused "moving" reads the valve once: closing or
    closed = a close under way (success), never "refuses any command".
- **Review r2 (2026-10-31)**:
  - I1: `foundValve` takes every close of a valve kept for another address
    (one not identified as it) as soon as the valve is identified; a close
    sent astray reads the identity of every configured address at once
    (`probeIdentities`, one ping per address every 5 s at most, outside the
    interval: protective). A check of a close never sent takes the line like
    a click (`stop`), so a read stuck on a silent controller never delays it
    (a clicked close cuts it in turn since r3).
  - I2: every UDP exchange of `test/io.test.js` has its own deadline
    (`AbortSignal.timeout`), the FIFO tests race a 2 s deadline and wake a
    blocked `open()` in `t.after` (O_RDWR | O_NONBLOCK): h01, h03, h04 fail in
    3 to 10 s and the process ends. `timeout-minutes` on every CI job (20,
    60 for the multi-arch build).
  - I3: `test/review2.test.js`, one test per survivor.
  - Minor: a kept close with no readable UID is "any valve" (sent in doubt);
    a held close reads the diagnostics at each check, an uptime that drops
    re-arms it; deleting a valve in Gladys gives up its lost close.

- **Review r1 (2026-10-31)**:
  - B1: `prepareGuard` makes a NEW guard object for each click; an open lets
    go only the guard it removed from `/data` (`dropGuard(ctl, guard)`
    compares objects), never one clicked after it.
  - B2: a guard holds the set of UIDs whose close goes to its address (a job
    too: two valves fanned out to one address keep both). A read showing
    another UID never lets a close go: `misplaced` keeps the right UIDs and
    `relocate` sends the others where they answer in this run, else to every
    configured address not identified in this run (what /data says may be
    stale after a DHCP swap); with no target, `lost` (in /data, said) until
    the valve answers at a configured address (`foundValve` on each
    identity read) or a new configuration offers an address. The read back
    of a click reads the identity: success only for the UID read.
  - I1: the fresh read of an open reads every listed sensor; one not read
    (silence, refusal, out of time, `wet` not a boolean) or an unknown list
    refuses the open. A dead sensor blocks opening (said in the docs).
  - I2: held after 3 accepted resends, then sent again every 30 s doubling
    to 10 min, forever; 3 quick resends again when a read shows another
    state than at the hold, when the controller answers after a silence, and
    at a restart (resends not restored from /data).
  - I3: a test per mutant listed (`test/review1.test.js`); m23, m31, m42
    rewritten for the new code (relocation, refusal not counted, state
    without identity never applied).
  - Mutants r2: the reviewer's 53 (anchors moved: m01, m14, m18, m21, m23,
    m31, m41, m42 rewritten) and 16 new ones on B1, B2, I1, I2, m1, m2, one
    at a time: all killed but the equivalents the review admitted (m19, m35,
    m50, m51, m52) and m03/m04/m16 (each doubled by the other).
  - s04 of the review checked the old "held for good": with I2, a held close
    is sent again (30 s, doubling) and re-armed by a restart, so its checks
    "never closed without a new click" and "held said after a restart" now
    fail by design.
  - No timer is armed again after `shutdown()` (schedule, follow-ups,
    `getConfig` retry, checks; holders aborted): a test proves none is left.
  - Minor: an open is refused while /data is still being read (status line);
    one /data write in flight and one waiting at most; docs (close timing,
    the open option, B1/B2/I1, forged answers on the LAN).

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
  another UID. Another UID read there: see r1 B2 (relocated, never dropped).
- **"Moving" (error 20)** is not a try: the controller refuses any command
  while the valve moves; the close is retried every 250 ms for 3 s, then by
  the checks (every 2 s while it says "moving"). The first "moving" of a
  click reads the valve once (`sendStop`): closing is a close under way
  (judged by `decideStop` like a read back: a success for the valve read),
  another UID is misplaced; closed is "not confirmed yet", kept, confirmed by
  the next check 5 s later (a status that lags behind an open starting would
  read closed: never let go on that one read); opening or a fault: retried as
  before.
- **"Already closed" (error 18)** is an accepted close; **"already open"
  (17)** an accepted open.
- **Resends**: only a close the controller accepted counts; 3 without effect
  hold it: sent again on a slower cadence (30 s doubling to 10 min), said in
  the status. A refusal by the controller (another error code) is never
  counted: sent again at each check.
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
- **Leak before an open**: the onboard sensor and every paired sensor must
  read dry in the fresh read (unreadable refuses; r1 I1).
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
