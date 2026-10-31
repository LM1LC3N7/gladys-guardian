// -----------------------------------------------------------------------------
// The app end to end: reads, devices, states, statuses, restarts.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testClock } from './kit/index.mjs';
import { SECOND, TIMINGS } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import {
  ALLOWED,
  CONFIG,
  SENSOR_DEVICE,
  VALVE_DEVICE,
  feature,
  last,
  settle,
  setup,
  status,
  statusText,
} from './helpers/app.js';
import { HOST, NOW, SENSOR, UID, fakeGuardian, network } from './helpers/fakeGuardian.js';

test('a first read: the devices, their states (°F converted exactly), the status', async (t) => {
  const { gladys, dev } = await setup(t);
  const devices = gladys.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((d) => d.external_id),
    [VALVE_DEVICE, SENSOR_DEVICE],
  );
  const valve = devices[0];
  assert.deepEqual(
    valve.features.map((f) => f.external_id.split(':').pop()),
    ['valve', 'valve-open', 'close', 'open', 'leak', 'temperature'],
  );
  assert.ok(valve.params.some((p) => p.name === 'address' && p.value === HOST));
  assert.equal(last(gladys, feature(VALVE_DEVICE, 'valve')), 'ouverte');
  assert.equal(last(gladys, feature(VALVE_DEVICE, 'valve-open')), 1);
  assert.equal(last(gladys, feature(VALVE_DEVICE, 'leak')), 0);
  // 71 °F = 21.666... °C
  assert.equal(last(gladys, feature(VALVE_DEVICE, 'temperature')), 21.67);
  assert.equal(last(gladys, feature(SENSOR_DEVICE, 'temperature')), 20);
  assert.equal(last(gladys, feature(SENSOR_DEVICE, 'battery')), 79);
  assert.equal(last(gladys, feature(SENSOR_DEVICE, 'moved')), 1);
  assert.equal(last(gladys, feature(SENSOR_DEVICE, 'leak')), 0);
  assert.equal(status(gladys).connected, true);
  assert.match(
    statusText(gladys),
    new RegExp(`Guardian ${UID} \\(${HOST}\\): valve open, 1 paired`),
  );
  assert.match(statusText(gladys), /Opening the valve from Gladys is off/);
  // Ping first: the identity before any value.
  assert.deepEqual(
    dev.requests.slice(0, 2).map((r) => r.command),
    [0, 16],
  );
  assert.equal(dev.peak, 1, 'one request at a time');
});

test('reads every interval, never sooner; a restart waits for the interval kept in /data', async (t) => {
  const clock = testClock({ start: NOW });
  const store = memoryStore();
  const first = await setup(t, { clock, store, config: { ...CONFIG, refresh_interval: 60 } });
  const pings = () => first.dev.count(0);
  assert.equal(pings(), 1);
  await first.advance(58 * SECOND, SECOND);
  assert.equal(pings(), 1);
  await first.advance(3 * SECOND, SECOND);
  assert.equal(pings(), 2);
  // The test button: never sooner than the interval.
  const answer = await first.gladys.fake.action('test_connection');
  assert.equal(pings(), 2);
  assert.match(JSON.stringify(answer), /prochaine lecture/);
  await first.app.shutdown();
  // A restart 10 s later: the next read waits for the rest of the interval.
  await clock.advance(10 * SECOND);
  const net = network({ timers: clock.timers });
  const dev = net.add(fakeGuardian({ timers: clock.timers }));
  const second = await setup(t, { clock, store, net, config: { ...CONFIG, refresh_interval: 60 } });
  assert.equal(dev.count(0), 0, 'not read at once after a restart');
  await second.advance(60 * SECOND, SECOND);
  assert.equal(dev.count(0) >= 1, true);
});

test('a controller off: offline, nothing published as 0, never "connected"', async (t) => {
  const clock = testClock({ start: NOW });
  const net = network({ timers: clock.timers });
  const dev = net.add(fakeGuardian({ timers: clock.timers }));
  dev.silent = true;
  const { gladys } = await setup(t, { clock, net, dev, create: false });
  await clock.advance(4 * SECOND);
  await settle(20);
  assert.equal(gladys.fake.discoveredDevices.length, 0);
  assert.equal(gladys.fake.states.length, 0);
  assert.equal(status(gladys).connected, false);
  assert.match(statusText(gladys), /no answer \(timeout\)/);
});

