// -----------------------------------------------------------------------------
// The findings of review r2: a close follows its valve wherever it is
// identified (I1), one test per guard a mutant removed (I3), and the minor
// points (a close without a readable UID, a short restart, a deleted device).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testClock } from './kit/index.mjs';
import { COMMANDS, SECOND } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { ALLOWED, CONFIG, ackError, settle, setup, statusText } from './helpers/app.js';
import { HOST, NOW, UID, fakeGuardian, network } from './helpers/fakeGuardian.js';

const CLOSE = COMMANDS.VALVE_CLOSE;
const OPEN = COMMANDS.VALVE_OPEN;
const X = 'AAAA00000000';
const Y = 'BBBB00000000';
const Z = 'CCCC00000000';
const valveId = (uid) => `ext:test-integration:guardian:${uid}`;

/** The stuck valve of a controller: "ok" to a close, never moving. */
const stick = (dev, state = 4) =>
  dev.forge.set(CLOSE, () => {
    for (const timer of dev.moveTimers) dev.timers.clearTimeout(timer);
    dev.valve = state;
    return { command: CLOSE, status: 'ok' };
  });

/** Time from a command to its answer, on the virtual clock. */
async function timed(s, key, deviceId) {
  const start = s.clock.monotonic();
  let end;
  const ack = s.send(key, 1, deviceId).then((r) => {
    end = s.clock.monotonic();
    return r;
  });
  for (let i = 0; i < 200 && end === undefined; i += 1) await s.advance(50, 50);
  return { result: await ack, ms: end - start };
}

test('I1: addresses swapped during a run, a third controller offline: X closes where it is', async (t) => {
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
  A.uid = Y;
  B.uid = X;
  await s.press('close', 1, { deviceId: valveId(X) });
  await s.advance(10 * SECOND, 100);
  assert.equal(B.valve, 8, 'X closed at its new address within 10 s');
  assert.ok(!s.app.controllers.get('192.168.1.73').guard?.uids.has(X), 'not parked on C');
});

test('n14: a sensor left for lack of time is unread: the open is refused', async (t) => {
  const clock = testClock({ start: NOW });
  const net = network({ timers: clock.timers });
  const S1 = '5E0500000001';
  const S2 = '5E0500000002';
  const dev = net.add(fakeGuardian({ timers: clock.timers, valve: 8, sensors: [S1, S2] }));
  const s = await setup(t, { clock, net, dev, config: ALLOWED });
  await s.advance(3 * SECOND);
  dev.sensors.get(S2).wet = true;
  // Ends right before the budget (2.4 s): the first sensor gets the 300 ms
  // minimum and answers past it; the second one is never asked.
  dev.delay.set(COMMANDS.VALVE_STATUS, 1000);
  dev.delay.set(COMMANDS.ONBOARD_SENSOR_STATUS, 1240);
  dev.delay.set(COMMANDS.SENSOR_STATUS, 130);
  const outcome = await s.press('open');
  assert.match(ackError(outcome), new RegExp(`${S2}`));
  assert.equal(dev.count(OPEN), 0);
});

test('n03: the close an open lets go is out of /data before the datagram', async (t) => {
  const { dev, press, store } = await setup(t, { config: ALLOWED });
  dev.refuse.set(CLOSE, 99);
  await press('close');
  assert.equal(store.data.stops.length, 1);
  let keptAtDatagram;
  dev.forge.set(OPEN, (a) => {
    keptAtDatagram = store.data.stops.length;
    return a;
  });
  assert.equal(ackError(await press('open')), undefined);
  assert.equal(keptAtDatagram, 0);
});

test('h05, h06: Gladys is answered by 3.5 s even when a datagram cannot leave', async (t) => {
  const s = await setup(t, { config: ALLOWED });
  s.dev.preSend.set(CLOSE, 8 * SECOND);
  const close = await timed(s, 'close');
  assert.equal(close.result.success, false);
  assert.ok(close.ms <= 3600, `close answered after ${close.ms} ms`);
  s.dev.preSend.delete(CLOSE);
  await s.advance(20 * SECOND, 100);
  s.dev.valve = 8;
  for (const timer of s.dev.moveTimers) s.dev.timers.clearTimeout(timer);
  await s.advance(20 * SECOND, 100);
  s.dev.preSend.set(OPEN, 8 * SECOND);
  const open = await timed(s, 'open');
  assert.equal(open.result.success, false);
  assert.ok(open.ms <= 3600, `open answered after ${open.ms} ms`);
});

