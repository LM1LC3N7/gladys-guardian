// -----------------------------------------------------------------------------
// The controllers and their paired sensors -> Gladys devices and their states
// (pure).
//
// External ids (frozen), `<uid>` the UID the device gives (the controller
// answers it to a ping, each paired sensor is listed by it: 12 hex digits in
// the fixtures, kept upper-case), never an IP address:
//   gladys.externalIds('guardian', <uid>)          a valve controller
//   gladys.externalIds('guardian-sensor', <uid>)   a paired leak sensor
// Feature keys (frozen, src/constants.js FEATURES):
//   controller: valve (text), valve-open (read only), close, open (buttons),
//               leak, temperature (its onboard sensor)
//   sensor:     leak, temperature, battery, moved
// Every feature is always built, so a republished device never loses one.
//
// The valve is never a switch nor a commandable binary: a "turn everything
// off/on" (voice assistants, HomeKit, scenes on switches) must never open it.
// Closing and opening are `button/push` features; opening is refused unless
// the configuration allows it (src/app.js).
//
// Temperatures: the controller gives °F; published in °C, converted exactly
// ((F - 32) x 5 / 9, to the hundredth). Categories and units are those the
// core lists (DEVICE_FEATURE_UNITS_BY_CATEGORY).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { EXTERNAL_ID_TYPES, FEATURES, VALVE } from './constants.js';
import { fToC } from './guardian/model.js';
import { FEATURE_NAMES, valveText, word } from './i18n.js';

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const binary = (category) => sensor({ category, type: T.SENSOR.BINARY, min: 0, max: 1 });
const button = {
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};
const temperature = sensor({
  category: C.TEMPERATURE_SENSOR,
  type: T.SENSOR.DECIMAL,
  unit: U.CELSIUS,
  min: -40,
  max: 66,
});

/** The features of each kind of device, in display order. */
export const DEFINITIONS = {
  controller: {
    [FEATURES.VALVE]: sensor({
      category: C.TEXT,
      type: T.TEXT.TEXT,
      min: 0,
      max: 0,
      keep_history: false,
    }),
    [FEATURES.VALVE_OPEN]: binary(C.UNKNOWN),
    [FEATURES.CLOSE]: button,
    [FEATURES.OPEN]: button,
    [FEATURES.LEAK]: binary(C.LEAK_SENSOR),
    [FEATURES.TEMPERATURE]: temperature,
  },
  sensor: {
    [FEATURES.LEAK]: binary(C.LEAK_SENSOR),
    [FEATURES.TEMPERATURE]: temperature,
    [FEATURES.BATTERY]: sensor({
      category: C.BATTERY,
      type: T.BATTERY.INTEGER,
      unit: U.PERCENT,
      min: 0,
      max: 100,
    }),
    [FEATURES.MOVED]: binary(C.TAMPER),
  },
};

/** The commands of a controller: feature key -> what it does. */
export const COMMANDS = { [FEATURES.CLOSE]: 'close', [FEATURES.OPEN]: 'open' };

const KIND_OF = {
  [EXTERNAL_ID_TYPES.CONTROLLER]: 'controller',
  [EXTERNAL_ID_TYPES.SENSOR]: 'sensor',
};

export const controllerIds = (gladys, uid) => gladys.externalIds(EXTERNAL_ID_TYPES.CONTROLLER, uid);
export const sensorIds = (gladys, uid) => gladys.externalIds(EXTERNAL_ID_TYPES.SENSOR, uid);

const ID = /^ext:[^:]{1,100}:(guardian|guardian-sensor):([0-9A-Z]{4,16})(?::([a-z-]{1,20}))?$/;

/** `{ kind, uid, key }` of one of our device or feature external ids, else undefined. */
export function parseExternalId(externalId) {
  if (typeof externalId !== 'string' || externalId.length > 200) return undefined;
  const match = ID.exec(externalId);
  if (!match) return undefined;
  const kind = KIND_OF[match[1]];
  const key = match[3];
  if (key !== undefined && !(key in DEFINITIONS[kind])) return undefined;
  return { kind, uid: match[2], key };
}

const shortUid = (uid) => uid.slice(-4);

function params(entries) {
  return entries
    .filter(([, value]) => typeof value === 'string' && value !== '')
    .map(([name, value]) => ({ name, value }));
}

function build(ids, kind, name, language, extra) {
  return {
    name,
    external_id: ids.device,
    features: Object.entries(DEFINITIONS[kind]).map(([key, definition]) => ({
      name: word(FEATURE_NAMES[kind][key], language),
      external_id: ids.feature(key),
      ...definition,
    })),
    params: params(extra),
  };
}

/** The Gladys device of one controller (`c`: uid, address, diagnostics). */
export function buildControllerDevice(gladys, c, language) {
  return build(
    controllerIds(gladys, c.uid),
    'controller',
    `${word(FEATURE_NAMES.names.controller, language)} ${shortUid(c.uid)}`,
    language,
    [
      ['uid', c.uid],
      ['address', c.addressText],
      ['model', c.diagnostics?.codename],
      ['firmware', c.diagnostics?.firmware],
    ],
  );
}

/** The Gladys device of one paired sensor of the controller `controllerUid`. */
export function buildSensorDevice(gladys, uid, controllerUid, language) {
  return build(
    sensorIds(gladys, uid),
    'sensor',
    `${word(FEATURE_NAMES.names.sensor, language)} ${shortUid(uid)}`,
    language,
    [
      ['uid', uid],
      ['controller', controllerUid],
    ],
  );
}

const bit = (value) => (value === true ? 1 : value === false ? 0 : undefined);

/**
 * The states of a controller read: `[{ device_feature_external_id, state }
 * | { ..., text }]`; what is unknown is left out (never 0).
 */
export function controllerStates(gladys, c, language) {
  const ids = controllerIds(gladys, c.uid);
  const states = [];
  const add = (key, state) => {
    if (state !== undefined && Number.isFinite(state)) {
      states.push({ device_feature_external_id: ids.feature(key), state });
    }
  };
  const valve = c.valve?.state;
  if (valve !== undefined) {
    states.push({
      device_feature_external_id: ids.feature(FEATURES.VALVE),
      text: word(valveText(valve), language),
    });
    // Open or closed only: a moving or faulty valve leaves the last one.
    add(FEATURES.VALVE_OPEN, valve === VALVE.OPENED ? 1 : valve === VALVE.CLOSED ? 0 : undefined);
  }
  add(FEATURES.LEAK, bit(c.onboard?.wet));
  add(
    FEATURES.TEMPERATURE,
    c.onboard?.temperatureF === undefined ? undefined : fToC(c.onboard.temperatureF),
  );
  return states;
}

/** The states of one paired sensor read (`s`: the parseSensorStatus reading). */
export function sensorStates(gladys, s) {
  const ids = sensorIds(gladys, s.uid);
  const states = [];
  const add = (key, state) => {
    if (state !== undefined && Number.isFinite(state)) {
      states.push({ device_feature_external_id: ids.feature(key), state });
    }
  };
  add(FEATURES.LEAK, bit(s.wet));
  add(FEATURES.TEMPERATURE, s.temperatureF === undefined ? undefined : fToC(s.temperatureF));
  add(FEATURES.BATTERY, s.battery);
  add(FEATURES.MOVED, bit(s.moved));
  return states;
}
