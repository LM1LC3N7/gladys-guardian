// -----------------------------------------------------------------------------
// The app on the REAL clock, sped up 20 times (30 s of the interval are
// 1.5 s, but it is the real clock: it moves between any two reads of it), over
// real UDP sockets against the fake controller on 127.0.0.1: the reads really
// start at the interval, never sooner, one request at a time, and a close
// goes at once.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { GuardianApp } from '../src/app.js';
import { memoryStore } from '../src/store.js';
import { UID, fakeGuardian, udpServer } from './helpers/fakeGuardian.js';
import { measurePeriod, realClock, spyOn } from './kit/index.mjs';

const SPEED = 20;
const INTERVAL = 30_000;

test('real clock x20, real UDP: a read every interval, one request at a time, a close at once', async () => {
  const clock = realClock({ speed: SPEED });
  const dev = fakeGuardian({ timers: clock.timers });
  dev.latencyMs = 2;
  const server = await udpServer(dev);
  const gladys = createFakeGladys({ config: {} });
  await gladys.connect();
  const quiet = () => {};
  const app = new GuardianApp({
    gladys,
    logger: { debug: quiet, info: quiet, warn: quiet, error: quiet },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: memoryStore(),
  });
  const spy = spyOn(app, 'run', clock);
  try {
    await app.connected({
      addresses: `127.0.0.1:${server.port}`,
      refresh_interval: INTERVAL / 1000,
    });
    const gaps = await measurePeriod(spy, { count: 3, period: INTERVAL });
    assert.equal(gaps.length, 2);
    assert.equal(dev.peak, 1, `${dev.peak} requests at once`);
    assert.equal(gladys.fake.connectionStatus.connected, true);
    const started = clock.monotonic();
    await app.setValue(undefined, {
      external_id: `ext:test-integration:guardian:${UID}:close`,
    });
    assert.ok([5, 6, 7, 8].includes(dev.valve), `valve ${dev.valve}`);
    assert.ok(clock.monotonic() - started < 3_500, 'within the ack budget');
  } finally {
    spy.restore();
    await app.shutdown();
    clock.close();
    await server.close();
  }
  assert.ok(clock.timersSet < 500, `${clock.timersSet} timers`);
});
