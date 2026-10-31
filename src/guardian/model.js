// -----------------------------------------------------------------------------
// The answers of the controller -> plain readings (pure). Strict: a field of
// the wrong type, out of its range or missing is unknown (undefined), never
// 0 nor false. Shapes from the fixtures of aioguardian 2026.1.1
// (`tests/fixtures/*_success_response.json`).
// -----------------------------------------------------------------------------

import { LIMITS, VALVE_STATES } from '../constants.js';

/** A controller or sensor UID: 4 to 16 letters and digits, upper-cased ("ABCDEF123456"). */
export function normalizeUid(value) {
  return typeof value === 'string' && /^[0-9A-Za-z]{4,16}$/.test(value)
    ? value.toUpperCase()
    : undefined;
}

const dataOf = (answer) =>
  answer && typeof answer.data === 'object' && answer.data !== null && !Array.isArray(answer.data)
    ? answer.data
    : undefined;

const bool = (value) => (typeof value === 'boolean' ? value : undefined);

const intIn = (value, min, max) =>
  Number.isInteger(value) && value >= min && value <= max ? value : undefined;

/** A temperature in °F as the controller gives it (a number, -40 to 150 °F), else undefined. */
const fahrenheit = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= -40 && value <= 150
    ? value
    : undefined;

/** °F -> °C, exact formula, rounded to the hundredth (71 °F -> 21.67 °C). */
export const fToC = (f) => Math.round((((f - 32) * 5) / 9) * 100) / 100 + 0;

/** Command 0: `{ data: { uid } }`. */
export function parsePing(answer) {
  return { uid: normalizeUid(dataOf(answer)?.uid) };
}

/** Command 1: `{ data: { codename, uid, uptime, firmware, ... } }` (secondary). */
export function parseDiagnostics(answer) {
  const data = dataOf(answer) ?? {};
  const text = (value, max) =>
    typeof value === 'string' && /^[\x20-\x7e]{1,64}$/.test(value)
      ? value.slice(0, max)
      : undefined;
  return {
    uid: normalizeUid(data.uid),
    codename: text(data.codename, 16),
    firmware: text(data.firmware, 64),
  };
}

/** Command 16: `{ data: { state: 0..12, ... } }`. */
export function parseValveStatus(answer) {
  const state = dataOf(answer)?.state;
  return { state: Number.isInteger(state) && state in VALVE_STATES ? state : undefined };
}

/** Command 80: `{ data: { temperature (°F), wet } }`. */
export function parseOnboard(answer) {
  const data = dataOf(answer) ?? {};
  return { temperatureF: fahrenheit(data.temperature), wet: bool(data.wet) };
}

/** Command 48: `{ data: { pair_count, paired_uids: [...] } }`, 16 sensors at most. */
export function parsePairDump(answer) {
  const list = dataOf(answer)?.paired_uids;
  if (!Array.isArray(list)) return { uids: undefined };
  const uids = [];
  for (const raw of list.slice(0, 64)) {
    const uid = normalizeUid(raw);
    if (uid && !uids.includes(uid)) uids.push(uid);
  }
  return { uids: uids.slice(0, LIMITS.sensors), cut: uids.length > LIMITS.sensors };
}

/** Command 51: `{ data: { uid, codename, temperature (°F), wet, moved, battery_percentage } }`. */
export function parseSensorStatus(answer) {
  const data = dataOf(answer) ?? {};
  return {
    uid: normalizeUid(data.uid),
    temperatureF: fahrenheit(data.temperature),
    wet: bool(data.wet),
    moved: bool(data.moved),
    battery: intIn(data.battery_percentage, 0, 100),
  };
}