test('n26-n29: after shutdown, nothing arms a timer again, and the line is cut at once', async (t) => {
  const clock = testClock({ start: NOW });
  const store = memoryStore({
    controllers: [{ host: HOST, port: 7777, uid: UID, lastAttemptAt: NOW - 1000 }],
    stops: [{ host: HOST, port: 7777, uids: [UID], since: NOW - 5000, written: true }],
  });
  const net = network({ timers: clock.timers });
  const dev = net.add(fakeGuardian({ timers: clock.timers }));
  dev.silent = true;
  const s = await setup(t, { clock, net, dev, store, create: false, connect: false });
  // A check holds the line on a silent controller (its request waits 1.5 s).
  await s.advance(50, 10);
  const ctl = s.app.controllers.get(HOST);
  assert.ok(ctl.lane.holder, 'a check holds the line');
  await s.app.shutdown();
  await settle(10);
  assert.equal(clock.pending, 0, `${clock.pending} timers left right after shutdown`);
  // Late callbacks (a read, a command, a reconnection) arm nothing either.
  s.app.schedule(ctl, 1000);
  s.app.followUp(ctl);
  await s.app.onConnected(() => Promise.reject(new Error('Gladys gone')));
  await settle(10);
  assert.equal(clock.pending, 0, `${clock.pending} timers left after late callbacks`);
});

test('n21: a held close is sent again every 10 min at most, forever', async (t) => {
  const { dev, press, advance } = await setup(t);
  stick(dev);
  await press('close');
  await advance(2 * 60 * 60 * SECOND, SECOND);
  assert.ok(dev.count(CLOSE) >= 15, `${dev.count(CLOSE)} closes in 2 h`);
});

test('n24: a restart gives a close kept a new budget of quick resends', async (t) => {
  const clock = testClock({ start: NOW });
  const store = memoryStore({
    controllers: [{ host: HOST, port: 7777, uid: UID, lastAttemptAt: NOW - 1000 }],
    stops: [{ host: HOST, port: 7777, uids: [UID], since: NOW - 5000, written: true, resends: 3 }],
  });
  const net = network({ timers: clock.timers });
  const dev = net.add(fakeGuardian({ timers: clock.timers }));
  stick(dev);
  const s = await setup(t, { clock, net, dev, store, create: false });
  await s.advance(10 * SECOND, 100);
  assert.ok(dev.count(CLOSE) >= 3, `${dev.count(CLOSE)} closes in 10 s`);
});

test('m2: a controller restarted between two checks (uptime) gives quick resends again', async (t) => {
  const { dev, press, advance } = await setup(t);
  stick(dev);
  await press('close');
  await advance(40 * SECOND, 100);
  const held = dev.count(CLOSE);
  dev.uptime = 3;
  await advance(30 * SECOND, 100);
  assert.ok(dev.count(CLOSE) - held >= 2, `${dev.count(CLOSE) - held} closes after the restart`);
});

async function lostX(t, more = {}) {
  // A answers Y, B answers Z: the close of X goes to A, then is found nowhere.
  const clock = testClock({ start: NOW });
  const net = network({ timers: clock.timers });
  const A = net.add(fakeGuardian({ timers: clock.timers, uid: Y, sensors: [] }), '192.168.1.81');
  const B = net.add(fakeGuardian({ timers: clock.timers, uid: Z, sensors: [] }), '192.168.1.82');
  const store = memoryStore({
    controllers: [{ host: '192.168.1.81', port: 7777, uid: X, lastAttemptAt: NOW - 1000 }],
  });
  const s = await setup(t, {
    clock,
    net,
    dev: A,
    store,
    create: false,
    config: { addresses: '192.168.1.81,192.168.1.82', refresh_interval: 3600 },
    ...more,
  });
  await s.press('close', 1, { deviceId: valveId(X) });
  await s.advance(3 * SECOND, 100);
  return { ...s, A, B, store };
}

