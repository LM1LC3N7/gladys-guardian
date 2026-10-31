// -----------------------------------------------------------------------------
// The guards one by one: /data unreadable, hung or failing, the order of
// departure of the requests, confirmations, the close against an open in
// flight, the checks with a hung disk.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testClock } from './kit/index.mjs';
import { COMMANDS, SECOND, TIMINGS } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { ALLOWED, CONFIG, ackError, settle, setup, statusText } from './helpers/app.js';
import { HOST, NOW, UID, fakeGuardian, network } from './helpers/fakeGuardian.js';

const CLOSE = COMMANDS.VALVE_CLOSE;
const OPEN = COMMANDS.VALVE_OPEN;

test('/data unreadable: never overwritten, said, and the close still goes', async (t) => {
  const store = memoryStore({ junk: true }, { unreadable: true });
  const s = await setup(t, { store });
  assert.match(statusText(s.gladys), /cannot be read: never overwritten/);
  const outcome = await s.press('close');
  assert.equal(ackError(outcome), undefined);
  assert.equal(s.dev.count(CLOSE), 1);
  assert.equal(store.saves, 0);
  assert.deepEqual(store.data, { junk: true });
});

test('/data hung on load: the close goes to the configured address within its budget', async (t) => {
  const store = memoryStore();
  store.hangLoad = new Promise(() => {});
  const clock = testClock({ start: NOW });
  const s = await setup(t, { store, clock, create: false, boot: false });
  s.app.boot();
  // The reads start once the 2 s bound of the load is over.
  await s.advance(3 * SECOND);
  const start = clock.monotonic();
  const outcome = await s.press('close');
  assert.equal(ackError(outcome), undefined);
  assert.ok(clock.monotonic() - start < TIMINGS.commandAnswerBy);
  assert.equal(s.dev.count(CLOSE), 1);
});

test('/data hung: several closes in a row leave, and the checks go on', async (t) => {
  const store = memoryStore();
  const s = await setup(t, { store });
  store.hang = new Promise(() => {});
  s.dev.silent = true;
  for (let i = 0; i < 3; i += 1) await s.press('close');
  assert.ok(s.dev.sends.filter((c) => c === CLOSE).length >= 3, 'each click left');
  s.dev.silent = false;
  await s.advance(40 * SECOND, 100);
  assert.ok(s.dev.count(CLOSE) >= 1, 'the check sent it once the controller answered');
  assert.equal(s.dev.valve, 8);
});

test('/data failing on save: a close is still sent; an open with no close kept is not blocked', async (t) => {
  const store = memoryStore(null, { failSave: true });
  const s = await setup(t, { store, config: ALLOWED });
  assert.equal(ackError(await s.press('close')), undefined);
  await s.advance(15 * SECOND);
  assert.equal(s.dev.valve, 8);
  assert.equal(ackError(await s.press('open')), undefined);
  assert.equal(s.dev.count(OPEN), 1);
});

test('values are applied in the order the requests left, never the order of the answers', async (t) => {
  const s = await setup(t);
  const ctl = s.app.controllers.get(HOST);
  const seq = ctl.valve.seq;
  s.app.applyValve(ctl, 8, seq + 2, s.clock.monotonic());
  s.app.applyValve(ctl, 4, seq + 1, s.clock.monotonic());
  assert.equal(ctl.valve.state, 8);
});

test('an open sent but the valve still closed: "not applied", never a success', async (t) => {
  const { dev, press } = await setup(t, { config: ALLOWED });
  dev.valve = 8;
  dev.forge.set(OPEN, () => {
    for (const timer of dev.moveTimers) dev.timers.clearTimeout(timer);
    dev.valve = 8;
    return { command: OPEN, status: 'ok' };
  });
  assert.match(ackError(await press('open')), /se lit encore fermée/);
});

test('an open sent without an answer: "sent, without confirmation", never "not sent"', async (t) => {
  const { dev, press } = await setup(t, { config: ALLOWED });
  dev.valve = 8;
  dev.dropAnswers.add(OPEN);
  assert.match(ackError(await press('open')), /envoyée, sans confirmation/);
  assert.equal(dev.count(OPEN), 1);
});

