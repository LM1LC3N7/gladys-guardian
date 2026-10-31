// -----------------------------------------------------------------------------
// The integration: the Guardian valve controllers typed in the configuration
// (one to eight addresses), one read of each every interval, their Gladys
// devices (each controller and its paired leak sensors) and states, the
// transport badge, the button of the configuration screen, the open of a
// valve (only when the configuration allows it) and its close (never held
// back). index.js only wires the SDK handlers to it.
//
// The local API has no authentication (anyone on the LAN can command the
// valve: the docs say so). Each controller has its own line (src/lane.js):
// one request at a time, each its own UDP socket (src/guardian/udp.js).
//
// Identity: the UID the controller answers to a ping (command 0), read first
// in every read and before any open; the values go to the devices of that
// UID. Another UID at an address is another device (never merged); an
// unreadable UID is "unknown", never another device. The UID last read at
// each address is kept in /data, for the closes clicked while the controller
// does not answer or before the configuration is read.
//
// Reads (each controller on its own timer):
//   - never sooner than the interval after the last one: not for the test
//     button, a Discovery scan, a reconnection to Gladys, a configuration
//     saved unchanged, nor a restart (the time of the last read is kept in
//     /data, written at most once a minute, BEFORE the read); only the reads
//     that follow a command (5 s, 20 s);
//   - the ping and the valve status are the core; the onboard sensor, the
//     list of the paired sensors (every 10 min), each paired sensor and the
//     diagnostics (every 6 h) are secondary: one that fails never holds the
//     others back;
//   - every request is numbered when it leaves: a value is applied only when
//     its request left after the one of the value it replaces (order of
//     departure, never of answer); values older than 2 minutes are never
//     sent as new.
//
// Opening a valve (lets water in):
//   - refused unless "Allow opening the valve" is on, checked on arrival and
//     again right before the datagram (in `beforeSend`, nothing in between);
//   - refused while a close of that controller is on its way (a close clicked
//     later ends it: an open that arrived before a close never leaves after it);
//   - decided on a fresh read (identity, valve state, onboard leak sensor,
//     each paired sensor that answers), never on the state in memory: refused
//     when the identity is another, the valve moves or is in a fault, a leak
//     is read, or the onboard sensor cannot be read;
//   - a close kept for that valve is let go by an open that left (in /data
//     before the datagram: an open whose save fails sends nothing); an open
//     refused by the valve, or that never left, keeps it;
//   - the datagram leaves by 2.7 s after the click or not at all; answered by
//     3.5 s; confirmed only by a read back showing the valve opening or open.
//
// Closing a valve is the stop of this module and is never held back: not by
// the option (there is none), a read or a command in progress (it ends
// them), a failed read, a controller never read in this run, the
// configuration not read yet (/data gives the address), /data hung (its
// saves are bounded to 200 ms on this path and never awaited after). It goes
// to the address where that valve was read (in this run, else in /data);
// when no address is known to hold it, to every configured address whose
// controller was never identified (the address the user typed). Refused
// unsent only when every known address holds another valve, or no address is
// known at all. Tried every 250 ms for 3 s; not seen applied, it is kept in
// /data and checked every 15 s (5 s while the valve closes): sent again
// while the valve stays open or in a fault (3 times at most once the valve
// accepted it, then held and said in the status), let go when a read shows
// it closed, when an open clicked in Gladys left, when two reads in a row
// show the valve opened elsewhere after it was seen closing, or when a read
// shows another controller at the address. Never by time; a try only counts
// when the valve accepted the datagram.
//
// Clocks: `monotonic` paces everything in memory (reads, retries, waits,
// deadlines); the wall clock only dates what /data keeps for the next process.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig } from './config.js';
import { COMMANDS as CMD, DEVICE_ERRORS, PRESSED, SECOND, TIMINGS, VALVE } from './constants.js';
import {
  COMMANDS,
  buildControllerDevice,
  buildSensorDevice,
  controllerIds,
  controllerStates,
  parseExternalId,
  sensorIds,
  sensorStates,
} from './devices.js';
import {
  parseDiagnostics,
  parseOnboard,
  parsePairDump,
  parsePing,
  parseSensorStatus,
  parseValveStatus,
} from './guardian/model.js';
import { ERROR_KINDS, GuardianError, answered, errorReason, udpExchange } from './guardian/udp.js';
import { ERRORS, T, age, join, lines, valveText, word } from './i18n.js';
import { Lane } from './lane.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory, sameAddress } from './store.js';

const freshController = (address, configured) => ({
  address: { host: address.host, port: address.port },
  addressText: addressKey(address),
  configured,
  lane: new Lane(),
  /** The UID read in this session (reset by a failed read); undefined: unknown. */
  uid: undefined,
  /** The UID of the readings kept (a different UID read resets them). */
  readingsUid: undefined,
  /** The UID last read at this address (this run or /data). */
  keptUid: null,
  /** Another UID than the one kept was read here (said in the status). */
  replaced: undefined,
  online: undefined,
  error: undefined,
  readAt: -Infinity,
  valve: undefined,
  onboard: undefined,
  sensors: new Map(),
  pairedUids: undefined,
  pairCut: false,
  pairAt: -Infinity,
  pairRetryAt: -Infinity,
  diagnostics: undefined,
  diagAt: -Infinity,
  diagRetryAt: -Infinity,
  secondaryFailed: new Set(),
  timer: undefined,
  running: undefined,
  lastAttemptAt: -Infinity,
  attemptSavedAt: -Infinity,
  followUps: new Set(),
  /** Numbers the requests in their order of departure. */
  seq: 0,
  /** Counts the closes: an open that arrived before the current count never leaves. */
  protectSeq: 0,
  stopJobs: [],
  stopWorker: undefined,
  /** The close kept (not seen applied), or undefined. */
  guard: undefined,
  checkTimer: undefined,
  checkDueAt: Infinity,
  checking: false,
  opening: false,
  /** The last read or check of this controller had no answer (cleared by the next answer). */
  silent: false,
  lastTestAt: -Infinity,
});