test('m3: a valve deleted in Gladys gives its close searched for up', async (t) => {
  const s = await lostX(t);
  assert.equal(s.app.lost.has(X), true);
  await s.gladys.fake.deviceDeleted({ external_id: valveId(X), features: [] });
  await settle(10);
  assert.equal(s.app.lost.size, 0);
  assert.deepEqual(s.store.data.lost, []);
  assert.doesNotMatch(statusText(s.gladys), /not found/);
});

test('n31: a new configuration sends a close searched for to its new address', async (t) => {
  const s = await lostX(t);
  assert.equal(s.app.lost.has(X), true);
  const D = s.net.add(
    fakeGuardian({ timers: s.clock.timers, uid: X, sensors: [] }),
    '192.168.1.83',
  );
  // D cannot be identified (its pings are lost): only the retry of the lost close reaches it.
  D.lose.add(COMMANDS.PING);
  s.app.configUpdated({
    addresses: '192.168.1.81,192.168.1.82,192.168.1.83',
    refresh_interval: 3600,
  });
  await s.advance(3 * SECOND, 100);
  assert.ok(D.count(CLOSE) >= 1);
});

test('n30: a click on a valve searched for sends it, and it is no longer "not found"', async (t) => {
  const clock = testClock({ start: NOW });
  const net = network({ timers: clock.timers });
  const E = net.add(fakeGuardian({ timers: clock.timers, uid: X, sensors: [] }), '192.168.1.91');
  const store = memoryStore({
    controllers: [{ host: '192.168.1.91', port: 7777, uid: X, lastAttemptAt: NOW - 1000 }],
    lost: [{ uid: X, since: NOW - 60_000 }],
  });
  const s = await setup(t, {
    clock,
    net,
    dev: E,
    store,
    create: false,
    connect: false,
  });
  assert.equal(s.app.lost.has(X), true);
  await s.press('close', 1, { deviceId: valveId(X) });
  assert.equal(E.count(CLOSE), 1);
  assert.equal(s.app.lost.size, 0);
});

test('n12: three valves fanned out to one address while it is busy keep all three', async (t) => {
  const clock = testClock({ start: NOW });
  const net = network({ timers: clock.timers });
  const P = net.add(fakeGuardian({ timers: clock.timers, uid: X, sensors: [] }), '192.168.1.31');
  P.silent = true;
  const s = await setup(t, {
    clock,
    net,
    dev: P,
    create: false,
    store: memoryStore(null, { unreadable: true }),
    config: { addresses: '192.168.1.31', refresh_interval: 3600 },
  });
  await s.advance(4 * SECOND);
  const acks = [X, Y, Z].map((uid) => s.send('close', 1, valveId(uid)));
  await s.advance(5 * SECOND, 50);
  await Promise.all(acks);
  assert.deepEqual([...s.app.controllers.get('192.168.1.31').guard.uids].sort(), [X, Y, Z]);
});

test('m1: a close kept without a readable UID is still sent, in doubt', async (t) => {
  const clock = testClock({ start: NOW });
  const store = memoryStore({
    stops: [{ host: HOST, port: 7777, uids: ['??'], since: NOW - 5000, written: true }],
  });
  const net = network({ timers: clock.timers });
  const dev = net.add(fakeGuardian({ timers: clock.timers }));
  const s = await setup(t, { clock, net, dev, store, create: false, config: CONFIG });
  await s.advance(20 * SECOND, 100);
  assert.ok(dev.count(CLOSE) >= 1);
  assert.equal(dev.valve, 8);
});

test('m23: decideStop never judges a close on the state of another valve', async (t) => {
  const { app } = await setup(t);
  const guard = app.newGuard([X]);
  Object.assign(guard, { written: true, sentSeq: 1, sentAt: 0 });
  assert.equal(app.decideStop(guard, { uid: Y, state: 8 }, 5, 1e9), 'other');
  // No UID kept (a damaged entry): any valve there, judged on its state.
  const any = app.newGuard([]);
  Object.assign(any, { written: true, sentSeq: 1, sentAt: 0 });
  assert.equal(app.decideStop(any, { uid: Y, state: 8 }, 5, 1e9), 'done');
});
