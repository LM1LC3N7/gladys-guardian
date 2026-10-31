// -----------------------------------------------------------------------------
// The findings of review r3: one test per guard a mutant removed (r13, r07,
// r04, r11), and a close click that finds our own close moving the valve (m1).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testClock } from './kit/index.mjs';
import { COMMANDS, SECOND } from '../src/constants.js';
import { Lane } from '../src/lane.js';
import { ALLOWED, CONFIG, ackError, setup, statusText } from './helpers/app.js';
import { HOST, NOW, UID, fakeGuardian, network } from './helpers/fakeGuardian.js';

const CLOSE = COMMANDS.VALVE_CLOSE;
const OPEN = COMMANDS.VALVE_OPEN;
const PING = COMMANDS.PING;
const X = 'AAAA00000000';
const Y = 'BBBB00000000';
const Z = 'CCCC00000000';
const valveId = (uid) => `ext:test-integration:guardian:${uid}`;

/** A command sent now, its outcome filled in when Gladys is answered (the clock is the test's). */
function start(s, key, deviceId) {
  const outcome = { done: false };
  const sentAt = s.clock.elapsed;
  outcome.ack = s.send(key, 1, deviceId).then(
    (result) =>
      Object.assign(outcome, { done: true, ok: true, result, ms: s.clock.elapsed - sentAt }),
    (error) =>
      Object.assign(outcome, { done: true, ok: false, error, ms: s.clock.elapsed - sentAt }),
  );
  return outcome;
}

/** Moves the clock 10 ms at a time until `cond()` holds (`ms` at most). */
async function until(s, cond, ms = 5 * SECOND) {
  for (let i = 0; i < ms / 10 && !cond(); i += 1) await s.advance(10, 10);
  assert.ok(cond(), 'condition reached in time');
}

/** Times (virtual ms) at which the controller received each close. */
function closeTimes(s, dev) {
  const at = [];
  dev.forge.set(CLOSE, (answer) => {
    at.push(s.clock.elapsed);
    return answer;
  });
  return at;
}

/** A close kept that never left, as /data gives it at a restart, checked now. */
function unsentClose(s, ctl, uids = [UID]) {
  ctl.guard = s.app.newGuard(uids);
  s.app.armStopCheck(ctl, 0);
  return ctl.guard;
}

/** A close kept, sent a minute ago and never seen applied: its check reads, then resends. */
function sentClose(s, ctl, uids = [UID]) {
  ctl.guard = s.app.newGuard(uids);
  Object.assign(ctl.guard, { written: true, sentAt: s.app.mono() - 60 * SECOND, sentSeq: 0 });
  s.app.armStopCheck(ctl, 0);
  return ctl.guard;
}

test('r13: the check of a close never sent waits for an open in flight, never cuts it', async (t) => {
  const s = await setup(t, { config: ALLOWED });
  s.dev.valve = 8;
  // The answer of the open takes 800 ms: the check comes while it is in flight.
  s.dev.delay.set(OPEN, 800);
  const open = start(s, 'open');
  await until(s, () => s.dev.count(OPEN) === 1);
  const ctl = s.app.controllers.get(HOST);
  const line = ctl.lane.holder;
  assert.equal(line?.kind, 'command', 'the open holds the line');
  unsentClose(s, ctl);
  await s.advance(5 * SECOND, 50);
  await open.ack;
  assert.equal(line.signal.aborted, false, 'the line of the open was never cut');
  assert.equal(ackError(open), undefined, 'the open is answered "ok"');
  // The close came after the open: it leaves after it, and wins.
  await s.advance(20 * SECOND, 100);
  assert.equal(s.dev.valve, 8);
});

test('r07: a close clicked while a resend check reads a silent controller leaves at once', async (t) => {
  const s = await setup(t);
  const ctl = s.app.controllers.get(HOST);
  // The check reads first (ping, status): the controller does not answer them (1.5 s each).
  s.dev.lose.add(PING);
  s.dev.lose.add(COMMANDS.VALVE_STATUS);
  sentClose(s, ctl);
  await until(s, () => ctl.checking && ctl.lane.holder !== undefined);
  await s.advance(100, 10);
  s.dev.lose.clear();
  const at = closeTimes(s, s.dev);
  const clickAt = s.clock.elapsed;
  const click = start(s, 'close');
  await until(s, () => at.length > 0, 2 * SECOND);
  assert.ok(at[0] - clickAt < 50, `the click's close left ${at[0] - clickAt} ms after the click`);
  await s.advance(4 * SECOND, 50);
  await click.ack;
  assert.equal(ackError(click), undefined);
});

