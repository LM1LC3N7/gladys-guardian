// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys (the real wiring of src/handlers.js),
// the fake controllers of fakeGuardian.js and the virtual clock of the
// testkit: every read of the clock moves it (1 µs), and nothing fires unless
// the test moves it on.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { settle, testClock } from '../kit/index.mjs';
import { GuardianApp } from '../../src/app.js';
import { SECOND } from '../../src/constants.js';
import { registerHandlers } from '../../src/handlers.js';
import { memoryStore } from '../../src/store.js';
import { HOST, NOW, SENSOR, UID, fakeGuardian, network } from './fakeGuardian.js';

export { settle };
export const CONFIG = { addresses: HOST };
export const ALLOWED = { ...CONFIG, allow_valve_open: true };
export const SEL = 'test-integration';
export const VALVE_DEVICE = `ext:${SEL}:guardian:${UID}`;
export const SENSOR_DEVICE = `ext:${SEL}:guardian-sensor:${SENSOR}`;
export const feature = (device, key) => `${device}:${key}`;

export const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

/**
 * `clock`, `net` and `store` may be shared between two lives (a restart).
 * `create`: every device discovered is created in Gladys after the first read.
 */
export async function setup(
  t,
  {
    config = CONFIG,
    clock = testClock({ start: NOW }),
    net,
    dev,
    store = memoryStore(),
    create = true,
    logs = [],
    devices,
    getConfig,
    connect = true,
    boot = true,
  } = {},
) {
  const network_ = net ?? network({ timers: clock.timers });
  const guardian = dev ?? (net ? undefined : network_.add(fakeGuardian({ timers: clock.timers })));
  const gladys = createFakeGladys({ config, ...(devices ? { devices } : {}) });
  if (getConfig) {
    gladys.getConfig = getConfig;
  }
  const app = new GuardianApp({
    gladys,
    logger: recorder(logs),
    exchange: (options) => network_.exchange(options),
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
  });
  registerHandlers(gladys, app);
  // The virtual clock moves on while the app stops (its /data save is bounded on it).
  t.after(async () => {
    const stopping = app.shutdown();
    await clock.advance(3 * SECOND);
    await stopping;
  });
  const advance = async (ms, step = 100) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      await clock.advance(Math.min(step, ms - elapsed));
      await settle();
    }
  };
  if (boot) {
    await app.boot();
  }
  if (connect) {
    await gladys.connect();
    await settle(20);
    await advance(SECOND);
  }
  if (create && !devices) {
    for (const device of gladys.fake.discoveredDevices) {
      await gladys.fake.deviceCreated(device);
    }
    await settle();
  }
  const target = (deviceId, key) => {
    const device = gladys.fake.devices.find((d) => d.external_id === deviceId) ?? {
      external_id: deviceId,
      features: [],
    };
    return [device, { external_id: `${deviceId}:${key}` }];
  };
  const send = (key, value = 1, deviceId = VALVE_DEVICE) =>
    gladys.fake.setValue(...target(deviceId, key), value);
  /** A command, the clock moved on until it answers (5 s at most, as Gladys waits). */
  const press = async (key, value = 1, { deviceId = VALVE_DEVICE, wait = 5 * SECOND } = {}) => {
    const outcome = { done: false };
    const ack = send(key, value, deviceId).then(
      (r) => Object.assign(outcome, { done: true, ok: true, result: r }),
      (e) => Object.assign(outcome, { done: true, ok: false, error: e }),
    );
    await settle();
    for (let elapsed = 0; elapsed < wait && !outcome.done; elapsed += 50) {
      await clock.advance(50);
      await settle();
    }
    await ack;
    return outcome;
  };
  return { gladys, app, dev: guardian, net: network_, store, clock, advance, logs, press, send };
}

/** The message of an ack (the SDK acks a failure with `{ success: false, error }`). */
export const ackError = (outcome) =>
  outcome.ok
    ? outcome.result?.success === false
      ? outcome.result.error
      : undefined
    : outcome.error?.message;

export const last = (gladys, featureId) => gladys.fake.lastState(featureId);
export const status = (gladys) => gladys.fake.connectionStatus;
export const statusText = (gladys) => {
  const s = gladys.fake.connectionStatus;
  return `${s?.message?.en ?? ''}`;
};