test('a secondary part that fails never holds the valve back', async (t) => {
  const clock = testClock({ start: NOW });
  const net = network({ timers: clock.timers });
  const dev = net.add(fakeGuardian({ timers: clock.timers }));
  dev.lose.add(80);
  dev.lose.add(51);
  const { gladys, advance } = await setup(t, { clock, net, dev });
  await advance(10 * SECOND);
  assert.equal(last(gladys, feature(VALVE_DEVICE, 'valve')), 'ouverte');
  assert.equal(last(gladys, feature(VALVE_DEVICE, 'temperature')), undefined);
  assert.equal(last(gladys, feature(SENSOR_DEVICE, 'battery')), undefined);
  assert.equal(status(gladys).connected, true);
  assert.match(statusText(gladys), /Not read: onboard sensor, sensor 6309FB799CDE/);
});

test('getConfig() failing in `connected`: tried again every 30 s, then the reads start', async (t) => {
  let calls = 0;
  const holder = {};
  const getConfig = async () => {
    calls += 1;
    // The 1st call is the fake's own connect(); the 2nd is the app's, failing.
    if (calls === 2) throw new Error('Gladys busy');
    return holder.gladys.fake.config ?? CONFIG;
  };
  const clock = testClock({ start: NOW });
  const net = network({ timers: clock.timers });
  const dev = net.add(fakeGuardian({ timers: clock.timers }));
  const s = await setup(t, { clock, net, dev, getConfig, create: false, connect: false });
  holder.gladys = s.gladys;
  await s.gladys.connect();
  await settle(20);
  assert.equal(calls, 2);
  assert.match(statusText(s.gladys), /configuration cannot be read/);
  assert.equal(dev.count(0), 0);
  await s.advance(TIMINGS.configRetry + SECOND, SECOND);
  assert.equal(calls, 3);
  assert.ok(dev.count(0) >= 1);
  assert.equal(status(s.gladys).connected, true);
});

test('another controller at the address: another device, the old one gets nothing', async (t) => {
  const { gladys, dev, advance } = await setup(t, { config: { ...CONFIG, refresh_interval: 10 } });
  const before = gladys.fake.states.length;
  dev.uid = '112233445566';
  await advance(11 * SECOND);
  const old = gladys.fake.states
    .slice(before)
    .filter((s) => s.device_feature_external_id.startsWith(VALVE_DEVICE));
  assert.equal(old.length, 0);
  assert.ok(gladys.fake.discoveredDevices.some((d) => d.external_id.endsWith(':112233445566')));
  assert.match(statusText(gladys), /answered ABCDEF123456 before and 112233445566 now/);
});

test('nothing stale at `connected`: values older than 2 min are not sent again', async (t) => {
  const { gladys, dev, advance, app } = await setup(t, {
    config: { ...CONFIG, refresh_interval: 600 },
  });
  dev.silent = true;
  await advance(3 * 60 * SECOND, SECOND);
  const before = gladys.fake.states.length;
  await app.connected(CONFIG);
  await settle(10);
  await advance(2 * SECOND);
  assert.equal(gladys.fake.states.length, before);
});

test('configurations saved in a row apply one by one, the last one wins', async (t) => {
  const clock = testClock({ start: NOW });
  const net = network({ timers: clock.timers });
  const a = net.add(fakeGuardian({ timers: clock.timers }));
  const b = net.add(fakeGuardian({ timers: clock.timers, uid: 'BBBBBB000002' }), '192.168.1.51');
  const s = await setup(t, { clock, net, dev: a });
  s.app.configUpdated({ addresses: '192.168.1.51' });
  s.app.configUpdated({ addresses: '192.168.1.50 192.168.1.51', allow_valve_open: true });
  await s.advance(2 * SECOND);
  assert.deepEqual(
    s.app.configured().map((c) => c.addressText),
    ['192.168.1.50', '192.168.1.51'],
  );
  assert.equal(s.app.config.allowOpen, true);
  assert.ok(b.count(0) >= 1);
  assert.equal(ALLOWED.allow_valve_open, true);
});

test('a sensor no longer paired: its values are not published any more', async (t) => {
  const { gladys, dev, advance } = await setup(t, { config: { ...CONFIG, refresh_interval: 10 } });
  dev.sensors.delete(SENSOR);
  const before = gladys.fake.states.length;
  await advance(11 * SECOND);
  assert.equal(
    gladys.fake.states
      .slice(before)
      .filter((s) => s.device_feature_external_id.startsWith(SENSOR_DEVICE)).length,
    0,
  );
});
