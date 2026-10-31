// -----------------------------------------------------------------------------
// The pure parts: configuration, answers of the controller, devices, the
// options rule of the core, the persisted state.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { normalizeConfig, parseAddress, parseAddresses } from '../src/config.js';
import {
  DEFINITIONS,
  buildControllerDevice,
  buildSensorDevice,
  controllerStates,
  parseExternalId,
  sensorStates,
} from '../src/devices.js';
import {
  fToC,
  normalizeUid,
  parseDiagnostics,
  parseOnboard,
  parsePairDump,
  parsePing,
  parseSensorStatus,
  parseValveStatus,
} from '../src/guardian/model.js';
import { normalizeMemory } from '../src/store.js';
import { valveText } from '../src/i18n.js';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

test('addresses: IPv4, host names, ports; never broadcast, multicast, any, URLs nor credentials', () => {
  assert.deepEqual(parseAddress('192.168.1.50'), { host: '192.168.1.50', port: 7777 });
  assert.deepEqual(parseAddress(' Guardian.LAN:7778 '), { host: 'guardian.lan', port: 7778 });
  for (const bad of [
    '255.255.255.255',
    '0.0.0.0',
    '224.0.0.1',
    '239.255.255.250',
    '192.168.1',
    '192.168.1.50:0',
    '192.168.1.50:70000',
    'http://192.168.1.50',
    'user:pw@host',
    '[::1]',
    'a b',
    'host\r\nx',
    '-bad.lan',
  ]) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
  const list = parseAddresses('192.168.1.50, 192.168.1.50;bad..host 192.168.1.51');
  assert.deepEqual(
    list.addresses.map((a) => a.host),
    ['192.168.1.50', '192.168.1.51'],
  );
  assert.deepEqual(list.invalid, [3]);
  const many = parseAddresses(Array.from({ length: 10 }, (_, i) => `10.0.0.${i + 1}`).join(','));
  assert.equal(many.addresses.length, 8);
  assert.equal(many.tooMany, true);
});

test('configuration: opening only on true, the interval bounded', () => {
  assert.equal(normalizeConfig({}).allowOpen, false);
  assert.equal(normalizeConfig({ allow_valve_open: 'yes' }).allowOpen, false);
  assert.equal(normalizeConfig({ allow_valve_open: 1 }).allowOpen, false);
  assert.equal(normalizeConfig({ allow_valve_open: 'true' }).allowOpen, true);
  assert.equal(normalizeConfig({ refresh_interval: 1 }).interval, 10_000);
  assert.equal(normalizeConfig({ refresh_interval: 99999 }).interval, 3_600_000);
  assert.equal(normalizeConfig({ refresh_interval: '' }).interval, 30_000);
  assert.equal(normalizeConfig({ refresh_interval: 'abc' }).interval, 30_000);
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
});

