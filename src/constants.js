// -----------------------------------------------------------------------------
// Protocol, keys, timings and limits.
//
// The local API of a Guardian valve controller (Elexa), as aioguardian
// 2026.1.1 (MIT, bachya) speaks it: one JSON datagram to UDP port 7777,
// `{ "command": <code>, "silent": true, ...params }`, answered by one JSON
// datagram echoing `command` with `status` "ok" or "error" (+ `error_code`).
// No authentication: anyone on the LAN can send these commands.
// -----------------------------------------------------------------------------

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const DEFAULT_PORT = 7777;

/** The command codes used here (aioguardian `helpers/command.py`). */
export const COMMANDS = {
  PING: 0,
  DIAGNOSTICS: 1,
  VALVE_STATUS: 16,
  VALVE_OPEN: 17,
  VALVE_CLOSE: 18,
  SENSOR_PAIR_DUMP: 48,
  SENSOR_STATUS: 51,
  ONBOARD_SENSOR_STATUS: 80,
};

/** The `error_code` values aioguardian names (`errors.py`). */
export const DEVICE_ERRORS = {
  SENSOR_NOT_PAIRED: 3,
  SENSOR_ERROR_LOADING: 5,
  ALREADY_OPEN: 17,
  ALREADY_CLOSED: 18,
  ALREADY_STOPPED: 19,
  MOVING: 20,
};

/** The valve states (aioguardian `commands/valve.py` VALVE_STATE_MAPPING). */
export const VALVE_STATES = {
  0: 'default',
  1: 'start_opening',
  2: 'opening',
  3: 'finish_opening',
  4: 'opened',
  5: 'start_closing',
  6: 'closing',
  7: 'finish_closing',
  8: 'closed',
  9: 'start_halt',
  10: 'stalled',
  11: 'free_spin',
  12: 'halted',
};

/** The groups the decisions use. */
export const VALVE = {
  OPENED: 4,
  CLOSED: 8,
  isOpening: (s) => s === 1 || s === 2 || s === 3,
  isClosing: (s) => s === 5 || s === 6 || s === 7,
  isMoving: (s) => (s >= 1 && s <= 3) || (s >= 5 && s <= 7) || s === 9,
};

/** The external id types (frozen: they key the devices of the users). */
export const EXTERNAL_ID_TYPES = {
  CONTROLLER: 'guardian',
  SENSOR: 'guardian-sensor',
};

/** The feature keys (frozen). */
export const FEATURES = {
  VALVE: 'valve',
  VALVE_OPEN: 'valve-open',
  CLOSE: 'close',
  OPEN: 'open',
  LEAK: 'leak',
  TEMPERATURE: 'temperature',
  BATTERY: 'battery',
  MOVED: 'moved',
};

/** A button pushed in Gladys (`button/push`) sends 1. */
export const PRESSED = 1;

/** Keys of the configuration screen buttons. */
export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The interval between two reads of a controller, in seconds. */
export const POLL_INTERVAL = { default: 30, min: 10, max: 3600 };

export const LIMITS = {
  /** Addresses in the configuration. */
  controllers: 8,
  /** Paired sensors read per controller (the dump is cut beyond). */
  sensors: 16,
  /** Bytes of one answer datagram (the largest seen is about 400). */
  datagram: 4096,
  /** Addresses kept in /data, and stops. */
  keptControllers: 16,
  /** Gladys accepts 300 states a minute; 100 per request. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** Bytes of /data/guardian-state.json. */
  stateFile: 64 * 1024,
};

export const TIMINGS = {
  /** One read request: answer within this, else tried once more. */
  readTimeout: 1500,
  readTries: 2,
  /** A request of a command (fresh read, open): at least this much time left. */
  commandMinRequest: 300,
  /** A command clicked is answered to Gladys by then (Gladys gives up at 5 s). */
  commandAnswerBy: 3500,
  /** An open is never sent later than this after its click (a read back must still fit). */
  commandSendBy: 2700,
  /** The wait before the read back of a command: the valve starts moving. */
  applyWait: 400,
  /** A close: one try lasts this long at most (a slow controller answers in 900 ms), the next one 250 ms later, for 3 s. */
  stopTry: 1200,
  stopRetry: 250,
  stopRetryFor: 3000,
  /** A read sent this long after a close may judge it (the motor started). */
  stopApplyDelay: 2 * SECOND,
  /** The check of a close kept: every 15 s; 5 s while the valve closes. */
  stopCheck: 15 * SECOND,
  stopWatch: 5 * SECOND,
  /** A close sent again this many times (each accepted) without effect is held: */
  stopResends: 3,
  /** then sent again every 30 s, doubling to 10 min, forever (a new budget on a change). */
  heldResendFirst: 30 * SECOND,
  heldResendMax: 10 * MINUTE,
  /** /data: a save waits this long at most; on the path of a close, much less. */
  saveWait: 2 * SECOND,
  stopSaveWait: 200,
  /** /data: the time of the last read is written at most once a minute. */
  attemptWriteEvery: MINUTE,
  /** `getConfig()` failed: tried again this much later, forever. */
  configRetry: 30 * SECOND,
  /** Reads after a command: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A value read longer ago than this is never sent as current. */
  freshFor: 2 * MINUTE,
  /** The list of the paired sensors, and the diagnostics, are read this often. */
  pairDumpEvery: 10 * MINUTE,
  diagnosticsEvery: 6 * HOUR,
  /** A secondary read that failed is tried again this much later at the earliest. */
  secondaryRetry: 5 * MINUTE,
  /** Publications to Gladys: flushed every second, unchanged values every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** The "Test the connection" button reads at most this often. */
  testEvery: 10 * SECOND,
  /** The identity of an address is probed (a close went astray) at most this often. */
  probeEvery: 5 * SECOND,
  /** A close watched for a valve still closing this long is said in the status. */
  closingLong: 2 * MINUTE,
};
