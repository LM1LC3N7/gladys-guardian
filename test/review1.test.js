// -----------------------------------------------------------------------------
// The findings of review r1: a new guard per click (B1), a close redirected
// to its valve, never dropped nor confirmed on another one (B2), every
// paired sensor read before an open (I1), held closes sent again (I2), and
// one test per guard a mutant removed (I3).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testClock } from './kit/index.mjs';
import { COMMANDS, SECOND, TIMINGS } from '../src/constants.js';
import { Lane } from '../src/lane.js';
import { memoryStore } from '../src/store.js';
import { ALLOWED, CONFIG, ackError, settle, setup, statusText } from './helpers/app.js';
import { HOST, NOW, SENSOR, UID, fakeGuardian, network } from './helpers/fakeGuardian.js';

const CLOSE = COMMANDS.VALVE_CLOSE;
const OPEN = COMMANDS.VALVE_OPEN;

test('B1: a close clicked after an open left is never let go by that open', async (t) => {
  const { dev, press, send, advance, store, app } = await setup(t, { config: ALLOWED });
  // A close kept (refused by the controller), then an open whose answer is slow.
  dev.refuse.set(CLOSE, 99);
  await press('close');
  dev.refuse.delete(CLOSE);
  dev.valve = 8;
  // The answer of the open takes 800 ms: the close is clicked meanwhile.
  dev.delay.set(OPEN, 800);
  const open = send('open');
  for (let i = 0; i < 300 && dev.count(OPEN) === 0; i += 1) await advance(10, 10);
  assert.equal(dev.count(OPEN), 1);
  // A leak scene closes it, the open's answer still on its way.
  await advance(100, 10);
  const close = send('close');
  await advance(5 * SECOND, 50);
  await Promise.all([open, close]);
  assert.ok(app.controllers.get(HOST).guard, 'the newer close is kept');
  assert.equal(store.data.stops.length, 1);
  await advance(40 * SECOND, 100);
  assert.equal(dev.valve, 8, 'closed in the end');
});

async function swapped(t) {
  // /data: A held X, B held Y; the addresses swapped (DHCP) while Gladys was down.
  const clock = testClock({ start: NOW });
  const net = network({ timers: clock.timers });
  const X = 'AAAA00000000';
  const Y = 'BBBB00000000';
  const A = net.add(fakeGuardian({ timers: clock.timers, uid: Y, sensors: [] }), '192.168.1.21');
  const B = net.add(fakeGuardian({ timers: clock.timers, uid: X, sensors: [] }), '192.168.1.22');
  const store = memoryStore({
    controllers: [
      { host: '192.168.1.21', port: 7777, uid: X, lastAttemptAt: NOW - 5000 },
      { host: '192.168.1.22', port: 7777, uid: Y, lastAttemptAt: NOW - 5000 },
    ],
  });
  const s = await setup(t, {
    clock,
    net,
    dev: A,
    store,
    create: false,
    config: { addresses: '192.168.1.21,192.168.1.22', refresh_interval: 3600 },
  });
  return { ...s, A, B, X, Y };
}

test('B2: a close that reaches another valve is never a success, and goes on to its valve', async (t) => {
  const { A, B, X, Y, press, advance, gladys, app } = await swapped(t);
  const outcome = await press('close', 1, { deviceId: `ext:test-integration:guardian:${X}` });
  assert.match(ackError(outcome), new RegExp(`c'est la vanne ${Y} qui y répond, pas ${X}`));
  assert.equal(A.count(CLOSE), 1, 'the other valve closed (the safe side)');
  // B was never identified in this run: the close of X goes there at once.
  await advance(20 * SECOND, 100);
  assert.equal(B.count(CLOSE) >= 1, true);
  assert.equal(B.valve, 8, 'X closed');
  assert.equal(app.lost.size, 0);
  assert.doesNotMatch(statusText(gladys), /not found/);
});

test('B2: a valve found nowhere is kept (in /data, said) until it answers somewhere', async (t) => {
  const { A, B, X, press, advance, gladys, app, store } = await swapped(t);
  // B is identified first as Y... (another valve): X is nowhere.
  B.uid = 'CCCC00000000';
  const first = app.tick(app.controllers.get('192.168.1.22'));
  await advance(3 * SECOND, 50);
  await first;
  await press('close', 1, { deviceId: `ext:test-integration:guardian:${X}` });
  await advance(SECOND);
  assert.equal(app.lost.has(X), true);
  assert.deepEqual(
    store.data.lost.map((l) => l.uid),
    [X],
  );
  assert.match(statusText(gladys), new RegExp(`Close of valve ${X}: not found`));
  // X comes back at B: its close goes there.
  B.uid = X;
  const again = app.tick(app.controllers.get('192.168.1.22'));
  await advance(10 * SECOND, 100);
  await again;
  assert.equal(B.valve, 8);
  assert.equal(app.lost.size, 0);
  assert.ok(A.count(CLOSE) >= 1);
});

