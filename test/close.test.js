// -----------------------------------------------------------------------------
// Closing the valve: the stop of this module, never held back.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testClock } from './kit/index.mjs';
import { COMMANDS, SECOND, TIMINGS } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import {
  ALLOWED,
  CONFIG,
  VALVE_DEVICE,
  ackError,
  feature,
  last,
  settle,
  setup,
  statusText,
} from './helpers/app.js';
import { HOST, NOW, UID, fakeGuardian, network } from './helpers/fakeGuardian.js';

const CLOSE = COMMANDS.VALVE_CLOSE;

test('close: sent at once, confirmed by the read back, let go once closed', async (t) => {
  const { dev, press, advance, store, gladys, clock } = await setup(t);
  const start = clock.monotonic();
  const outcome = await press('close');
  assert.equal(ackError(outcome), undefined);
  assert.ok(clock.monotonic() - start < TIMINGS.commandAnswerBy, 'answered within 3.5 s');
  assert.equal(dev.count(CLOSE), 1);
  assert.equal(store.data.stops.length, 1, 'kept in /data until seen closed');
  await advance(15 * SECOND);
  assert.equal(dev.valve, 8);
  assert.equal(store.data.stops.length, 0);
  assert.equal(last(gladys, feature(VALVE_DEVICE, 'valve')), 'fermée');
  assert.equal(last(gladys, feature(VALVE_DEVICE, 'valve-open')), 0);
  assert.equal(dev.count(CLOSE), 1, 'never sent again once applied');
});

test('close of a closed valve: "already closed" is a success', async (t) => {
  const { dev, press, store } = await setup(t);
  dev.valve = 8;
  const outcome = await press('close');
  assert.equal(ackError(outcome), undefined);
  assert.equal(store.data.stops.length, 0);
});

test('close: whatever the value, without the option, during a stuck read', async (t) => {
  const { dev, send, advance, clock, app } = await setup(t, {
    config: { ...CONFIG, refresh_interval: 10 },
  });
  assert.equal(app.config.allowOpen, false);
  // The next read gets stuck on the valve status (lost requests).
  dev.lose.add(COMMANDS.VALVE_STATUS);
  await advance(10 * SECOND + 50, 50);
  assert.ok(app.controllers.get(HOST).lane.holder, 'a read holds the line');
  dev.lose.delete(COMMANDS.VALVE_STATUS);
  const start = clock.monotonic();
  const ack = send('close', 0);
  await settle();
  await advance(200, 10);
  assert.equal(dev.count(CLOSE), 1, 'the read was cut, the close left');
  assert.ok(clock.monotonic() - start < 300);
  await advance(4 * SECOND, 50);
  await ack;
});

test('close with /data hung: still leaves at once, and checks go on', async (t) => {
  const store = memoryStore();
  const s = await setup(t, { store });
  store.hang = new Promise(() => {});
  const outcome = await s.press('close');
  assert.equal(ackError(outcome), undefined);
  assert.equal(s.dev.count(CLOSE), 1);
  // A second close later, with the disk still hung: it leaves too.
  s.dev.valve = 4;
  const again = await s.press('close');
  assert.equal(ackError(again), undefined);
  assert.equal(s.dev.count(CLOSE), 2);
});

test('close of a controller that does not answer: kept, sent when it answers, never given up', async (t) => {
  const clock = testClock({ start: NOW });
  const net = network({ timers: clock.timers });
  const dev = net.add(fakeGuardian({ timers: clock.timers }));
  const s = await setup(t, { clock, net, dev });
  dev.silent = true;
  const outcome = await s.press('close');
  assert.match(ackError(outcome), /sans réponse|pas encore/);
  assert.equal(s.store.data.stops.length, 1);
  assert.equal(s.store.data.stops[0].resends, 0, 'a silence is not a try');
  // Silent for 10 minutes: never given up.
  await s.advance(10 * 60 * SECOND, SECOND);
  assert.equal(s.store.data.stops.length, 1);
  assert.match(statusText(s.gladys), /Close at 192.168.1.50/);
  dev.silent = false;
  await s.advance(30 * SECOND, 100);
  assert.equal(dev.valve, 8);
  assert.equal(s.store.data.stops.length, 0);
});