test('a close clicked while an open is in flight: the close leaves after it and wins', async (t) => {
  const { dev, send, advance } = await setup(t, { config: ALLOWED });
  dev.valve = 8;
  dev.latencyMs = 300;
  const open = send('open');
  // The fresh read takes 4 x 300 ms: the open leaves at about 1.2 s.
  for (let i = 0; i < 200 && dev.count(OPEN) === 0; i += 1) await advance(10, 10);
  assert.equal(dev.count(OPEN), 1);
  const close = send('close');
  await advance(40 * SECOND, 100);
  await Promise.all([open, close]);
  assert.equal(dev.valve, 8, 'closed in the end');
});

test('the check never resends a close against an open clicked in Gladys', async (t) => {
  const { dev, press, advance, store } = await setup(t, { config: ALLOWED });
  dev.silent = true;
  await press('close');
  dev.silent = false;
  dev.valve = 4;
  dev.refuse.set(CLOSE, 99);
  // The close is refused by the controller (kept); an open from Gladys lets it go.
  await advance(16 * SECOND);
  assert.equal(store.data.stops.length, 1);
  assert.equal(ackError(await press('open')), undefined);
  dev.refuse.delete(CLOSE);
  const closes = dev.count(CLOSE);
  await advance(2 * 60 * SECOND, SECOND);
  assert.equal(dev.count(CLOSE), closes);
});

test('a close kept for an address no longer configured still goes, then is let go', async (t) => {
  const clock = testClock({ start: NOW });
  const net = network({ timers: clock.timers });
  const dev = net.add(fakeGuardian({ timers: clock.timers }));
  const s = await setup(t, { clock, net, dev });
  dev.silent = true;
  await s.press('close');
  s.app.configUpdated({ addresses: '' });
  await s.advance(SECOND);
  dev.silent = false;
  await s.advance(30 * SECOND, 100);
  assert.equal(dev.valve, 8);
  assert.equal(s.store.data.stops.length, 0);
  assert.equal(s.app.controllers.size, 0);
});

test('a read cut by a close is not a failure', async (t) => {
  const { dev, send, advance, gladys, app } = await setup(t, {
    config: { ...CONFIG, refresh_interval: 10 },
  });
  dev.lose.add(COMMANDS.ONBOARD_SENSOR_STATUS);
  await advance(10 * SECOND + 100, 50);
  send('close');
  await settle();
  await advance(4 * SECOND, 50);
  assert.equal(app.controllers.get(HOST).online, true);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.ok(UID);
});

test('the option is checked again right before the datagram of an open', async (t) => {
  const s = await setup(t, { config: ALLOWED });
  s.dev.valve = 8;
  s.dev.latencyMs = 200;
  const ack = s.send('open');
  await s.advance(300, 10);
  // Turned off without a new generation (the check in beforeSend alone stops it).
  s.app.config.allowOpen = false;
  await s.advance(5 * SECOND, 50);
  const result = await ack;
  assert.equal(result.success, false);
  assert.match(result.error, /ouverture est désactivée/);
  assert.equal(s.dev.count(OPEN), 0);
});

test('an open waiting for the line behind a read never leaves after a close clicked meanwhile', async (t) => {
  const s = await setup(t, { config: { ...ALLOWED, refresh_interval: 10 } });
  s.dev.valve = 8;
  // The next read holds the line on a lost request.
  s.dev.lose.add(COMMANDS.VALVE_STATUS);
  await s.advance(10 * SECOND + 50, 50);
  s.dev.lose.delete(COMMANDS.VALVE_STATUS);
  const open = s.send('open');
  await settle();
  const close = s.send('close');
  await s.advance(5 * SECOND, 50);
  const [openAck] = await Promise.all([open, close]);
  assert.equal(openAck.success, false);
  assert.equal(s.dev.count(OPEN), 0);
});

