// -----------------------------------------------------------------------------
// The line to one controller: one exchange at a time (one UDP socket
// each; the controller answers on one port, and two requests in flight
// could cross). Each holder gets an AbortSignal; the exchange it runs ends
// only once its socket is closed (src/guardian/udp.js), so a new
// socket never opens while an old one is still there. Taken from
// gladys-warp-charger (src/lane.js), by way of gladys-rainmachine.
//
// Priorities: the close (3) first, then a command (2), the check of a close
// (1), the reads of the polling (0); in the order of arrival within one. A
// close arriving aborts whatever holds the line (a read stuck on a silent
// controller, a command) and takes it as soon as that socket is closed.
// -----------------------------------------------------------------------------

import { ERROR_KINDS, GuardianError } from './guardian/udp.js';

export const PRIORITY = { read: 0, check: 1, command: 2, stop: 3 };

export class Lane {
  constructor() {
    this.holder = undefined;
    this.waiting = [];
  }

  /** Whether a holder or a waiter of at least this kind is there. */
  busyWith(kind) {
    const level = PRIORITY[kind];
    return (
      (this.holder !== undefined && PRIORITY[this.holder.kind] >= level) ||
      this.waiting.some((w) => PRIORITY[w.kind] >= level)
    );
  }

  /**
   * The line for `kind`. `signal`: gives the wait up (rejects, nothing
   * taken). Resolves `{ kind, signal, release() }`.
   */
  acquire(kind, { signal } = {}) {
    if (signal?.aborted) {
      return Promise.reject(new GuardianError(ERROR_KINDS.ABORTED, 'No turn on the line'));
    }
    const priority = PRIORITY[kind];
    return new Promise((resolve, reject) => {
      const waiter = { kind, priority, resolve, reject, signal, onAbort: undefined };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) {
            this.waiting.splice(index, 1);
            reject(new GuardianError(ERROR_KINDS.ABORTED, 'No turn on the line'));
          }
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      // In priority order, first come first served within one.
      const at = this.waiting.findIndex((w) => w.priority < priority);
      this.waiting.splice(at < 0 ? this.waiting.length : at, 0, waiter);
      if (kind === 'stop' && this.holder && this.holder.kind !== 'stop') {
        this.holder.controller.abort();
      }
      this.grant();
    });
  }

  grant() {
    if (this.holder || this.waiting.length === 0) {
      return;
    }
    const waiter = this.waiting.shift();
    waiter.signal?.removeEventListener('abort', waiter.onAbort);
    const controller = new AbortController();
    const holder = {
      kind: waiter.kind,
      controller,
      signal: controller.signal,
      release: () => {
        if (this.holder === holder) {
          this.holder = undefined;
          this.grant();
        }
      },
    };
    this.holder = holder;
    waiter.resolve(holder);
  }
}