export class GuardianApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'guardian' }),
    exchange = udpExchange,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.exchange = exchange;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.publisher = new StatePublisher({ gladys, logger, now: monotonic, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null, now());
    this.memoryUnreadable = false;
    this.memoryReady = false;
    this.memoryLoaded = undefined;
    /** addressKey -> controller (configured, or kept for a close). */
    this.controllers = new Map();
    /** uid -> the close of a valve found at no address yet (another valve answered). */
    this.lost = new Map();
    /** The write of /data in flight, and the next one (one waiting at most). */
    this.writing = undefined;
    this.nextWrite = undefined;
    this.generation = 0;
    this.started = false;
    this.configRead = false;
    this.configFailed = false;
    this.configSeq = 0;
    this.savedRaw = undefined;
    this.configChain = Promise.resolve();
    this.configTimer = undefined;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.stopped = false;
  }

  mono() {
    return this.monotonic();
  }

  /** Waits `ms`; ends at once when `signal` aborts. */
  sleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const done = () => {
        this.timers.clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = this.timers.setTimeout(done, Math.max(0, ms));
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  /** `promise` raced against `ms`: `{ done: true, value }` or `{ done: false }`. */
  async bounded(promise, ms) {
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve({ done: false }), Math.max(0, ms));
    });
    try {
      return await Promise.race([
        promise.then(
          (value) => ({ done: true, value }),
          () => ({ done: true, value: undefined }),
        ),
        late,
      ]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  get interval() {
    return this.config.interval;
  }

  // --- /data -------------------------------------------------------------------

  /** Loads /data once; the closes kept there go at once (no configuration needed). */
  loadMemory() {
    if (!this.memoryLoaded) {
      this.memoryLoaded = (async () => {
        let result;
        try {
          result = await this.store.load();
        } catch {
          result = { unreadable: true };
        }
        const now = this.now();
        if (result?.unreadable) {
          this.memoryUnreadable = true;
          this.logger.warn('Guardian: /data/guardian-state.json cannot be read: never overwritten');
          this.memoryReady = true;
          return;
        }
        this.memory = normalizeMemory(result?.data ?? null, now);
        this.memoryReady = true;
        for (const kept of this.memory.controllers) {
          const ctl = this.controllerAt(kept, { create: true });
          if (!ctl.keptUid) ctl.keptUid = kept.uid;
        }
        for (const kept of this.memory.stops) {
          const ctl = this.controllerAt(kept, { create: true });
          const known = ctl.guard?.uids ?? [];
          // A restart gives a close kept a new budget of resends.
          ctl.guard = this.newGuard([...known, ...kept.uids], ctl.guard);
          ctl.guard.since = kept.since;
          ctl.guard.written = kept.written;
          ctl.guard.seenApplied = kept.seenApplied;
          this.logger.warn(`Guardian: close kept in /data for ${ctl.addressText}: checked now`);
          this.armStopCheck(ctl, 0);
        }
        for (const kept of this.memory.lost) {
          if (!this.lost.has(kept.uid))
            this.lost.set(kept.uid, { uid: kept.uid, since: kept.since });
        }
        // A close clicked while /data loaded is kept with the others now.
        if ([...this.controllers.values()].some((c) => c.guard) || this.lost.size > 0) {
          this.persist().catch(() => {});
        }
      })();
    }
    return this.memoryLoaded;
  }

  /**
   * One write of /data in flight at most, and one waiting (it takes the
   * memory of the moment it starts): a hung disk never piles writes up.
   */
  writeLatest() {
    if (this.writing) {
      this.nextWrite ??= this.writing.then(() => {
        this.nextWrite = undefined;
        return this.writeLatest();
      });
      return this.nextWrite;
    }
    this.writing = this.store
      .save(this.memory)
      .then(
        () => true,
        (err) => {
          this.logger.warn(`Guardian: saving the state to /data failed: ${err.message}`);
          return false;
        },
      )
      .finally(() => {
        this.writing = undefined;
      });
    return this.writing;
  }

  async saveMemory(wait = TIMINGS.saveWait) {
    // Unreadable: never overwritten. Not loaded yet: never overwritten with a guess.
    if (this.memoryUnreadable || !this.memoryReady) {
      return false;
    }
    const saved = await this.bounded(this.writeLatest(), wait);
    if (!saved.done) {
      this.logger.warn('Guardian: saving the state to /data takes too long: not awaited');
      return false;
    }
    return saved.value === true;
  }

  /** The memory to write: the addresses (UID, last read) and the closes kept. */
  snapshot({ without } = {}) {
    const controllers = this.memory.controllers.filter((k) => !this.controllers.has(addressKey(k)));
    for (const ctl of this.controllers.values()) {
      const old = this.memory.controllers.find((k) => sameAddress(k, ctl.address));
      if (!ctl.keptUid && !old && ctl.lastAttemptAt === -Infinity) continue;
      controllers.push({
        ...ctl.address,
        uid: ctl.keptUid ?? null,
        lastAttemptAt:
          ctl.lastAttemptAt === -Infinity
            ? (old?.lastAttemptAt ?? null)
            : this.now() - (this.mono() - ctl.lastAttemptAt),
      });
    }
    const stops = [];
    for (const ctl of this.controllers.values()) {
      const g = ctl.guard;
      // `without`: the guard an open lets go, out of /data before its datagram.
      if (!g || g === without) continue;
      stops.push({
        ...ctl.address,
        uids: [...g.uids],
        since: g.since,
        written: g.written,
        resends: g.resends,
        seenApplied: g.seenApplied,
      });
    }
    const lost = [...this.lost.values()].map(({ uid, since }) => ({ uid, since }));
    return normalizeMemory({ controllers, stops, lost }, this.now());
  }

  /** Writes /data (bounded: `wait`); resolves whether it was written. */
  persist(wait = TIMINGS.saveWait, options = {}) {
    if (this.memoryUnreadable || !this.memoryReady) {
      return Promise.resolve(false);
    }
    this.memory = this.snapshot(options);
    return this.saveMemory(wait);
  }

  /**
   * At the start of the container, before the configuration is read: the
   * closes kept in /data are sent again at once (the address is there).
   */
  async boot() {
    await this.bounded(this.loadMemory(), TIMINGS.saveWait);
  }

  // --- Controllers -------------------------------------------------------------

  controllerAt(address, { create = false, configured = false } = {}) {
    const key = addressKey(address);
    let ctl = this.controllers.get(key);
    if (!ctl && create) {
      ctl = freshController(address, configured);
      this.controllers.set(key, ctl);
    }
    return ctl;
  }

  configured() {
    return [...this.controllers.values()].filter((c) => c.configured);
  }

  // --- Lifecycle -----------------------------------------------------------------

  /** The container stops: every timer, and /data written (2 s at most). */
  async shutdown() {
    this.stopped = true;
    this.generation += 1;
    if (this.configTimer) this.timers.clearTimeout(this.configTimer);
    for (const ctl of this.controllers.values()) {
      this.stopController(ctl);
      if (ctl.checkTimer) this.timers.clearTimeout(ctl.checkTimer);
      ctl.checkTimer = undefined;
      // Whatever holds a line ends now (each request is bounded anyway).
      ctl.lane.holder?.controller.abort();
    }
    this.publisher.stop();
    await this.bounded(this.persist(2 * SECOND), 2 * SECOND);
  }

  stopController(ctl) {
    if (ctl.timer) this.timers.clearTimeout(ctl.timer);
    ctl.timer = undefined;
    for (const handle of ctl.followUps) this.timers.clearTimeout(handle);
    ctl.followUps.clear();
    if (ctl.lane.holder?.kind === 'read') ctl.lane.holder.controller.abort();
  }

  /**
   * Connected to Gladys: reads the configuration, tried again every 30 s
   * while it fails (with a status), forever, then `connected`.
   */
  async onConnected(getConfig) {
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    const seq = this.configSeq;
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      this.logger.warn(`Guardian: reading the configuration failed: ${err.message}`);
      // The next try armed first: nothing below may hold it back.
      if (this.stopped) return;
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.onConnected(getConfig).catch(() => {});
      }, TIMINGS.configRetry);
      this.configFailed = true;
      await this.bounded(this.loadMemory(), TIMINGS.saveWait);
      this.lastStatus = undefined;
      await this.updateStatus();
      return;
    }
    this.configFailed = false;
    // A configuration saved after this request left wins over its answer.
    await this.inOrder(() => this.connected(seq !== this.configSeq ? this.savedRaw : raw));
  }

  /** Configurations (read or saved) applied one at a time, in their order of arrival. */
  inOrder(fn) {
    const run = this.configChain.then(fn);
    this.configChain = run.catch(() => {});
    return run;
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection, resend
   * what Gladys keeps in memory only (status, Discovery list, badge, fresh
   * values), without reading the controllers sooner than their interval.
   */
  async connected(raw = {}) {
    if (this.stopped) return;
    this.configRead = true;
    if (!this.started) {
      this.started = true;
      this.publisher.start();
      await this.applyConfig(raw);
      return;
    }
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.gladys.forgetPublishedStates?.();
    await this.applyConfig(raw);
  }

  /** The configuration saved by the user: applied in order, the last one wins. */
  configUpdated(raw = {}) {
    this.configSeq += 1;
    this.savedRaw = raw;
    const seq = this.configSeq;
    return this.inOrder(async () => {
      // A newer configuration is waiting: this one is skipped.
      if (seq !== this.configSeq) return;
      this.configRead = true;
      if (this.stopped) return;
      if (!this.started) {
        this.started = true;
        this.publisher.start();
      }
      await this.applyConfig(raw);
    });
  }

  async applyConfig(raw) {
    this.config = normalizeConfig(raw);
    this.generation += 1;
    await this.bounded(this.loadMemory(), TIMINGS.saveWait);
    const wanted = new Set(this.config.addresses.map(addressKey));
    for (const [key, ctl] of [...this.controllers]) {
      if (wanted.has(key)) continue;
      // An address no longer typed: its reads stop; it stays only for its close kept.
      this.stopController(ctl);
      ctl.configured = false;
      ctl.online = undefined;
      if (!ctl.guard && ctl.stopJobs.length === 0 && !ctl.stopWorker) {
        this.controllers.delete(key);
      }
    }
    for (const address of this.config.addresses) {
      const ctl = this.controllerAt(address, { create: true, configured: true });
      ctl.configured = true;
      if (ctl.guard) this.armStopCheck(ctl, 0);
      // The timers of the previous configuration are dead (its generation):
      // armed again, never sooner than the interval after the last read.
      this.schedule(ctl, this.firstWait(ctl));
    }
    // The closes of valves found nowhere try the addresses of this configuration.
    this.retryLost();
    await this.publishAll();
  }

  /** The wait before the next read of a controller, from its last read (memory or /data). */
  firstWait(ctl) {
    if (ctl.lastAttemptAt !== -Infinity) {
      return this.dueIn(ctl);
    }
    if (this.memoryUnreadable) {
      return this.interval;
    }
    const stored = this.memory.controllers.find((k) => sameAddress(k, ctl.address))?.lastAttemptAt;
    if (stored === null || stored === undefined) {
      return 0;
    }
    // A read may have left up to a minute after the time kept (written at most once a minute).
    const due = stored + TIMINGS.attemptWriteEvery + this.interval;
    return Math.min(this.interval, Math.max(0, due - this.now()));
  }

  dueIn(ctl, mono = this.mono()) {
    return Math.max(0, ctl.lastAttemptAt + this.interval - mono);
  }

  schedule(ctl, delay = this.interval) {
    if (ctl.timer) this.timers.clearTimeout(ctl.timer);
    ctl.timer = undefined;
    // Stopped: never a timer armed again (it would keep the process alive).
    if (this.stopped) return;
    const generation = this.generation;
    ctl.timer = this.timers.setTimeout(
      () => {
        ctl.timer = undefined;
        if (generation === this.generation && ctl.configured && !this.stopped) {
          this.tick(ctl).catch((err) => this.logger.error(`Guardian read failed: ${err.message}`));
        }
      },
      Math.max(0, delay),
    );
  }

  /** One read at a time per controller: a tick during a read joins it. */
  tick(ctl) {
    if (!ctl.running) {
      ctl.running = this.run(ctl).finally(() => {
        ctl.running = undefined;
      });
    }
    return ctl.running;
  }

  /** The time of this read, in memory and (at most once a minute) in /data, BEFORE it. */
  async noteAttempt(ctl) {
    const mono = this.mono();
    ctl.lastAttemptAt = mono;
    if (mono - ctl.attemptSavedAt >= TIMINGS.attemptWriteEvery) {
      ctl.attemptSavedAt = mono;
      // Bounded: a hung disk never holds a read.
      await this.persist(TIMINGS.stopSaveWait);
    }
  }

  async run(ctl) {
    const generation = this.generation;
    // The next read armed first (never sooner than the interval).
    this.schedule(ctl, this.interval);
    await this.noteAttempt(ctl);
    try {
      await this.readAll(ctl, generation);
    } catch (err) {
      if (generation !== this.generation || !ctl.configured) return;
      if (err?.kind === ERROR_KINDS.ABORTED) {
        // The line was taken (a close): not a failure.
        this.logger.debug(`Guardian: read of ${ctl.addressText} ended by a close`);
      } else {
        this.failed(ctl, err);
      }
    }
    if (generation !== this.generation) return;
    await this.publishAll();
  }

  /**
   * One request on the line of `ctl`, numbered when it leaves. `tries`: a
   * request without answer is sent once more (UDP loses datagrams).
   */
  async request(ctl, holder, command, { params, timeoutMs, tries = 1, beforeSend } = {}) {
    for (let attempt = 1; ; attempt += 1) {
      let seq;
      try {
        const answer = await this.exchange({
          host: ctl.address.host,
          port: ctl.address.port,
          command,
          params,
          timeoutMs,
          signal: holder.signal,
          timers: this.timers,
          beforeSend: () => {
            beforeSend?.();
            ctl.seq += 1;
            seq = ctl.seq;
          },
        });
        return { answer, seq };
      } catch (err) {
        if (err instanceof GuardianError && seq !== undefined) err.seq = seq;
        if (err?.kind === ERROR_KINDS.TIMEOUT && attempt < tries && !holder.signal.aborted) {
          continue;
        }
        throw err;
      }
    }
  }

  /** One read request, on a turn of its own (a close or a command may pass between two). */
  async read(ctl, generation, command, params) {
    const holder = await ctl.lane.acquire('read');
    try {
      if (generation !== this.generation || !ctl.configured) {
        throw new GuardianError(ERROR_KINDS.ABORTED, 'Configuration changed');
      }
      const startedAt = this.mono();
      const { answer, seq } = await this.request(ctl, holder, command, {
        params,
        timeoutMs: TIMINGS.readTimeout,
        tries: TIMINGS.readTries,
      });
      return { answer, seq, startedAt };
    } finally {
      holder.release();
    }
  }

  /** The identity read at an address: readings of another UID are dropped. */
  identify(ctl, uid) {
    if (ctl.readingsUid !== uid) {
      if (ctl.readingsUid !== undefined) {
        this.logger.warn(`Guardian: another controller answers at ${ctl.addressText}`);
      }
      ctl.valve = undefined;
      ctl.onboard = undefined;
      ctl.sensors = new Map();
      ctl.pairedUids = undefined;
      ctl.pairAt = -Infinity;
      ctl.diagnostics = undefined;
      ctl.diagAt = -Infinity;
      ctl.readingsUid = uid;
    }
    ctl.uid = uid;
    if (ctl.keptUid !== uid) {
      if (ctl.keptUid) ctl.replaced = { before: ctl.keptUid, now: uid };
      ctl.keptUid = uid;
      this.persist(TIMINGS.stopSaveWait).catch(() => {});
    }
    // The closes searched for this valve come here; a close kept here for
    // another valve goes on where that valve is.
    this.foundValve(ctl, uid);
  }

  /** Applies a valve state read by a request numbered `seq` (departure order). */
  applyValve(ctl, state, seq, startedAt) {
    if (state === undefined) return;
    if (ctl.valve && ctl.valve.seq > seq) return;
    ctl.valve = { state, seq, at: startedAt };
  }

  /**
   * The ping and the valve status (the core), then the secondary parts due:
   * the onboard sensor, the paired sensors, the diagnostics.
   */
  async readAll(ctl, generation) {
    const get = (command, params) => this.read(ctl, generation, command, params);
    const ping = await get(CMD.PING);
    const { uid } = parsePing(ping.answer);
    if (!uid) {
      throw new GuardianError(ERROR_KINDS.PROTOCOL, 'Identity unreadable');
    }
    this.identify(ctl, uid);
    const status = await get(CMD.VALVE_STATUS);
    const { state } = parseValveStatus(status.answer);
    if (state === undefined) {
      throw new GuardianError(ERROR_KINDS.PROTOCOL, 'Valve state unreadable');
    }
    this.applyValve(ctl, state, status.seq, status.startedAt);
    ctl.online = true;
    ctl.error = undefined;
    ctl.readAt = ping.startedAt;
    this.answered(ctl);
    this.observeStop(ctl, { uid, state }, status.seq, status.startedAt);
    // The valve at once: the secondary parts may take a while.
    await this.publishAll();
    const secondary = async (name, fn) => {
      try {
        await fn();
        ctl.secondaryFailed.delete(name);
      } catch (err) {
        if (err?.kind === ERROR_KINDS.ABORTED) throw err;
        ctl.secondaryFailed.add(name);
        this.logger.debug(`Guardian: ${name} of ${ctl.addressText} not read (${errorReason(err)})`);
        return err;
      }
      return undefined;
    };
    await secondary('onboard', async () => {
      const r = await get(CMD.ONBOARD_SENSOR_STATUS);
      const onboard = parseOnboard(r.answer);
      if (ctl.onboard && ctl.onboard.seq > r.seq) return;
      ctl.onboard = { ...onboard, seq: r.seq, at: r.startedAt };
    });
    const mono = this.mono();
    if (
      (ctl.pairedUids === undefined || mono - ctl.pairAt >= TIMINGS.pairDumpEvery) &&
      mono >= ctl.pairRetryAt
    ) {
      const failure = await secondary('sensors', async () => {
        const r = await get(CMD.SENSOR_PAIR_DUMP);
        const dump = parsePairDump(r.answer);
        if (!dump.uids) throw new GuardianError(ERROR_KINDS.PROTOCOL, 'Pair dump unreadable');
        ctl.pairedUids = dump.uids;
        ctl.pairCut = dump.cut;
        ctl.pairAt = mono;
        for (const known of [...ctl.sensors.keys()]) {
          if (!dump.uids.includes(known)) ctl.sensors.delete(known);
        }
      });
      if (failure) ctl.pairRetryAt = mono + TIMINGS.secondaryRetry;
    }
    for (const sensorUid of ctl.pairedUids ?? []) {
      await secondary(`sensor ${sensorUid}`, async () => {
        let r;
        try {
          r = await get(CMD.SENSOR_STATUS, { uid: sensorUid });
        } catch (err) {
          if (err?.kind === ERROR_KINDS.DEVICE) {
            // Not paired any more, or not loaded: no value (never the old ones).
            ctl.sensors.delete(sensorUid);
          }
          throw err;
        }
        const reading = parseSensorStatus(r.answer);
        // An answer for another sensor is not this one's.
        if (reading.uid !== undefined && reading.uid !== sensorUid) {
          throw new GuardianError(ERROR_KINDS.PROTOCOL, 'Answer of another sensor');
        }
        const old = ctl.sensors.get(sensorUid);
        if (old && old.seq > r.seq) return;
        ctl.sensors.set(sensorUid, { ...reading, uid: sensorUid, seq: r.seq, at: r.startedAt });
      });
    }
    if (mono - ctl.diagAt >= TIMINGS.diagnosticsEvery && mono >= ctl.diagRetryAt) {
      const failure = await secondary('diagnostics', async () => {
        const r = await get(CMD.DIAGNOSTICS);
        const d = parseDiagnostics(r.answer);
        if (d.uid && d.uid !== uid) {
          throw new GuardianError(ERROR_KINDS.PROTOCOL, 'Diagnostics of another controller');
        }
        ctl.diagnostics = d;
        ctl.diagAt = mono;
      });
      if (failure) ctl.diagRetryAt = mono + TIMINGS.secondaryRetry;
    }
  }

  /** A failed read: offline, its session identity unknown until the next ping. */
  failed(ctl, err) {
    ctl.online = false;
    ctl.silent = true;
    ctl.uid = undefined;
    ctl.error = errorReason(err);
    this.logger.warn(`Guardian: ${ctl.addressText} not read (${ctl.error})`);
  }

  // --- Status ------------------------------------------------------------------

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** The line of one close kept. */
  stopLine(ctl) {
    const g = ctl.guard;
    const where = `${ctl.addressText} (${[...g.uids].join(', ')})`;
    if (ctl.stopJobs.length > 0 || ctl.stopWorker) return T.stopSending(where);
    if (!g.written) return T.stopNotSent(where, g.failure ?? 'waiting');
    if (g.held) {
      return T.stopHeld(where, g.accepted, age(Math.max(0, g.nextHeldAt - this.mono())));
    }
    if (g.refused) return T.stopRefused(where, g.refused);
    if (g.closingSince !== undefined && this.mono() - g.closingSince >= TIMINGS.closingLong) {
      return T.stopClosingLong(where);
    }
    if (g.contraReads > 0) return T.stopOpenedElsewhere(where);
    if (g.seenApplied) return T.stopClosing(where);
    return T.stopUnconfirmed(where);
  }

  /** `[connected, message]` of the configuration screen. */
  status() {
    const notes = [];
    if (this.memoryUnreadable) notes.push(T.dataUnreadable);
    else if (!this.memoryReady && this.memoryLoaded) notes.push(T.dataLoading);
    for (const ctl of this.controllers.values()) {
      if (ctl.guard) notes.push(this.stopLine(ctl));
    }
    for (const l of this.lost.values()) {
      notes.push(T.stopLost(l.uid, l.where, l.other));
    }
    if (this.configFailed) {
      return [false, lines(T.configUnreadable, ...notes)];
    }
    if (!this.configRead) {
      return [false, lines(T.waitingConfig, ...notes)];
    }
    if (this.config.invalid.length > 0) notes.unshift(T.invalidEntries(this.config.invalid));
    if (this.config.tooMany) notes.unshift(T.tooMany);
    const list = this.configured();
    if (list.length === 0) {
      return [false, lines(T.noAddress, ...notes)];
    }
    const parts = [];
    let online = 0;
    for (const ctl of list) {
      if (ctl.online === true && ctl.uid) {
        online += 1;
        const leaks = [
          ...(ctl.onboard?.wet === true ? [ctl.uid] : []),
          ...[...ctl.sensors.values()].filter((s) => s.wet === true).map((s) => s.uid),
        ];
        parts.push(
          T.controllerLine({
            uid: ctl.uid,
            where: ctl.addressText,
            valve: valveText(ctl.valve?.state),
            sensors: ctl.pairedUids?.length ?? 0,
            leaks,
            failed: [...ctl.secondaryFailed],
          }),
        );
        if (ctl.pairCut) parts.push(T.sensorsCut);
        if (ctl.replaced)
          parts.push(T.replaced(ctl.addressText, ctl.replaced.before, ctl.replaced.now));
      } else if (ctl.online === false) {
        parts.push(
          ctl.error === 'protocol'
            ? T.notGuardian(ctl.addressText)
            : T.unreachable(ctl.addressText, ctl.error ?? 'error'),
        );
      } else {
        parts.push(T.connecting(ctl.addressText));
      }
    }
    if (!this.config.allowOpen) notes.push(T.openDisabled);
    const message = lines(...parts, ...notes);
    // Connected only when every controller typed answers.
    return [online === list.length, message];
  }

  async updateStatus() {
    const [connected, message] = this.status();
    await this.setStatus(connected, message);
  }

  // --- Gladys ------------------------------------------------------------------

  fresh(at, mono = this.mono()) {
    return at !== undefined && mono - at <= TIMINGS.freshFor;
  }

  async publishAll() {
    await this.publishDevices();
    this.queueStates();
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /** The Discovery list: every controller read in this run and its paired sensors. */
  buildDevices() {
    const devices = [];
    const language = this.config.language;
    for (const ctl of this.configured()) {
      if (!ctl.readingsUid || ctl.readAt === -Infinity) continue;
      devices.push(
        buildControllerDevice(
          this.gladys,
          { uid: ctl.readingsUid, addressText: ctl.addressText, diagnostics: ctl.diagnostics },
          language,
        ),
      );
      for (const uid of ctl.pairedUids ?? []) {
        devices.push(buildSensorDevice(this.gladys, uid, ctl.readingsUid, language));
      }
    }
    return devices;
  }

  async publishDevices() {
    const devices = this.buildDevices();
    if (devices.length === 0) return;
    const json = JSON.stringify(devices);
    if (json === this.published) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  /** The states to send: values of this session's reads, fresh only, for created features. */
  queueStates(created = this.createdFeatures()) {
    const mono = this.mono();
    const push = (states) => {
      for (const { device_feature_external_id: id, ...value } of states) {
        if (created.has(id)) this.publisher.push(id, value);
      }
    };
    for (const ctl of this.configured()) {
      if (ctl.online !== true || !ctl.uid || ctl.uid !== ctl.readingsUid) continue;
      push(
        controllerStates(
          this.gladys,
          {
            uid: ctl.uid,
            valve: this.fresh(ctl.valve?.at, mono) ? ctl.valve : undefined,
            onboard: this.fresh(ctl.onboard?.at, mono) ? ctl.onboard : undefined,
          },
          this.config.language,
        ),
      );
      for (const s of ctl.sensors.values()) {
        if (this.fresh(s.at, mono)) push(sensorStates(this.gladys, s));
      }
    }
  }

  async publishBadge() {
    const entries = [];
    const mono = this.mono();
    for (const device of this.gladys.devices ?? []) {
      const parsed = parseExternalId(device?.external_id);
      if (!parsed || parsed.key !== undefined) continue;
      let reachable = false;
      for (const ctl of this.configured()) {
        if (ctl.online !== true || !ctl.uid) continue;
        if (parsed.kind === 'controller' && parsed.uid === ctl.uid) reachable = true;
        if (parsed.kind === 'sensor' && this.fresh(ctl.sensors.get(parsed.uid)?.at, mono)) {
          reachable = true;
        }
      }
      entries.push({
        external_id: device.external_id,
        transport: reachable ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge) return;
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): its last values at once, if fresh. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) created.add(f.external_id);
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the devices of the last reads, sent again (no read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  /**
   * "Test the connection": each controller whose interval allows it is read
   * now (one test every 10 s at most); the status after.
   */
  async testConnection() {
    const language = this.config.language;
    const reads = [];
    let waitMax = 0;
    for (const ctl of this.configured()) {
      const wait = Math.max(this.dueIn(ctl), ctl.lastTestAt + TIMINGS.testEvery - this.mono());
      if (wait > 0 || ctl.running) {
        waitMax = Math.max(waitMax, wait);
        continue;
      }
      ctl.lastTestAt = this.mono();
      reads.push(this.tick(ctl));
    }
    await Promise.allSettled(reads);
    const [, message] = this.status();
    return word(waitMax > 0 ? join(message, T.notSooner(age(waitMax))) : message, language);
  }

  // --- Commands --------------------------------------------------------------------

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.mono();
    const target = parseExternalId(feature?.external_id);
    const action = target?.kind === 'controller' && target.key ? COMMANDS[target.key] : undefined;
    if (!action) {
      throw this.refusal(ERRORS.readOnly);
    }
    if (action === 'close') {
      // Never held back: whatever the value, the option, a read or a command.
      return this.protect(target.uid, received);
    }
    if (value !== PRESSED && value !== String(PRESSED)) {
      throw this.refusal(ERRORS.badButton);
    }
    if (!this.config.allowOpen) {
      throw this.refusal(ERRORS.openDisabled);
    }
    return this.open(target.uid, received);
  }

  // --- Open (sensitive) ---------------------------------------------------------

  /** The checks before any request of an open, and again right before its datagram. */
  checkOpen(ctl, entry) {
    if (!this.config.allowOpen) throw this.refusal(ERRORS.openDisabled);
    // /data not read yet: a close kept there may come back and close it again.
    if (!this.memoryReady) throw this.refusal(ERRORS.dataLoading);
    if (entry.generation !== this.generation || !ctl.configured) {
      throw this.refusal(ERRORS.configChanged);
    }
    if (entry.seq !== ctl.protectSeq || ctl.stopJobs.length > 0 || ctl.stopWorker) {
      throw this.refusal(ERRORS.closeMeanwhile);
    }
    if (entry.late || this.mono() > entry.sendBy) {
      throw this.refusal(ERRORS.tooSlow);
    }
  }

  async open(uid, received) {
    const ctl = this.configured().find((c) => c.uid === uid && c.online === true);
    if (!ctl) {
      throw this.refusal(ERRORS.openUnknown);
    }
    if (ctl.stopJobs.length > 0 || ctl.stopWorker) {
      throw this.refusal(ERRORS.closeMeanwhile);
    }
    if (ctl.opening) {
      throw this.refusal(ERRORS.openInProgress);
    }
    const entry = {
      uid,
      seq: ctl.protectSeq,
      generation: this.generation,
      received,
      sendBy: received + TIMINGS.commandSendBy,
      answerBy: received + TIMINGS.commandAnswerBy,
      sent: false,
      late: false,
    };
    ctl.opening = true;
    const work = this.openOnLine(ctl, entry).finally(() => {
      ctl.opening = false;
    });
    let timer;
    const outcome = await Promise.race([
      work.then(
        () => ({ ok: true }),
        (error) => ({ error }),
      ),
      new Promise((resolve) => {
        timer = this.timers.setTimeout(
          () => resolve({ late: true }),
          Math.max(0, entry.answerBy - this.mono()),
        );
      }),
    ]);
    this.timers.clearTimeout(timer);
    if (outcome.late) {
      // Never "not sent" once the datagram may have left; never sent from now on.
      entry.late = true;
      work.catch(() => {});
      throw this.refusal(entry.sent ? ERRORS.openSentUnconfirmed('timeout') : ERRORS.tooSlow);
    }
    if (outcome.error) throw outcome.error;
    return undefined;
  }

  /** The fresh read of an open, on its line: identity, valve, leaks. */
  async freshRead(ctl, holder, entry, until) {
    const get = async (command, params) => {
      if (this.mono() >= until) {
        throw this.refusal(ERRORS.tooSlow);
      }
      const startedAt = this.mono();
      const r = await this.request(ctl, holder, command, {
        params,
        timeoutMs: Math.max(
          TIMINGS.commandMinRequest,
          Math.min(TIMINGS.readTimeout, until - this.mono()),
        ),
      });
      return { ...r, startedAt };
    };
    const ping = await get(CMD.PING);
    const { uid } = parsePing(ping.answer);
    if (!uid) throw this.refusal(ERRORS.identityUnreadable);
    if (uid !== entry.uid) throw this.refusal(ERRORS.otherController);
    const status = await get(CMD.VALVE_STATUS);
    const { state } = parseValveStatus(status.answer);
    this.applyValve(ctl, state, status.seq, status.startedAt);
    const onboardRead = await get(CMD.ONBOARD_SENSOR_STATUS);
    const onboard = parseOnboard(onboardRead.answer);
    if (!ctl.onboard || ctl.onboard.seq < onboardRead.seq) {
      ctl.onboard = { ...onboard, seq: onboardRead.seq, at: onboardRead.startedAt };
    }
    // Every paired sensor is read now: a leak anywhere keeps the valve closed,
    // and a sensor that cannot be read (silent, refused, out of time) is
    // unknown, so the open is refused (never "it does not answer, go").
    if (ctl.pairedUids === undefined) throw this.refusal(ERRORS.sensorsUnknown);
    const wetSensors = [];
    const unread = [];
    for (const sensorUid of ctl.pairedUids) {
      if (this.mono() >= until) {
        unread.push(sensorUid);
        continue;
      }
      try {
        const r = await get(CMD.SENSOR_STATUS, { uid: sensorUid });
        const reading = parseSensorStatus(r.answer);
        if (reading.uid !== undefined && reading.uid !== sensorUid) unread.push(sensorUid);
        else if (reading.wet === true) wetSensors.push(sensorUid);
        else if (reading.wet !== false) unread.push(sensorUid);
      } catch (err) {
        if (err?.kind === ERROR_KINDS.ABORTED || !(err instanceof GuardianError)) throw err;
        unread.push(sensorUid);
      }
    }
    return {
      state,
      wet: onboard.wet,
      wetSensors,
      unread,
      startedAt: status.startedAt,
      seq: status.seq,
    };
  }

  async openOnLine(ctl, entry) {
    this.checkOpen(ctl, entry);
    const giveUp = new AbortController();
    const giveUpTimer = this.timers.setTimeout(
      () => giveUp.abort(),
      Math.max(0, entry.sendBy - TIMINGS.commandMinRequest - this.mono()),
    );
    let holder;
    try {
      holder = await ctl.lane.acquire('command', { signal: giveUp.signal });
    } catch {
      throw this.refusal(ERRORS.tooSlow);
    } finally {
      this.timers.clearTimeout(giveUpTimer);
    }
    let liftedGuard;
    try {
      this.checkOpen(ctl, entry);
      let fresh;
      try {
        fresh = await this.freshRead(ctl, holder, entry, entry.sendBy - TIMINGS.commandMinRequest);
      } catch (err) {
        if (!(err instanceof GuardianError)) throw err;
        if (err.kind === ERROR_KINDS.ABORTED && entry.seq !== ctl.protectSeq) {
          throw this.refusal(ERRORS.closeMeanwhile);
        }
        throw this.refusal(ERRORS.stateUnknown(errorReason(err)));
      }
      if (fresh.wet === true) throw this.refusal(ERRORS.leakNow);
      if (fresh.wet !== false) throw this.refusal(ERRORS.leakUnknown);
      if (fresh.wetSensors.length > 0) throw this.refusal(ERRORS.leakSensor(fresh.wetSensors));
      if (fresh.unread.length > 0) throw this.refusal(ERRORS.sensorUnread(fresh.unread));
      const { state } = fresh;
      if (state === undefined) throw this.refusal(ERRORS.stateUnknown('protocol'));
      if (VALVE.isMoving(state)) throw this.refusal(ERRORS.moving(valveText(state)));
      if (state !== VALVE.CLOSED && state !== VALVE.OPENED) {
        throw this.refusal(ERRORS.badState(valveText(state)));
      }
      // Open already, and no close kept: nothing to send. A close kept is
      // never let go without a datagram: the open is sent (answered "already open").
      if (state === VALVE.OPENED && !ctl.guard) {
        this.logger.info(`Guardian: ${entry.uid} already open`);
        return;
      }
      if (ctl.guard) {
        // The close kept is let go by this open: in /data BEFORE the datagram,
        // or nothing is sent (a restart would close the valve again). Only
        // this guard: a close clicked meanwhile is a new one, never let go here.
        liftedGuard = ctl.guard;
        if (!(await this.persist(TIMINGS.saveWait, { without: liftedGuard }))) {
          throw this.refusal(ERRORS.dataNotWritten);
        }
      }
      // The deadline, the option and the closes again, right before the datagram.
      this.checkOpen(ctl, entry);
      this.logger.info(`Guardian: open ${entry.uid} at ${ctl.addressText}`);
      let accepted = false;
      try {
        await this.request(ctl, holder, CMD.VALVE_OPEN, {
          timeoutMs: Math.max(
            TIMINGS.commandMinRequest,
            entry.answerBy - TIMINGS.applyWait - TIMINGS.commandMinRequest - this.mono(),
          ),
          beforeSend: () => {
            this.checkOpen(ctl, entry);
            entry.sent = true;
          },
        });
        accepted = true;
      } catch (err) {
        if (err?.kind === ERROR_KINDS.DEVICE && err.code === DEVICE_ERRORS.ALREADY_OPEN) {
          accepted = true;
        } else {
          return this.openFailed(ctl, entry, err, liftedGuard);
        }
      }
      // Left and accepted: the close kept is let go (a newer intent, clicked with the option).
      if (liftedGuard) {
        // dropGuard lets go this very guard only, never a newer one.
        this.dropGuard(ctl, liftedGuard, 'opened from Gladys');
        liftedGuard = undefined;
      }
      this.followUp(ctl);
      if (!accepted) return undefined;
      // The read back alone confirms it.
      const left = entry.answerBy - this.mono() - TIMINGS.commandMinRequest;
      if (left < TIMINGS.applyWait + TIMINGS.commandMinRequest) {
        throw this.refusal(ERRORS.openSentUnconfirmed('timeout'));
      }
      await this.sleep(TIMINGS.applyWait, holder.signal);
      let back;
      try {
        const startedAt = this.mono();
        const r = await this.request(ctl, holder, CMD.VALVE_STATUS, {
          timeoutMs: Math.max(TIMINGS.commandMinRequest, entry.answerBy - this.mono() - 100),
        });
        back = parseValveStatus(r.answer).state;
        this.applyValve(ctl, back, r.seq, startedAt);
      } catch (err) {
        throw this.refusal(ERRORS.openSentUnconfirmed(errorReason(err)));
      }
      if (back === VALVE.OPENED || VALVE.isOpening(back)) {
        this.logger.info(`Guardian: open of ${entry.uid} confirmed (${valveText(back).en})`);
        return undefined;
      }
      throw this.refusal(
        back === VALVE.CLOSED ? ERRORS.openNotApplied : ERRORS.openDiffers(valveText(back)),
      );
    } catch (err) {
      if (liftedGuard && ctl.guard === liftedGuard) {
        // Nothing left: the close kept stays, in /data again (never awaited).
        this.persist(TIMINGS.stopSaveWait).catch(() => {});
      }
      throw err;
    } finally {
      holder.release();
      this.publishAll().catch(() => {});
    }
  }

  /** An open that failed: never "not sent" once the datagram may have left. */
  openFailed(ctl, entry, err, liftedGuard) {
    const reason = errorReason(err);
    this.logger.warn(`Guardian: open of ${entry.uid} failed (${reason})`);
    if (!entry.sent) {
      if (err?.beforeSend && err.cause instanceof Error) throw err.cause;
      if (err?.kind === ERROR_KINDS.ABORTED && entry.seq !== ctl.protectSeq) {
        throw this.refusal(ERRORS.closeMeanwhile);
      }
      throw this.refusal(ERRORS.openNotSent(reason));
    }
    if (answered(err)) {
      // Refused by the valve: not applied; a close kept stays.
      this.followUp(ctl);
      throw this.refusal(ERRORS.openRefused(reason));
    }
    // Left, no answer: it may have been applied; the newer intent wins over a close kept.
    if (liftedGuard) {
      this.dropGuard(ctl, liftedGuard, 'opened from Gladys (sent without an answer)');
    }
    this.followUp(ctl);
    throw this.refusal(ERRORS.openSentUnconfirmed(reason));
  }

  /** Reads after a command (5 s, 20 s): its effect, then a check. */
  followUp(ctl) {
    for (const handle of ctl.followUps) this.timers.clearTimeout(handle);
    ctl.followUps.clear();
    if (this.stopped) return;
    const generation = this.generation;
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        ctl.followUps.delete(handle);
        if (generation === this.generation && ctl.configured && !this.stopped) {
          Promise.resolve(ctl.running)
            .then(() => this.tick(ctl))
            .catch(() => this.logger.error('Guardian: read failed'));
        }
      }, delay);
      ctl.followUps.add(handle);
    }
  }

  // --- Close (protective) -------------------------------------------------------

  /**
   * Where the close of valve `uid` goes: the controllers that answered `uid`
   * in this run; else those where /data last saw it (and nothing else since);
   * else every configured address whose controller was never identified.
   * `except`: an address known (now) to hold another valve.
   */
  stopTargets(uid, except) {
    const all = [...this.controllers.values()].filter((c) => c !== except);
    const bySession = all.filter((c) => c.uid === uid);
    if (bySession.length > 0) return bySession;
    const byKept = all.filter((c) => c.uid === undefined && c.keptUid === uid);
    if (byKept.length > 0) return byKept;
    return all.filter((c) => c.configured && c.uid === undefined && !c.keptUid);
  }

  /**
   * A close clicked: queued before anything on each target (it ends a read or
   * an open on the line), answered by 3.5 s after the click.
   */
  async protect(uid, received) {
    // /data holds the addresses read: known even before the configuration (a
    // hung disk never holds the close back: 200 ms at most).
    await this.bounded(this.loadMemory(), TIMINGS.stopSaveWait);
    const targets = this.stopTargets(uid);
    if (targets.length === 0) {
      throw this.refusal(
        this.controllers.size === 0 ? ERRORS.closeNoAddress : ERRORS.closeElsewhere,
      );
    }
    // A close clicked again for a valve searched for: it goes to the targets now.
    this.lost.delete(uid);
    const jobs = targets.map((ctl) => this.queueStop(ctl, uid, received));
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(
        () => resolve('late'),
        Math.max(0, received + TIMINGS.commandAnswerBy - this.mono()),
      );
    });
    const results = await Promise.all(
      jobs.map((job) => Promise.race([job.done.then((r) => r.get(uid)), late])),
    );
    this.timers.clearTimeout(timer);
    const failures = results
      .map((result, i) =>
        result === 'late'
          ? jobs[i].written
            ? ERRORS.closeUnconfirmed(jobs[i].ctl.addressText)
            : ERRORS.closePending(jobs[i].ctl.addressText)
          : result?.error,
      )
      .filter(Boolean);
    // One target that read the valve clicked, closing or closed: the close is applied.
    const confirmed = results.some((r) => r !== 'late' && r && !r.error);
    if (!confirmed && failures.length > 0) {
      throw this.refusal(failures.reduce((a, b) => join(a, b)));
    }
    return undefined;
  }

  /** Queues a close on one controller; a click still waiting there is joined. */
  queueStop(ctl, uid, received) {
    // Every open that arrived before this close and has not left gives way.
    ctl.protectSeq += 1;
    let job = ctl.stopJobs.find((j) => !j.running);
    if (job) {
      job.uids.add(uid);
      return job;
    }
    job = { ctl, uids: new Set([uid]), received, written: false, running: false };
    job.done = new Promise((resolve) => {
      job.resolve = resolve;
    });
    ctl.stopJobs.push(job);
    this.runStops(ctl);
    return job;
  }

  runStops(ctl) {
    if (ctl.stopWorker) return;
    ctl.stopWorker = (async () => {
      try {
        while (ctl.stopJobs.length > 0) {
          const batch = ctl.stopJobs.filter((j) => !j.running);
          for (const job of batch) job.running = true;
          try {
            await this.sendStop(ctl, batch);
          } catch (err) {
            this.logger.warn(`Guardian: close failed: ${err.message}`);
            for (const job of batch) {
              job.resolve(
                new Map(
                  [...job.uids].map((u) => [u, { error: ERRORS.closePending(ctl.addressText) }]),
                ),
              );
            }
          }
          ctl.stopJobs = ctl.stopJobs.filter((j) => !batch.includes(j));
        }
      } finally {
        ctl.stopWorker = undefined;
        this.updateStatus().catch(() => {});
      }
    })();
  }

  newGuard(uids, previous) {
    return {
      /** The valves whose close goes to this address. */
      uids: new Set(uids),
      /** The first of them (logs, older tools). */
      get uid() {
        return [...this.uids][0];
      },
      since: this.now(),
      written: false,
      sentAt: undefined,
      sentSeq: undefined,
      resends: 0,
      /** Every datagram the controller accepted for this close (said in the status). */
      accepted: 0,
      seenApplied: false,
      contraReads: 0,
      closingSince: undefined,
      held: false,
      heldState: undefined,
      heldEvery: TIMINGS.heldResendFirst,
      nextHeldAt: Infinity,
      refused: undefined,
      failure: undefined,
      other: previous?.other,
    };
  }

  /**
   * The guard of a close clicked: a NEW object for each click (an open in
   * flight that replaced the previous one can only let go that one), with
   * the valves of the previous guard of this address and the new one.
   */
  prepareGuard(ctl, uids) {
    const previous = ctl.guard;
    ctl.guard = this.newGuard([...(previous?.uids ?? []), ...uids], previous);
    return ctl.guard;
  }

  /** The close datagram, on the line held; `beforeSend` right before it leaves. */
  sendClose(ctl, holder, timeoutMs, guard, beforeSend) {
    return this.request(ctl, holder, CMD.VALVE_CLOSE, {
      timeoutMs,
      beforeSend: () => {
        beforeSend?.();
        guard.written = true;
        guard.sentAt = this.mono();
        guard.sentSeq = ctl.seq + 1;
        guard.failure = undefined;
      },
    });
  }

  /**
   * The close clicked on one controller: written at once (no read before),
   * tried again every 250 ms on a "moving" (the controller refuses any
   * command while its valve moves) or right away after a silence (one try
   * waits 1.2 s), for 3 s; then one read back (identity and valve) that
   * alone confirms it, for the valve clicked only. Not confirmed: kept (in
   * /data) and checked.
   */
  async sendStop(ctl, jobs) {
    const received = Math.min(...jobs.map((j) => j.received));
    const answerBy = received + TIMINGS.commandAnswerBy;
    const guard = this.prepareGuard(
      ctl,
      jobs.flatMap((j) => [...j.uids]),
    );
    this.logger.info(`Guardian: close at ${ctl.addressText}`);
    // In /data before the first byte, so a restart sends it again; a save that
    // fails or hangs never holds the close back (200 ms at most).
    await this.bounded(this.persist(TIMINGS.stopSaveWait), TIMINGS.stopSaveWait);
    const retryUntil = Math.max(received, this.mono()) + TIMINGS.stopRetryFor;
    let accepted = false;
    let busy = false;
    let failure;
    let back;
    const holder = await ctl.lane.acquire('stop');
    try {
      for (;;) {
        // The clicks of this controller waiting now join this turn.
        for (const job of ctl.stopJobs.filter((j) => !j.running)) {
          job.running = true;
          jobs.push(job);
          for (const u of job.uids) guard.uids.add(u);
        }
        try {
          await this.sendClose(
            ctl,
            holder,
            Math.max(100, Math.min(TIMINGS.stopTry, answerBy - 200 - this.mono())),
            guard,
            () => {
              for (const job of jobs) job.written = true;
            },
          );
          accepted = true;
        } catch (err) {
          failure = err;
          if (err?.kind === ERROR_KINDS.DEVICE && err.code === DEVICE_ERRORS.ALREADY_CLOSED) {
            accepted = true;
          } else if (err?.kind === ERROR_KINDS.DEVICE && err.code === DEVICE_ERRORS.MOVING) {
            // Busy: not a try; tried again.
            busy = true;
          } else if (answered(err)) {
            // Refused by the controller: kept, sent again by the check.
            guard.refused = errorReason(err);
            guard.sentAt = undefined;
            break;
          } else if (err?.kind === ERROR_KINDS.ABORTED) {
            break;
          } else if (!guard.written) {
            guard.failure = errorReason(err);
          }
        }
        if (accepted) {
          failure = undefined;
          guard.refused = undefined;
          guard.accepted += 1;
          break;
        }
        if (this.mono() + TIMINGS.stopRetry >= retryUntil || this.stopped) break;
        await this.sleep(TIMINGS.stopRetry);
      }
      // The read back, once the valve had time to start, if it fits before the answer.
      if (accepted && !this.stopped) {
        const left = answerBy - this.mono() - 2 * TIMINGS.commandMinRequest;
        if (left >= TIMINGS.commandMinRequest) {
          await this.sleep(Math.min(TIMINGS.applyWait, left - TIMINGS.commandMinRequest));
          try {
            back = await this.readStopState(ctl, holder, answerBy - 100);
          } catch (err) {
            this.logger.debug(`Guardian: read back of the close failed (${errorReason(err)})`);
          }
        }
      }
    } finally {
      holder.release();
    }
    let decision;
    const readUid = back?.read?.uid;
    if (back && ctl.guard === guard) {
      decision = this.decideStop(guard, back.read, back.seq, back.startedAt);
      if (decision === 'done') this.dropGuard(ctl, guard, 'closed');
      else if (decision === 'other') this.misplaced(ctl, guard, readUid);
    }
    const where = ctl.addressText;
    // The answer of each valve clicked: a success only when the read back read
    // that valve (its UID), closing or closed.
    const resultFor = (uid) => {
      if (decision === 'other' || (readUid && readUid !== uid)) {
        return { error: ERRORS.closeOther(where, uid, readUid) };
      }
      if (decision === 'done' || (decision === 'watch' && guard.seenApplied)) {
        return readUid === uid ? {} : { error: ERRORS.closeNotIdentified(where) };
      }
      if (failure && !accepted) {
        if (guard.refused) return { error: ERRORS.closeRefused(where, guard.refused) };
        if (busy) return { error: ERRORS.closeBusy(where) };
        if (!jobs.some((j) => j.written)) {
          return { error: ERRORS.closeNotSent(where, errorReason(failure)) };
        }
        return { error: ERRORS.closeNoAnswer(where) };
      }
      return { error: ERRORS.closeUnconfirmed(where) };
    };
    for (const job of jobs) {
      job.resolve(new Map([...job.uids].map((u) => [u, resultFor(u)])));
    }
    if (decision === 'done' || (decision === 'watch' && guard.seenApplied)) {
      this.logger.info(`Guardian: close at ${where} confirmed (${readUid ?? 'identity not read'})`);
    }
    // Armed before /data is written, never awaited: a hung disk never stops the checks.
    if (ctl.guard === guard) {
      const next = !guard.written
        ? SECOND
        : guard.seenApplied
          ? TIMINGS.stopWatch
          : guard.sentAt !== undefined
            ? Math.max(0, guard.sentAt + TIMINGS.stopApplyDelay - this.mono()) + TIMINGS.applyWait
            : TIMINGS.stopCheck;
      this.armStopCheck(ctl, next);
    }
    this.persist(TIMINGS.stopSaveWait).catch(() => {});
    if (jobs.some((j) => j.written) && ctl.configured) this.followUp(ctl);
    this.publishAll().catch(() => {});
  }

  /** The identity and the valve state, on the line held, within `until`. */
  async readStopState(ctl, holder, until) {
    const timeoutMs = () =>
      Math.max(TIMINGS.commandMinRequest, Math.min(TIMINGS.readTimeout, until - this.mono()));
    const read = {};
    // The identity tells "another controller" apart; unreadable, it proves nothing.
    try {
      read.uid = parsePing(
        (await this.request(ctl, holder, CMD.PING, { timeoutMs: timeoutMs() })).answer,
      ).uid;
    } catch (err) {
      if (err?.kind === ERROR_KINDS.ABORTED) throw err;
    }
    if (read.uid) this.identify(ctl, read.uid);
    const startedAt = this.mono();
    const r = await this.request(ctl, holder, CMD.VALVE_STATUS, { timeoutMs: timeoutMs() });
    read.state = parseValveStatus(r.answer).state;
    // Only the valve whose identity this run read at this address gets the state.
    if (read.uid && read.uid === ctl.readingsUid) {
      this.applyValve(ctl, read.state, r.seq, startedAt);
    }
    this.answered(ctl);
    return { read, seq: r.seq, startedAt };
  }

  /**
   * What a read says of a close kept: 'done' (closed), 'watch' (closing, or
   * opened once after it was seen closing), 'elsewhere' (opened twice in a
   * row after it was seen closing: opened by the app or the button), 'other'
   * (another valve answers at the address: the close goes on where its valve
   * is), 'stale' (the read left before the close), 'wait' (read too soon
   * after the close left), 'resend' (still open, in a fault, or unreadable:
   * sent again, in doubt), 'hold' (3 resends accepted without effect: sent
   * again on a slower cadence, `nextHeldAt`), 'send' (never left).
   */
  decideStop(guard, read, readSeq, readStartedAt) {
    if (read?.uid && !guard.uids.has(read.uid)) return 'other';
    if (!guard.written) return 'send';
    if (readSeq !== undefined && guard.sentSeq !== undefined && readSeq < guard.sentSeq) {
      return 'stale';
    }
    const state = read?.state;
    if (state === VALVE.CLOSED) return 'done';
    if (VALVE.isClosing(state)) {
      guard.seenApplied = true;
      guard.contraReads = 0;
      guard.closingSince ??= this.mono();
      return 'watch';
    }
    if (guard.seenApplied && (state === VALVE.OPENED || VALVE.isOpening(state))) {
      guard.contraReads += 1;
      return guard.contraReads >= 2 ? 'elsewhere' : 'watch';
    }
    if (
      state !== undefined &&
      guard.sentAt !== undefined &&
      readStartedAt < guard.sentAt + TIMINGS.stopApplyDelay
    ) {
      return 'wait';
    }
    if (guard.held && state !== undefined && state !== guard.heldState) {
      // Something changed since it was held (out of the fault, moved by hand):
      // a new budget of resends.
      this.rearm(guard, 'the valve changed');
    }
    if (guard.held || guard.resends >= TIMINGS.stopResends) {
      if (!guard.held) {
        guard.held = true;
        guard.heldState = state;
        guard.nextHeldAt = this.mono() + guard.heldEvery;
      }
      return 'hold';
    }
    return 'resend';
  }

  /** A close held gets a new budget of resends (a change read, the controller back, a restart). */
  rearm(guard, reason) {
    if (!guard.held && guard.resends === 0) return;
    guard.held = false;
    guard.resends = 0;
    guard.heldState = undefined;
    guard.heldEvery = TIMINGS.heldResendFirst;
    guard.nextHeldAt = Infinity;
    this.logger.info(`Guardian: close held, tried again (${reason})`);
  }

  /** A controller answered: back after a silence, the closes held there get a new budget. */
  answered(ctl) {
    if (ctl.silent && ctl.guard) {
      this.rearm(ctl.guard, 'the controller answers again');
      this.armStopCheck(ctl, 0);
    }
    ctl.silent = false;
  }

  /**
   * Another valve (`readUid`) answers where the close of `guard` went: the
   * valves of the guard that are not this one are never let go: each goes
   * where its valve answers in this run, else to the addresses never
   * identified, else waits (in /data, said in the status) until its valve
   * answers at a configured address.
   */
  misplaced(ctl, guard, readUid) {
    if (ctl.guard !== guard || !readUid) return;
    const away = [...guard.uids].filter((u) => u !== readUid);
    if (away.length === 0) return;
    this.logger.warn(
      `Guardian: ${readUid} answers at ${ctl.addressText}, not ${away.join(', ')}: their close goes on elsewhere`,
    );
    if (guard.uids.has(readUid)) {
      for (const u of away) guard.uids.delete(u);
    } else {
      this.dropGuard(ctl, guard, `another valve (${readUid}) at its address`);
    }
    for (const uid of away) this.relocate(uid, ctl, readUid, guard.since);
  }

  /**
   * Where a close sent to the wrong valve goes now: where `uid` answers in
   * this run, else every configured address not identified in this run
   * (what /data says of them may be stale: addresses move), never `from`.
   */
  relocateTargets(uid, from) {
    const all = [...this.controllers.values()].filter((c) => c !== from);
    const bySession = all.filter((c) => c.uid === uid);
    if (bySession.length > 0) return bySession;
    return all.filter((c) => c.configured && c.uid === undefined);
  }

  /** Sends the close of `uid` where its valve is now, or keeps it until it is found. */
  relocate(uid, from, readUid, since = this.now()) {
    const targets = this.relocateTargets(uid, from);
    if (targets.length === 0) {
      const lost = this.lost.get(uid);
      this.lost.set(uid, {
        uid,
        since: lost?.since ?? since,
        where: from?.addressText,
        other: readUid,
      });
      this.persist(TIMINGS.stopSaveWait).catch(() => {});
      this.updateStatus().catch(() => {});
      return;
    }
    this.lost.delete(uid);
    for (const ctl of targets) {
      const guard = this.prepareGuard(ctl, [uid]);
      guard.since = Math.min(guard.since, since);
      this.armStopCheck(ctl, 0);
    }
    this.persist(TIMINGS.stopSaveWait).catch(() => {});
    this.updateStatus().catch(() => {});
  }

  /** A valve identified at a controller: the closes searched for it go there now. */
  foundValve(ctl, uid) {
    if (this.lost.has(uid)) {
      const { since } = this.lost.get(uid);
      this.lost.delete(uid);
      const guard = this.prepareGuard(ctl, [uid]);
      guard.since = Math.min(guard.since, since);
      this.logger.warn(`Guardian: ${uid} found at ${ctl.addressText}: its close goes there`);
      this.armStopCheck(ctl, 0);
      this.persist(TIMINGS.stopSaveWait).catch(() => {});
    }
    // A close kept here for another valve: that valve is not here.
    if (ctl.guard) this.misplaced(ctl, ctl.guard, uid);
  }

  /** The lost closes try the addresses again (a new configuration). */
  retryLost() {
    for (const { uid, since, where } of [...this.lost.values()]) {
      const from = where ? this.controllers.get(where) : undefined;
      if (this.relocateTargets(uid, from).length > 0) this.relocate(uid, from, undefined, since);
    }
  }

  /** A poll read seen by the close kept: let go when it shows it applied, else checked now. */
  observeStop(ctl, read, readSeq, startedAt) {
    const g = ctl.guard;
    if (!g || ctl.stopWorker || ctl.checking) return;
    const decision = this.decideStop(g, read, readSeq, startedAt);
    if (decision === 'done') this.dropGuard(ctl, g, 'closed');
    else if (decision === 'other') this.misplaced(ctl, g, read.uid);
    else if (decision === 'elsewhere') this.dropGuard(ctl, g, 'opened elsewhere (read twice)');
    else if (decision === 'resend' || decision === 'send') this.armStopCheck(ctl, 0);
    else if (decision === 'watch') this.armStopCheck(ctl, TIMINGS.stopWatch);
    else if (decision === 'hold') {
      this.armStopCheck(ctl, Math.max(0, Math.min(TIMINGS.stopCheck, g.nextHeldAt - this.mono())));
    }
  }

  checkMustYield(ctl) {
    return ctl.stopJobs.length > 0 || Boolean(ctl.stopWorker) || ctl.opening;
  }

  /**
   * The periodic check of the close kept on one controller. Never written:
   * sent first, without a read (a close that never left is never given up).
   * Then the identity and the valve are read, and the close is sent again
   * when `decideStop` says so (a close held: on its slower cadence). It
   * gives its turn to a click or an open (tried again a second later),
   * checked once more right before each write.
   */
  async runCheck(ctl) {
    const guard = ctl.guard;
    if (!guard || this.stopped) return;
    if (this.checkMustYield(ctl) || ctl.checking) {
      this.armStopCheck(ctl, SECOND);
      return;
    }
    ctl.checking = true;
    let next = TIMINGS.stopCheck;
    let yielded = false;
    let written = false;
    let holder;
    const send = async () => {
      const wasWritten = guard.written;
      try {
        await this.sendClose(ctl, holder, TIMINGS.readTimeout, guard, () => {
          if (this.checkMustYield(ctl) || ctl.guard !== guard) {
            throw new Error('a click or an open');
          }
          this.logger.warn(`Guardian: close at ${ctl.addressText} sent (check)`);
        });
        written = true;
        // Accepted by the valve: a resend (a refusal or a silence is not one).
        if (wasWritten) guard.resends += 1;
        guard.accepted += 1;
        guard.refused = undefined;
        this.answered(ctl);
        next = TIMINGS.stopApplyDelay + TIMINGS.applyWait;
      } catch (err) {
        if (err?.beforeSend) {
          yielded = true;
          return;
        }
        if (err?.kind === ERROR_KINDS.ABORTED) throw err;
        if (err?.kind === ERROR_KINDS.DEVICE && err.code === DEVICE_ERRORS.ALREADY_CLOSED) {
          written = true;
          this.answered(ctl);
          next = TIMINGS.applyWait;
        } else if (err?.kind === ERROR_KINDS.DEVICE && err.code === DEVICE_ERRORS.MOVING) {
          this.answered(ctl);
          next = 2 * SECOND;
        } else if (answered(err)) {
          this.answered(ctl);
          guard.refused = errorReason(err);
          guard.sentAt = undefined;
        } else {
          ctl.silent = true;
          if (!guard.written) guard.failure = errorReason(err);
        }
      }
    };
    try {
      holder = await ctl.lane.acquire('check');
      if (this.checkMustYield(ctl) || ctl.guard !== guard) {
        yielded = true;
      } else if (!guard.written) {
        await send();
      } else {
        let back;
        try {
          back = await this.readStopState(ctl, holder, this.mono() + TIMINGS.readTimeout * 2);
        } catch (err) {
          if (err?.kind === ERROR_KINDS.ABORTED) throw err;
          // Nothing readable: sent again, in doubt (the close is the safe side).
          ctl.silent = true;
          back = { read: undefined, seq: undefined, startedAt: this.mono() };
        }
        if (ctl.guard === guard) {
          const decision = this.decideStop(guard, back.read, back.seq, back.startedAt);
          if (decision === 'done') this.dropGuard(ctl, guard, 'closed');
          else if (decision === 'other') this.misplaced(ctl, guard, back.read.uid);
          else if (decision === 'elsewhere') {
            this.dropGuard(ctl, guard, 'opened elsewhere (read twice)');
          } else if (decision === 'watch') next = TIMINGS.stopWatch;
          else if (decision === 'wait') {
            next = Math.max(0, guard.sentAt + TIMINGS.stopApplyDelay - this.mono()) + 1;
          } else if (decision === 'resend') await send();
          else if (decision === 'hold') {
            if (this.mono() >= guard.nextHeldAt) {
              // Held: sent again on a slower cadence (30 s, doubling to 10 min), forever.
              await send();
              guard.heldEvery = Math.min(TIMINGS.heldResendMax, guard.heldEvery * 2);
              guard.nextHeldAt = this.mono() + guard.heldEvery;
            }
            next = Math.max(0, Math.min(TIMINGS.stopCheck, guard.nextHeldAt - this.mono()));
          }
        }
      }
    } catch (err) {
      if (err?.kind === ERROR_KINDS.ABORTED) yielded = true;
      else this.logger.warn(`Guardian: check of the close failed (${errorReason(err)})`);
    } finally {
      holder?.release();
      ctl.checking = false;
    }
    if (written && ctl.configured) this.followUp(ctl);
    if (!ctl.guard) {
      this.publishAll().catch(() => {});
      return;
    }
    this.armStopCheck(ctl, yielded ? SECOND : next);
    this.persist(TIMINGS.stopSaveWait).catch(() => {});
    this.updateStatus().catch(() => {});
  }

  /** Lets go `guard` only: a newer guard of the address (a newer click) stays. */
  dropGuard(ctl, guard, reason) {
    if (!ctl.guard || ctl.guard !== guard) return;
    ctl.guard = undefined;
    this.logger.info(`Guardian: close at ${ctl.addressText} let go (${reason})`);
    if (ctl.checkTimer) {
      this.timers.clearTimeout(ctl.checkTimer);
      ctl.checkTimer = undefined;
      ctl.checkDueAt = Infinity;
    }
    if (!ctl.configured && ctl.stopJobs.length === 0) {
      this.controllers.delete(ctl.addressText);
    }
    this.persist(TIMINGS.stopSaveWait).catch(() => {});
    this.updateStatus().catch(() => {});
  }

  /** The next check of the close kept: whatever the interval or the failures. */
  armStopCheck(ctl, delay = TIMINGS.stopCheck) {
    if (!ctl.guard || this.stopped) return;
    const dueAt = this.mono() + delay;
    if (ctl.checkTimer) {
      // A check already due sooner is never pushed back.
      if (ctl.checkDueAt <= dueAt) return;
      this.timers.clearTimeout(ctl.checkTimer);
    }
    ctl.checkDueAt = dueAt;
    ctl.checkTimer = this.timers.setTimeout(() => {
      ctl.checkTimer = undefined;
      ctl.checkDueAt = Infinity;
      this.runCheck(ctl).catch((err) => this.logger.warn(`Guardian: check: ${err.message}`));
    }, delay);
  }
}

export { controllerIds, sensorIds };