test('opened elsewhere once is not enough: kept until a second read says so', async (t) => {
  const { dev, press, advance, store } = await setup(t, {
    config: { ...CONFIG, refresh_interval: 3600 },
  });
  dev.travelMs = 60 * SECOND;
  await press('close');
  await advance(6 * SECOND);
  assert.equal(store.data.stops[0].seenApplied, true);
  for (const timer of dev.moveTimers) dev.timers.clearTimeout(timer);
  dev.valve = 4;
  await advance(5 * SECOND);
  assert.equal(store.data.stops.length, 1, 'one read alone never lets it go');
  await advance(6 * SECOND);
  assert.equal(store.data.stops.length, 0);
});

test('a close kept that never left: its first datagram is never counted as a resend', async (t) => {
  const clock = testClock({ start: NOW });
  const store = memoryStore({
    controllers: [{ host: HOST, port: 7777, uid: UID, lastAttemptAt: NOW - 1000 }],
    stops: [{ host: HOST, port: 7777, uid: UID, since: NOW - 5000, written: false }],
  });
  const net = network({ timers: clock.timers });
  const dev = net.add(fakeGuardian({ timers: clock.timers }));
  dev.forge.set(CLOSE, () => {
    for (const timer of dev.moveTimers) dev.timers.clearTimeout(timer);
    dev.valve = 4;
    return { command: CLOSE, status: 'ok' };
  });
  const s = await setup(t, { clock, net, dev, store, create: false });
  await s.advance(15 * SECOND, 100);
  assert.equal(dev.count(CLOSE), 4, 'the first send and 3 resends');
  assert.equal(store.data.stops[0].resends, 3);
});

test('an address known to hold another valve never gets the close of an unknown one', async (t) => {
  const clock = testClock({ start: NOW });
  const store = memoryStore({
    controllers: [{ host: HOST, port: 7777, uid: '111122223333', lastAttemptAt: NOW - 1000 }],
  });
  const net = network({ timers: clock.timers });
  const dev = net.add(fakeGuardian({ timers: clock.timers, uid: '111122223333' }));
  dev.silent = true;
  const s = await setup(t, { clock, net, dev, store, create: false });
  const outcome = await s.press('close');
  assert.match(ackError(outcome), /aucune adresse configurée/);
  assert.equal(dev.sends.filter((c) => c === CLOSE).length, 0);
});

test('an identity that cannot be read: not a Guardian, nothing published', async (t) => {
  const clock = testClock({ start: NOW });
  const net = network({ timers: clock.timers });
  const dev = net.add(fakeGuardian({ timers: clock.timers }));
  dev.forge.set(COMMANDS.PING, (a) => ({ ...a, data: {} }));
  const s = await setup(t, { clock, net, dev, create: false });
  assert.equal(s.gladys.fake.discoveredDevices.length, 0);
  assert.equal(s.gladys.fake.states.length, 0);
  assert.match(statusText(s.gladys), /not the one of a Guardian/);
});

test('decideStop: a read that left before the close never judges it', async (t) => {
  const s = await setup(t);
  const guard = s.app.newGuard([UID]);
  guard.written = true;
  guard.sentSeq = 10;
  guard.sentAt = 0;
  assert.equal(s.app.decideStop(guard, { state: 8 }, 9, 1e9), 'stale');
  assert.equal(s.app.decideStop(guard, { state: 8 }, 11, 1e9), 'done');
});

test('a poll read lets a close go when it reads it opened elsewhere a second time', async (t) => {
  const s = await setup(t);
  const ctl = s.app.controllers.get(HOST);
  ctl.guard = s.app.newGuard([UID]);
  Object.assign(ctl.guard, { written: true, sentSeq: 1, sentAt: 0, seenApplied: true });
  s.app.observeStop(ctl, { uid: UID, state: 4 }, 100, 1e9);
  assert.ok(ctl.guard);
  s.app.observeStop(ctl, { uid: UID, state: 4 }, 101, 1e9);
  assert.equal(ctl.guard, undefined);
});