test('close of a valve that is opening: "moving" is retried, never a try counted', async (t) => {
  const { dev, press, advance, store } = await setup(t);
  dev.valve = 8;
  dev.openElsewhere();
  const outcome = await press('close');
  // The valve moves for 6 s: refused with "moving" during the 3 s of the click.
  assert.match(ackError(outcome), /bouge et refuse toute commande/);
  assert.ok(dev.requests.filter((r) => r.command === CLOSE).length >= 5);
  assert.equal(store.data.stops[0].resends, 0);
  await advance(30 * SECOND, 100);
  assert.equal(dev.valve, 8, 'closed once the opening ended');
  assert.equal(store.data.stops.length, 0);
});

test('a restart sends the close kept in /data at once, without the configuration', async (t) => {
  const clock = testClock({ start: NOW });
  const store = memoryStore({
    controllers: [{ host: HOST, port: 7777, uid: UID, lastAttemptAt: NOW - 1000 }],
    stops: [{ host: HOST, port: 7777, uid: UID, since: NOW - 5000, written: false }],
  });
  const net = network({ timers: clock.timers });
  const dev = net.add(fakeGuardian({ timers: clock.timers }));
  const s = await setup(t, {
    clock,
    net,
    dev,
    store,
    connect: false,
    create: false,
  });
  await s.advance(500, 10);
  assert.equal(dev.count(CLOSE), 1, 'sent before Gladys gave the configuration');
  assert.equal(dev.count(COMMANDS.PING), 0, 'no read before it');
  await s.advance(20 * SECOND, 100);
  assert.equal(store.data.stops.length, 0);
});

test('a click before the configuration goes to the address /data knows', async (t) => {
  const clock = testClock({ start: NOW });
  const store = memoryStore({
    controllers: [{ host: HOST, port: 7777, uid: UID, lastAttemptAt: NOW - 1000 }],
  });
  const net = network({ timers: clock.timers });
  const dev = net.add(fakeGuardian({ timers: clock.timers }));
  const s = await setup(t, {
    clock,
    net,
    dev,
    store,
    connect: false,
    create: false,
    getConfig: () => new Promise(() => {}),
  });
  const outcome = await s.press('close');
  assert.equal(ackError(outcome), undefined);
  assert.equal(dev.count(CLOSE), 1);
});

test('owner unknown: a close goes to every configured address never identified', async (t) => {
  const clock = testClock({ start: NOW });
  const net = network({ timers: clock.timers });
  const dev = net.add(fakeGuardian({ timers: clock.timers }));
  dev.silent = true;
  const s = await setup(t, { clock, net, dev, create: false });
  const outcome = await s.press('close');
  assert.match(ackError(outcome), /sans réponse|pas encore|non envoy/);
  assert.equal(s.store.data.stops.length, 1);
  assert.equal(dev.requests.length, 0);
  dev.silent = false;
  await s.advance(20 * SECOND, 100);
  assert.equal(dev.count(CLOSE), 1);
});

test('a close goes nowhere only when every known address holds another valve', async (t) => {
  const { press } = await setup(t);
  const outcome = await press('close', 1, {
    deviceId: 'ext:test-integration:guardian:FFFF00001111',
  });
  assert.match(ackError(outcome), /aucune adresse configurée/);
});

test('a close accepted but never applied: 3 quick resends, then spaced ones forever, said', async (t) => {
  const { dev, press, advance, store, gladys } = await setup(t);
  // The controller answers "ok" but its valve never moves.
  const stuck = () => {
    for (const timer of dev.moveTimers) dev.timers.clearTimeout(timer);
    dev.valve = 4;
    return { command: CLOSE, status: 'ok' };
  };
  dev.forge.set(CLOSE, stuck);
  await press('close');
  await advance(15 * SECOND, 100);
  assert.equal(dev.count(CLOSE), 4, 'the click and 3 quick resends');
  assert.equal(store.data.stops[0].resends, 3);
  assert.match(
    statusText(gladys),
    /held, accepted 4 times but the valve does not close; sent again in/,
  );
  // Held: sent again after 30 s, 60 s, 120 s... never given up, never let go by time.
  await advance(60 * SECOND, 100);
  assert.equal(dev.count(CLOSE), 5);
  await advance(60 * SECOND, 100);
  assert.equal(dev.count(CLOSE), 6);
  await advance(60 * 60 * SECOND, SECOND);
  const hourly = dev.count(CLOSE);
  assert.ok(hourly >= 10 && hourly <= 14, `${hourly} closes in an hour (10 min apart at most)`);
  assert.equal(store.data.stops.length, 1, 'kept, never let go by time');
  // Repaired: the next spaced close closes it.
  dev.forge.delete(CLOSE);
  await advance(11 * 60 * SECOND, SECOND);
  assert.equal(dev.valve, 8);
  assert.equal(store.data.stops.length, 0);
});