test('r07: a resend check waits for a poll read in flight, never cuts it', async (t) => {
  const s = await setup(t, { config: { ...CONFIG, refresh_interval: 10 } });
  const ctl = s.app.controllers.get(HOST);
  // The next poll read: its onboard sensor answers in 1 s.
  s.dev.delay.set(COMMANDS.ONBOARD_SENSOR_STATUS, SECOND);
  const asked = s.dev.count(COMMANDS.ONBOARD_SENSOR_STATUS);
  await until(
    s,
    () => s.dev.count(COMMANDS.ONBOARD_SENSOR_STATUS) > asked && ctl.lane.holder?.kind === 'read',
    15 * SECOND,
  );
  const read = ctl.lane.holder;
  sentClose(s, ctl);
  await s.advance(3 * SECOND, 50);
  assert.equal(read.signal.aborted, false, 'the poll read was never cut');
  assert.ok(!s.logs.some((l) => /ended by a close/.test(l)));
  assert.ok(s.dev.count(CLOSE) >= 1, 'the check resent the close after the read');
});

test('r04: closes reaching another valve probe each address once per 5 s at most', async (t) => {
  const clock = testClock({ start: NOW });
  const net = network({ timers: clock.timers });
  const A = net.add(fakeGuardian({ timers: clock.timers, uid: X, sensors: [] }), '192.168.1.61');
  const B = net.add(fakeGuardian({ timers: clock.timers, uid: Y, sensors: [] }), '192.168.1.62');
  const C = net.add(fakeGuardian({ timers: clock.timers, uid: Z, sensors: [] }), '192.168.1.63');
  const s = await setup(t, {
    clock,
    net,
    dev: A,
    create: false,
    config: { addresses: '192.168.1.61,192.168.1.62,192.168.1.63', refresh_interval: 3600 },
  });
  await s.advance(3 * SECOND);
  const pings = [B, C].map((d) => d.count(PING));
  // A scene closed three valves that are nowhere: their closes reached A (valve X).
  sentClose(s, s.app.controllers.get('192.168.1.61'), [
    '5C0000000001',
    '5C0000000002',
    '5C0000000003',
  ]);
  await s.advance(3 * SECOND, 50);
  assert.deepEqual(
    [B, C].map((d, i) => d.count(PING) - pings[i]),
    [1, 1],
    'one identity probe per address',
  );
  assert.equal(s.app.lost.size, 3, 'the three closes are kept, searched for');
});

test('r11: a close taken away from an offline controller is never sent there when it is back', async (t) => {
  const clock = testClock({ start: NOW });
  const net = network({ timers: clock.timers });
  const A = net.add(fakeGuardian({ timers: clock.timers, uid: X, sensors: [] }), '192.168.1.71');
  const B = net.add(fakeGuardian({ timers: clock.timers, uid: Y, sensors: [] }), '192.168.1.72');
  const C = net.add(fakeGuardian({ timers: clock.timers, uid: Z, sensors: [] }), '192.168.1.73');
  C.silent = true;
  const s = await setup(t, {
    clock,
    net,
    dev: A,
    create: false,
    config: { addresses: '192.168.1.71,192.168.1.72,192.168.1.73', refresh_interval: 3600 },
  });
  await s.advance(6 * SECOND);
  // The DHCP swaps A and B; the close of X reaches Y, goes on to C (never
  // identified), then to B once X is read there.
  A.uid = Y;
  B.uid = X;
  await s.press('close', 1, { deviceId: valveId(X) });
  await s.advance(10 * SECOND, 100);
  assert.equal(B.valve, 8, 'X closed at its new address');
  assert.equal(s.app.controllers.get('192.168.1.73').guard, undefined, 'nothing kept at C');
  // C (valve Z) comes back: nobody clicked to close Z.
  C.silent = false;
  await s.advance(60 * SECOND, 100);
  assert.equal(C.count(CLOSE), 0);
  assert.equal(C.valve, 4, 'Z still open');
});