test('answers: the fixtures of aioguardian, strictly', () => {
  assert.equal(parsePing(fixture('ping')).uid, 'ABCDEF123456');
  assert.equal(parsePing({ data: { uid: 'AB' } }).uid, undefined);
  assert.equal(parsePing({ data: { uid: 'ABCDEF12345\n' } }).uid, undefined);
  assert.equal(parseValveStatus(fixture('valve_status')).state, 0);
  assert.equal(parseValveStatus({ data: { state: 13 } }).state, undefined);
  assert.equal(parseValveStatus({ data: { state: '8' } }).state, undefined);
  assert.equal(parseValveStatus({ data: { state: 8.5 } }).state, undefined);
  assert.deepEqual(parseOnboard(fixture('onboard_sensor_status')), {
    temperatureF: 71,
    wet: false,
  });
  // Text, null, out of range: unknown, never 0 nor false.
  assert.deepEqual(parseOnboard({ data: { temperature: '71', wet: 'false' } }), {
    temperatureF: undefined,
    wet: undefined,
  });
  assert.equal(parseOnboard({ data: { temperature: 400 } }).temperatureF, undefined);
  assert.equal(parseOnboard({ data: { temperature: null } }).temperatureF, undefined);
  assert.deepEqual(parsePairDump(fixture('pair_dump')).uids, ['6309FB799CDE']);
  const many = Array.from({ length: 20 }, (_, i) => `AAAAAAAA${String(i).padStart(4, '0')}`);
  assert.equal(parsePairDump({ data: { paired_uids: many } }).uids.length, 16);
  assert.equal(parsePairDump({ data: { paired_uids: many } }).cut, true);
  assert.equal(parsePairDump({ data: {} }).uids, undefined);
  assert.deepEqual(parseSensorStatus(fixture('paired_sensor_status')), {
    uid: '6309FB799CDE',
    temperatureF: 68,
    wet: false,
    moved: true,
    battery: 79,
  });
  assert.equal(parseSensorStatus({ data: { battery_percentage: 101 } }).battery, undefined);
  assert.equal(parseSensorStatus({ data: { battery_percentage: 50.5 } }).battery, undefined);
  assert.deepEqual(parseDiagnostics(fixture('diagnostics')), {
    uid: 'ABCDEF123456',
    codename: 'gvc1',
    firmware: '0.20.9-beta+official.ef3',
  });
  assert.equal(normalizeUid('abcdef123456'), 'ABCDEF123456');
  for (const bad of ['', 'abc', '../x', 'AB:CD', 'A'.repeat(17), 12345678]) {
    assert.equal(normalizeUid(bad), undefined, String(bad));
  }
});

test('°F to °C: exact formula, to the hundredth', () => {
  assert.equal(fToC(32), 0);
  assert.equal(fToC(212), 100);
  assert.equal(fToC(71), 21.67);
  assert.equal(fToC(68), 20);
  assert.equal(fToC(-40), -40);
  assert.equal(fToC(150), 65.56);
  assert.ok(Object.is(fToC(32), 0), 'never -0');
});

const gladys = createFakeGladys({ selector: 'test-integration' });

// The units the core lists for the categories used here (server/utils/constants.js
// DEVICE_FEATURE_UNITS_BY_CATEGORY), checked against the core itself when it is at hand.
const CORE_CONSTANTS = '/home/claude/code/Gladys/server/utils/constants.js';
const UNITS = existsSync(CORE_CONSTANTS)
  ? createRequire(import.meta.url)(CORE_CONSTANTS).DEVICE_FEATURE_UNITS_BY_CATEGORY
  : { 'temperature-sensor': ['celsius', 'fahrenheit', 'kelvin'], battery: ['percent'] };

test('devices: frozen ids, features, units of the core, no switch nor writable binary', () => {
  const valve = buildControllerDevice(
    gladys,
    { uid: 'ABCDEF123456', addressText: '192.168.1.50' },
    'en',
  );
  assert.equal(valve.external_id, 'ext:test-integration:guardian:ABCDEF123456');
  assert.equal(valve.name, 'Guardian valve 3456');
  const sensor = buildSensorDevice(gladys, '6309FB799CDE', 'ABCDEF123456', 'fr');
  assert.equal(sensor.external_id, 'ext:test-integration:guardian-sensor:6309FB799CDE');
  for (const device of [valve, sensor]) {
    for (const f of device.features) {
      assert.notEqual(f.category, 'switch', f.external_id);
      if (f.type === 'binary') assert.equal(f.read_only, true, f.external_id);
      if (f.unit) {
        assert.ok(UNITS[f.category]?.includes(f.unit), f.external_id);
      }
      assert.equal(f.supported_options, undefined);
    }
  }
  const writable = valve.features.filter((f) => !f.read_only).map((f) => [f.category, f.type]);
  assert.deepEqual(writable, [
    ['button', 'push'],
    ['button', 'push'],
  ]);
  assert.deepEqual(parseExternalId('ext:test-integration:guardian:ABCDEF123456:close'), {
    kind: 'controller',
    uid: 'ABCDEF123456',
    key: 'close',
  });
  for (const bad of [
    'ext:test-integration:guardian:ABCDEF123456:nope',
    'ext:test-integration:guardian:abcdef123456:close',
    'ext:a:b:guardian:ABCDEF123456:close',
    'guardian:ABCDEF123456:close',
    undefined,
  ]) {
    assert.equal(parseExternalId(bad), undefined, String(bad));
  }
  assert.equal(Object.keys(DEFINITIONS.controller).length, 6);
});