test('a close held gets new quick resends when the valve changes or the controller comes back', async (t) => {
  const { dev, press, advance, store } = await setup(t);
  let stuckState = 4;
  const stuck = () => {
    for (const timer of dev.moveTimers) dev.timers.clearTimeout(timer);
    dev.valve = stuckState;
    return { command: CLOSE, status: 'ok' };
  };
  dev.forge.set(CLOSE, stuck);
  await press('close');
  await advance(15 * SECOND, 100);
  assert.equal(dev.count(CLOSE), 4);
  // The valve moves to a fault (read by the next check): a new budget.
  stuckState = 10;
  dev.valve = 10;
  await advance(16 * SECOND, 100);
  assert.ok(dev.count(CLOSE) >= 5, 'sent again at once after the change');
  await advance(10 * SECOND, 100);
  const afterChange = dev.count(CLOSE);
  assert.ok(afterChange >= 6, `${afterChange}`);
  await advance(2 * 60 * SECOND, SECOND);
  // The controller reboots (silent), comes back open: a new budget again.
  dev.silent = true;
  await advance(40 * SECOND, SECOND);
  const beforeBack = dev.count(CLOSE);
  dev.silent = false;
  dev.valve = 4;
  dev.forge.delete(CLOSE);
  await advance(20 * SECOND, 100);
  assert.ok(dev.count(CLOSE) > beforeBack);
  assert.equal(dev.valve, 8);
  assert.equal(store.data.stops.length, 0);
});

test('opened elsewhere after it closed: let go after two reads in a row, never resent', async (t) => {
  const { dev, press, advance, store } = await setup(t, {
    config: { ...CONFIG, refresh_interval: 10 },
  });
  dev.travelMs = 60 * SECOND;
  await press('close');
  await advance(6 * SECOND);
  assert.equal(store.data.stops[0].seenApplied, true);
  // The app opens it while it closes (the controller does not refuse that one here).
  for (const timer of dev.moveTimers) dev.timers.clearTimeout(timer);
  dev.valve = 4;
  await advance(30 * SECOND);
  assert.equal(dev.count(CLOSE), 1, 'never closed again against a newer open');
  assert.equal(store.data.stops.length, 0);
});

test('an open clicked before a close never leaves after it', async (t) => {
  const { dev, send, advance, gladys } = await setup(t, { config: ALLOWED });
  dev.valve = 8;
  dev.latencyMs = 200;
  const open = send('open');
  await settle();
  await advance(50, 10);
  const close = send('close');
  await advance(5 * SECOND, 50);
  const [openAck, closeAck] = await Promise.all([open, close]);
  assert.equal(openAck.success, false);
  assert.match(openAck.error, /fermeture a été demandée/);
  assert.equal(closeAck.success, true);
  assert.equal(dev.count(COMMANDS.VALVE_OPEN), 0);
  assert.ok(gladys);
});

test('a scene closing 5 slow controllers: all 5 closed; one silent does not stop the others', async (t) => {
  const clock = testClock({ start: NOW });
  const net = network({ timers: clock.timers });
  const hosts = [50, 51, 52, 53, 54].map((n) => `192.168.1.${n}`);
  const devs = hosts.map((host, i) => {
    const d = net.add(
      fakeGuardian({ timers: clock.timers, uid: `C0FFEE00000${i}`, sensors: [] }),
      host,
    );
    d.latencyMs = 700;
    return d;
  });
  const s = await setup(t, { clock, net, dev: devs[0], config: { addresses: hosts.join(',') } });
  await s.advance(10 * SECOND);
  devs[4].silent = true;
  const acks = devs.map((d) => s.send('close', 1, `ext:test-integration:guardian:${d.uid}`));
  await s.advance(5 * SECOND, 50);
  const results = await Promise.all(acks);
  assert.deepEqual(
    results.map((r) => r.success),
    [true, true, true, true, false],
  );
  for (const d of devs.slice(0, 4)) assert.equal(d.count(CLOSE), 1);
});