test('m1: a click while the check of a close never sent waits for its answer: it leaves at once, answered as a close under way', async (t) => {
  const s = await setup(t);
  const ctl = s.app.controllers.get(HOST);
  // Every close is answered in 800 ms; the valve starts closing as it gets the first.
  s.dev.delay.set(CLOSE, 800);
  const at = closeTimes(s, s.dev);
  unsentClose(s, ctl);
  await until(s, () => at.length === 1);
  await s.advance(100, 10);
  assert.equal(ctl.lane.holder?.kind, 'stop', "the check's close waits for its answer");
  const clickAt = s.clock.elapsed;
  const click = start(s, 'close');
  await until(s, () => at.length === 2, 2 * SECOND);
  assert.ok(at[1] - clickAt < 50, `the click's close left ${at[1] - clickAt} ms after the click`);
  await until(s, () => click.done, 4 * SECOND);
  assert.equal(ackError(click), undefined, 'our own close under way: never "refuses any command"');
  assert.ok(click.ms < 3500, `answered in ${click.ms} ms`);
  await s.advance(500, 50);
  assert.match(
    statusText(s.gladys),
    /Close at 192\.168\.1\.50 \(ABCDEF123456\): the valve is closing/,
  );
  await s.advance(20 * SECOND, 100);
  assert.equal(s.dev.valve, 8);
  assert.equal(ctl.guard, undefined, 'let go once closed');
});

test('m1: a second click while the first close moves the valve is a close under way', async (t) => {
  const s = await setup(t);
  assert.equal(ackError(await s.press('close')), undefined);
  // The valve closes for 6 s: the second click gets "moving", reads it closing.
  const again = await s.press('close');
  assert.equal(ackError(again), undefined);
  assert.equal(s.dev.count(COMMANDS.VALVE_STATUS) > 0, true);
  await s.advance(20 * SECOND, 100);
  assert.equal(s.dev.valve, 8);
});

test('m1: a click on a valve that opens reads it once, then tries again as before', async (t) => {
  const s = await setup(t);
  s.dev.valve = 8;
  s.dev.openElsewhere();
  const pings = s.dev.count(PING);
  const outcome = await s.press('close');
  assert.match(ackError(outcome), /bouge et refuse toute commande/);
  assert.equal(s.dev.count(PING) - pings, 1, 'one read on "moving", never one per try');
  assert.ok(s.dev.count(CLOSE) >= 5);
});

test('r4 m1: "closed" read right after "moving": never a success nor let go there, the next check confirms it', async (t) => {
  const s = await setup(t);
  // The valve was closing (the button): it reaches "closed" as it refuses the click.
  s.dev.move(5, 8, [[6, 300]]);
  s.dev.forge.set(CLOSE, (answer) => {
    for (const timer of s.dev.moveTimers) s.dev.timers.clearTimeout(timer);
    s.dev.valve = 8;
    return answer;
  });
  const outcome = await s.press('close');
  assert.match(ackError(outcome), /pas encore confirmée : revérifiée/);
  assert.equal(s.dev.count(CLOSE), 1, 'no other datagram');
  assert.ok(s.app.controllers.get(HOST).guard, 'kept');
  await s.advance(6 * SECOND, 100);
  assert.equal(s.app.controllers.get(HOST).guard, undefined, 'let go once a check reads it closed');
  assert.equal(s.dev.count(CLOSE), 1);
});