test('states: a text is never a measure 0; unknown values left out', () => {
  const states = controllerStates(gladys, { uid: 'ABCDEF123456', valve: { state: 6 } }, 'en');
  assert.deepEqual(states, [
    {
      device_feature_external_id: 'ext:test-integration:guardian:ABCDEF123456:valve',
      text: 'closing',
    },
  ]);
  const closed = controllerStates(
    gladys,
    { uid: 'ABCDEF123456', valve: { state: 8 }, onboard: { wet: true, temperatureF: 50 } },
    'fr',
  );
  assert.deepEqual(
    closed.map((s) => s.state ?? s.text),
    ['fermée', 0, 1, 10],
  );
  assert.deepEqual(sensorStates(gladys, { uid: '6309FB799CDE' }), []);
  assert.equal(valveText(undefined).en, 'not read');
  assert.equal(valveText(12).fr, 'arrêtée à mi-course');
});

// The core's rules of supported_options (server/utils/normalizeSupportedOptions.js):
// one error rejects the whole Discovery list. This module publishes none; the
// rule is applied to every feature all the same, so a later option is checked.
const CORE_NORMALIZE = '/home/claude/code/Gladys/server/utils/normalizeSupportedOptions.js';
const coreNormalize = existsSync(CORE_NORMALIZE)
  ? createRequire(import.meta.url)(CORE_NORMALIZE).normalizeSupportedOptions
  : undefined;

test('supported_options: the rules of the core on every published feature', () => {
  const devices = [
    buildControllerDevice(gladys, { uid: 'ABCDEF123456', addressText: 'x' }, 'fr'),
    buildSensorDevice(gladys, '6309FB799CDE', 'ABCDEF123456', 'en'),
  ];
  let lists = 0;
  for (const f of devices.flatMap((d) => d.features)) {
    if (f.supported_options === undefined) continue;
    lists += 1;
    const values = f.supported_options.map((o) => String(o.value));
    assert.equal(new Set(values).size, values.length);
    for (const o of f.supported_options) {
      assert.equal(typeof o.label, 'string');
      assert.equal(o.label, o.label.trim());
      assert.ok(o.label.length > 0);
    }
    if (coreNormalize) assert.doesNotThrow(() => coreNormalize(f.supported_options, {}));
  }
  assert.equal(lists, 0, 'no option published');
});

test('/data: repaired, bounded; a close never written has no try counted; future dates are now', () => {
  const now = Date.UTC(2026, 9, 31);
  const memory = normalizeMemory(
    {
      controllers: [
        { host: '192.168.1.50', port: 7777, uid: 'abcdef123456', lastAttemptAt: now + 1e9 },
        { host: 'BAD HOST', port: 7777 },
      ],
      stops: [
        {
          host: '192.168.1.50',
          port: 7777,
          uid: 'x',
          since: now + 5000,
          written: false,
          resends: 3,
        },
        { host: '192.168.1.50', port: 7777, written: true },
        { host: '192.168.1.51', port: 7777, written: true, resends: 'two', seenApplied: true },
      ],
    },
    now,
  );
  assert.deepEqual(memory.controllers, [
    { host: '192.168.1.50', port: 7777, uid: 'ABCDEF123456', lastAttemptAt: now },
  ]);
  assert.deepEqual(memory.stops, [
    {
      host: '192.168.1.50',
      port: 7777,
      uid: null,
      since: now,
      written: false,
      resends: 0,
      seenApplied: false,
    },
    {
      host: '192.168.1.51',
      port: 7777,
      uid: null,
      since: now,
      written: true,
      resends: 0,
      seenApplied: true,
    },
  ]);
  assert.deepEqual(normalizeMemory('garbage', now), { version: 1, controllers: [], stops: [] });
});