test('B2: the read back of a click checks the identity (a success only on the valve clicked)', async (t) => {
  const { dev, press } = await setup(t);
  dev.lose.add(COMMANDS.PING);
  const outcome = await press('close');
  assert.match(ackError(outcome), /identité n'a pas encore pu être lue/);
});

test('B2: two valves fanned out to the same addresses each keep their close', async (t) => {
  const clock = testClock({ start: NOW });
  const net = network({ timers: clock.timers });
  const P = net.add(
    fakeGuardian({ timers: clock.timers, uid: 'DDDD00000000', sensors: [] }),
    '192.168.1.31',
  );
  const Q = net.add(
    fakeGuardian({ timers: clock.timers, uid: 'EEEE00000000', sensors: [] }),
    '192.168.1.32',
  );
  P.silent = true;
  Q.silent = true;
  const s = await setup(t, {
    clock,
    net,
    dev: P,
    create: false,
    store: memoryStore(null, { unreadable: true }),
    config: { addresses: '192.168.1.31,192.168.1.32', refresh_interval: 3600 },
  });
  await s.advance(4 * SECOND);
  const a = s.send('close', 1, 'ext:test-integration:guardian:DDDD00000000');
  const b = s.send('close', 1, 'ext:test-integration:guardian:EEEE00000000');
  await s.advance(5 * SECOND, 50);
  await Promise.all([a, b]);
  assert.deepEqual([...s.app.controllers.get('192.168.1.31').guard.uids].sort(), [
    'DDDD00000000',
    'EEEE00000000',
  ]);
  P.silent = false;
  Q.silent = false;
  await s.advance(40 * SECOND, 100);
  assert.equal(P.valve, 8);
  assert.equal(Q.valve, 8);
});

test('I1: every paired sensor is read before an open; one not read refuses it', async (t) => {
  const { dev, press } = await setup(t, { config: ALLOWED });
  dev.valve = 8;
  dev.lose.add(COMMANDS.SENSOR_STATUS);
  assert.match(ackError(await press('open')), /n'a pas pu être lu à temps|trop lentement/);
  dev.lose.delete(COMMANDS.SENSOR_STATUS);
  dev.forge.set(COMMANDS.SENSOR_STATUS, (a) => ({ ...a, data: { ...a.data, wet: 'no' } }));
  assert.match(ackError(await press('open')), new RegExp(`${SENSOR} n'a pas pu être lu`));
  assert.equal(dev.count(OPEN), 0);
});

test('I1: the list of paired sensors unknown: no open', async (t) => {
  const clock = testClock({ start: NOW });
  const net = network({ timers: clock.timers });
  const dev = net.add(fakeGuardian({ timers: clock.timers, valve: 8 }));
  dev.lose.add(COMMANDS.SENSOR_PAIR_DUMP);
  const s = await setup(t, { clock, net, dev, config: ALLOWED });
  await s.advance(5 * SECOND);
  assert.match(ackError(await s.press('open')), /liste des détecteurs/);
  assert.equal(dev.count(OPEN), 0);
});

test('I1: a slow controller whose sensor reading does not fit: refused, never sent', async (t) => {
  const { dev, press } = await setup(t, { config: ALLOWED });
  dev.valve = 8;
  dev.latencyMs = 700;
  assert.ok(ackError(await press('open')));
  assert.equal(dev.count(OPEN), 0);
});

test('m02: a configuration applied meanwhile (option still on) stops an open', async (t) => {
  const s = await setup(t, { config: ALLOWED });
  s.dev.valve = 8;
  s.dev.latencyMs = 200;
  const ack = s.send('open');
  await s.advance(300, 10);
  s.app.configUpdated({ ...ALLOWED });
  await s.advance(5 * SECOND, 50);
  const result = await ack;
  assert.equal(result.success, false);
  assert.match(result.error, /configuration a changé/);
  assert.equal(s.dev.count(OPEN), 0);
});

test('m05, m06: checkOpen refuses past the send deadline, and once Gladys was answered', async (t) => {
  const { app } = await setup(t, { config: ALLOWED });
  const ctl = app.controllers.get(HOST);
  const entry = (more) => ({
    generation: app.generation,
    seq: ctl.protectSeq,
    sendBy: Infinity,
    late: false,
    ...more,
  });
  assert.doesNotThrow(() => app.checkOpen(ctl, entry()));
  assert.throws(() => app.checkOpen(ctl, entry({ sendBy: app.mono() - 1 })), /trop lentement/);
  assert.throws(() => app.checkOpen(ctl, entry({ late: true })), /trop lentement/);
});

test('m05: a /data save that takes the open past its deadline sends nothing', async (t) => {
  const store = memoryStore();
  const s = await setup(t, { config: ALLOWED, store });
  s.dev.refuse.set(CLOSE, 99);
  await s.press('close');
  s.dev.refuse.delete(CLOSE);
  s.dev.valve = 8;
  for (const timer of s.dev.moveTimers) s.dev.timers.clearTimeout(timer);
  // The save of the open ends at 2.9 s: past the 2.7 s of its deadline.
  store.hang = new Promise((resolve) => s.clock.timers.setTimeout(resolve, 2_800));
  const outcome = await s.press('open');
  assert.ok(ackError(outcome));
  assert.equal(s.dev.count(OPEN), 0);
});

test('m15: the option is checked in beforeSend, after a slow name lookup', async (t) => {
  const s = await setup(t, { config: ALLOWED });
  s.dev.valve = 8;
  s.dev.preSend.set(OPEN, 300);
  const sensorReads = s.dev.count(COMMANDS.SENSOR_STATUS);
  const ack = s.send('open');
  for (let i = 0; i < 400 && s.dev.count(COMMANDS.SENSOR_STATUS) === sensorReads; i += 1) {
    await s.advance(5, 5);
  }
  // The sensor answered: the open is between its last check and its datagram.
  await s.advance(100, 5);
  s.app.config.allowOpen = false;
  await s.advance(5 * SECOND, 50);
  const result = await ack;
  assert.equal(result.success, false);
  assert.match(result.error, /ouverture est désactivée/);
  assert.equal(s.dev.count(OPEN), 0);
});

test('m17: two opens at once: the second is refused', async (t) => {
  const s = await setup(t, { config: ALLOWED });
  s.dev.valve = 8;
  s.dev.latencyMs = 100;
  const first = s.send('open');
  await settle();
  const second = s.send('open');
  await s.advance(5 * SECOND, 50);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.success, true);
  assert.match(b.error, /déjà en cours/);
  assert.equal(s.dev.count(OPEN), 1);
});

test('m25: a read too soon after a close (motor not started) waits, no resend counted', async (t) => {
  const { app } = await setup(t);
  const guard = app.newGuard([UID]);
  Object.assign(guard, { written: true, sentSeq: 5, sentAt: 1000 });
  assert.equal(app.decideStop(guard, { uid: UID, state: 4 }, 6, 1500), 'wait');
  assert.equal(app.decideStop(guard, { uid: UID, state: 4 }, 6, 3500), 'resend');
});

test('m31: a close refused by the controller is never counted nor held', async (t) => {
  const { dev, press, advance, store, app } = await setup(t);
  dev.refuse.set(CLOSE, 99);
  await press('close');
  await advance(3 * 60 * SECOND, SECOND);
  assert.ok(dev.count(CLOSE) >= 10, `${dev.count(CLOSE)} tries`);
  assert.equal(store.data.stops[0].resends, 0);
  assert.equal(app.controllers.get(HOST).guard.held, false);
});

test('m37: a check due sooner is never pushed back by a later one', async (t) => {
  const { app, advance, dev } = await setup(t);
  const ctl = app.controllers.get(HOST);
  ctl.guard = app.newGuard([UID]);
  app.armStopCheck(ctl, 0);
  app.armStopCheck(ctl, TIMINGS.stopCheck);
  await advance(500, 50);
  assert.equal(dev.count(CLOSE), 1, 'the check ran at once');
});

test('m42: a state read without the identity is never given to the valve', async (t) => {
  const s = await setup(t);
  const ctl = s.app.controllers.get(HOST);
  assert.equal(ctl.valve.state, 4);
  s.dev.lose.add(COMMANDS.PING);
  s.dev.valve = 8;
  const holder = await ctl.lane.acquire('check');
  const pending = s.app.readStopState(ctl, holder, s.app.mono() + 5 * SECOND);
  await s.advance(4 * SECOND, 50);
  const back = await pending;
  holder.release();
  assert.equal(back.read.uid, undefined);
  assert.equal(back.read.state, 8);
  assert.equal(ctl.valve.state, 4);
});

test('m44: a close waiting for the line goes before a command and a read', async () => {
  const lane = new Lane();
  const holder = await lane.acquire('check');
  const order = [];
  const read = lane.acquire('read').then((h) => (order.push('read'), h.release()));
  const command = lane.acquire('command').then((h) => (order.push('command'), h.release()));
  const stop = lane.acquire('stop').then((h) => (order.push('stop'), h.release()));
  holder.release();
  await Promise.all([read, command, stop]);
  assert.deepEqual(order, ['stop', 'command', 'read']);
});

test('m1: an open while /data is still being read: refused, said', async (t) => {
  const store = memoryStore();
  store.hangLoad = new Promise(() => {});
  const s = await setup(t, { config: ALLOWED, store, boot: false });
  s.app.boot();
  await s.advance(3 * SECOND);
  s.dev.valve = 8;
  assert.match(ackError(await s.press('open')), /encore en lecture/);
  assert.equal(s.dev.count(OPEN), 0);
  assert.match(statusText(s.gladys), /still being read/);
});

test('m2: /data hung: one write in flight, one waiting, never more', async (t) => {
  const store = memoryStore();
  let calls = 0;
  const save = store.save.bind(store);
  store.save = (data) => {
    calls += 1;
    return save(data);
  };
  const s = await setup(t, { store, config: { ...CONFIG, refresh_interval: 10 } });
  store.hang = new Promise(() => {});
  const before = calls;
  for (let i = 0; i < 5; i += 1) await s.press('close');
  await s.advance(2 * 60 * SECOND, SECOND);
  assert.ok(calls - before <= 1, `${calls - before} writes started while hung`);
});

test('after shutdown, no timer is left armed: nothing keeps the process alive', async (t) => {
  const clock = testClock({ start: NOW });
  const net = network({ timers: clock.timers });
  const dev = net.add(fakeGuardian({ timers: clock.timers }));
  const s = await setup(t, { clock, net, dev, config: { ...CONFIG, refresh_interval: 10 } });
  // A close kept (silent controller), reads scheduled, follow-ups armed.
  dev.silent = true;
  const ack = s.send('close');
  await s.advance(1500, 50);
  const stopping = s.app.shutdown();
  await s.advance(5 * SECOND, 50);
  await stopping;
  await ack;
  await s.advance(10 * 60 * SECOND, SECOND);
  assert.equal(clock.pending, 0, `${clock.pending} timers left`);
});

test('an open that never left keeps the close kept (refused in beforeSend)', async (t) => {
  const s = await setup(t, { config: ALLOWED });
  s.dev.refuse.set(CLOSE, 99);
  await s.press('close');
  // Still refused (kept, the valve open): the open is sent even so, to let it go.
  s.dev.preSend.set(OPEN, 300);
  const sensorReads = s.dev.count(COMMANDS.SENSOR_STATUS);
  const ack = s.send('open');
  for (let i = 0; i < 400 && s.dev.count(COMMANDS.SENSOR_STATUS) === sensorReads; i += 1) {
    await s.advance(5, 5);
  }
  await s.advance(100, 5);
  s.app.config.allowOpen = false;
  await s.advance(5 * SECOND, 50);
  assert.equal((await ack).success, false);
  assert.equal(s.dev.count(OPEN), 0);
  assert.ok(s.app.controllers.get(HOST).guard, 'the close stays kept');
  assert.equal(s.store.data.stops.length, 1, 'and back in /data');
});

test('I2: a controller back after a silence, same state: quick resends again', async (t) => {
  const { dev, press, advance } = await setup(t);
  dev.forge.set(CLOSE, () => {
    for (const timer of dev.moveTimers) dev.timers.clearTimeout(timer);
    dev.valve = 4;
    return { command: CLOSE, status: 'ok' };
  });
  await press('close');
  await advance(15 * SECOND, 100);
  assert.equal(dev.count(CLOSE), 4, 'held');
  // Reboot: silent, then back, still open and still stuck.
  dev.silent = true;
  await advance(20 * SECOND, 100);
  dev.silent = false;
  const back = dev.count(CLOSE);
  await advance(12 * SECOND, 100);
  assert.ok(dev.count(CLOSE) - back >= 3, `${dev.count(CLOSE) - back} closes after it came back`);
});