for (const lagMs of [500, 3 * SECOND]) {
  test(`r4 m1: a status that lags ${lagMs} ms behind an open starting is never taken for a close done`, async (t) => {
    const s = await setup(t);
    s.dev.valve = 8;
    // The valve starts opening (the app): commands get "moving" at once, but
    // the status still says "closed" for a while.
    let lag = true;
    s.dev.forge.set(COMMANDS.VALVE_STATUS, (a) =>
      lag ? { ...a, data: { ...a.data, state: 8 } } : a,
    );
    s.dev.openElsewhere();
    s.clock.timers.setTimeout(() => (lag = false), lagMs);
    const outcome = await s.press('close');
    assert.match(ackError(outcome), /pas encore confirmée : revérifiée/, 'never a success');
    assert.ok(s.app.controllers.get(HOST).guard, 'kept');
    await s.advance(30 * SECOND, 100);
    assert.equal(s.dev.valve, 8, 'the newer click wins: closed once the opening ended');
    assert.equal(s.app.controllers.get(HOST).guard, undefined);
  });
}

test('m1: a click refused "moving" by another valve now at the address: said so, never resent to it', async (t) => {
  const s = await setup(t);
  // The address now answers valve Y, which is opening (the app, its button).
  s.dev.uid = Y;
  s.dev.valve = 8;
  s.dev.openElsewhere();
  const outcome = await s.press('close');
  assert.match(ackError(outcome), /c'est la vanne BBBB00000000 qui y répond, pas ABCDEF123456/);
  assert.equal(s.dev.count(CLOSE), 1, 'one datagram, then never another to valve Y');
  assert.equal(s.app.lost.has(UID), true, 'the close of the valve clicked is kept, searched for');
});

test('r4 I1: a click that cuts the check of the close of another valve carries it: that valve still closes', async (t) => {
  const clock = testClock({ start: NOW });
  const net = network({ timers: clock.timers });
  const A = net.add(fakeGuardian({ timers: clock.timers, uid: Y, sensors: [] }), '192.168.1.41');
  const B = net.add(fakeGuardian({ timers: clock.timers, uid: X, sensors: [] }), '192.168.1.42');
  const s = await setup(t, {
    clock,
    net,
    dev: A,
    create: false,
    config: { addresses: '192.168.1.41,192.168.1.42', refresh_interval: 3600 },
  });
  await s.advance(3 * SECOND);
  const ctlA = s.app.controllers.get('192.168.1.41');
  assert.equal(ctlA.uid, Y);
  // A close of X kept at A that never left (a fan-out, /data): its check sends
  // it, the answer takes 800 ms; a click for Y (A's valve) comes meanwhile.
  A.delay.set(CLOSE, 800);
  const at = closeTimes(s, A);
  unsentClose(s, ctlA, [X]);
  await until(s, () => at.length === 1);
  await s.advance(100, 10);
  A.delay.delete(CLOSE);
  const click = start(s, 'close', valveId(Y));
  await until(s, () => at.length === 2, 2 * SECOND);
  assert.ok(at[1] - at[0] < 200, 'the click cut the check');
  await s.advance(15 * SECOND, 100);
  await click.ack;
  assert.equal(A.valve, 8, 'Y (clicked) closed');
  assert.ok(B.count(CLOSE) >= 1, 'the close of X went on to its valve');
  assert.equal(B.valve, 8, 'X closed');
});

test('m1: the lane: a clicked close cuts a preemptible one, never the reverse', async () => {
  const lane = new Lane();
  // A preemptible close cuts a read, like a close.
  const read = await lane.acquire('read');
  const unsent = lane.acquire('stop', { preemptible: true });
  assert.equal(read.signal.aborted, true);
  read.release();
  const check = await unsent;
  assert.equal(check.preemptible, true);
  // A clicked close cuts it.
  const click = lane.acquire('stop');
  assert.equal(check.signal.aborted, true);
  check.release();
  const clicked = await click;
  // A preemptible close never cuts a clicked one; a clicked close waiting goes first.
  const order = [];
  const later = lane
    .acquire('stop', { preemptible: true })
    .then((h) => (order.push('preemptible'), h.release()));
  const second = lane.acquire('stop').then((h) => (order.push('click'), h.release()));
  assert.equal(clicked.signal.aborted, false);
  clicked.release();
  await Promise.all([later, second]);
  assert.deepEqual(order, ['click', 'preemptible']);
  // Two preemptible closes: the second waits for the first.
  const first = await lane.acquire('stop', { preemptible: true });
  const next = lane.acquire('stop', { preemptible: true });
  assert.equal(first.signal.aborted, false);
  first.release();
  (await next).release();
});
