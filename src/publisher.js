// -----------------------------------------------------------------------------
// What goes to Gladys, within its limit of 300 states per minute: push() keeps
// the current value of a feature (the last one wins); unchanged values are
// skipped by publishChangedStates and sent again every 30 min. Whatever is
// left over (budget spent, Gladys unreachable) waits for the next flush, every
// second; a value left waiting more than 2 minutes is dropped, never sent
// as new. `now` is the monotonic clock of the app (a wall clock set back
// never empties the window). Taken from gladys-warp-charger
// (src/publisher.js), by way of gladys-rainmachine.
// -----------------------------------------------------------------------------

import { LIMITS, MINUTE, TIMINGS } from './constants.js';

export class StatePublisher {
  constructor({ gladys, logger, now = () => performance.now(), timers = globalThis }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    /** featureId -> { state } | { text } */
    this.pending = new Map();
    this.window = [];
    this.timer = undefined;
    this.flushing = undefined;
  }

  start() {
    this.stop();
    this.timer = this.timers.setInterval(() => {
      this.flush().catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
    }, TIMINGS.flushInterval);
  }

  stop() {
    if (this.timer) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  push(featureId, value) {
    this.pending.set(featureId, { value, at: this.now() });
  }

  /** Forgets what is pending for a deleted device and its features. */
  forget(deviceId) {
    for (const id of [...this.pending.keys()]) {
      if (id === deviceId || id.startsWith(`${deviceId}:`)) {
        this.pending.delete(id);
      }
    }
  }

  flush() {
    if (!this.flushing) {
      this.flushing = this.send().finally(() => {
        this.flushing = undefined;
      });
    }
    return this.flushing;
  }

  async send() {
    const now = this.now();
    this.window = this.window.filter((t) => now - t < MINUTE);
    const room = Math.min(LIMITS.statesPerMinute - this.window.length, LIMITS.statesPerRequest);
    if (room <= 0 || this.pending.size === 0) {
      return;
    }
    const batch = [];
    for (const [featureId, { value, at }] of this.pending) {
      if (batch.length >= room) {
        break;
      }
      this.pending.delete(featureId);
      // A value left waiting (Gladys unreachable, budget spent) too long is not sent as new.
      if (now - at <= TIMINGS.freshFor) {
        batch.push({ device_feature_external_id: featureId, ...value, at });
      }
    }
    if (batch.length === 0) {
      return;
    }
    try {
      const states = batch.map(({ at: _at, ...state }) => state);
      const result = await this.gladys.publishChangedStates(states, {
        heartbeat: TIMINGS.stateHeartbeat,
      });
      for (let i = 0; i < (result?.count ?? batch.length); i += 1) {
        this.window.push(now);
      }
    } catch (err) {
      // Kept for the next round, unless a newer value arrived meanwhile.
      for (const { device_feature_external_id: id, at, ...value } of batch) {
        if (!this.pending.has(id)) {
          this.pending.set(id, { value, at });
        }
      }
      throw err;
    }
  }
}
