// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), with wall dates (a monotonic instant belongs to its process):
//   - `controllers`: each address read, the UID of the controller last read
//     there (where a close goes before the configuration is read, or while
//     the controller does not answer) and the time of its last read (written
//     at most once a minute, BEFORE the read: a restart never reads sooner
//     than the interval);
//   - `stops`: the closes not seen applied (address, UIDs of the valves
//     clicked, since, written, resends, seen applied): a restart sends them
//     again at once, without the configuration;
//   - `lost`: the closes of valves another valve answered for at the address
//     they went to, kept until their valve answers at a configured address.
// No secret (there is none), no personal data. The file is the container
// user's only (0600), bounded (64 KiB) and repaired when read. A file that
// cannot be read is not an empty one: `load()` says so, and the app then
// never overwrites it with a guess. Only a regular file is read: a FIFO or
// a device in its place is refused at once (never a read that hangs), and a
// symbolic link is never followed.
// -----------------------------------------------------------------------------

import { constants } from 'node:fs';
import { lstat, open, rename } from 'node:fs/promises';
import { LIMITS } from './constants.js';
import { normalizeUid } from './guardian/model.js';

export const STATE_FILE = '/data/guardian-state.json';

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const WRITE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_TRUNC |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK;

async function readRegular(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > LIMITS.stateFile) {
    return { unreadable: true };
  }
  const handle = await open(path, READ_FLAGS);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > LIMITS.stateFile) {
      return { unreadable: true };
    }
    const buffer = Buffer.alloc(LIMITS.stateFile + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > LIMITS.stateFile) {
      return { unreadable: true };
    }
    return { text: buffer.subarray(0, bytesRead).toString('utf8') };
  } finally {
    await handle.close();
  }
}

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    /** `{ data }`, `{ data: null }` (no file) or `{ unreadable: true }`. */
    async load() {
      let read;
      try {
        read = await readRegular(path);
      } catch (err) {
        return err?.code === 'ENOENT' ? { data: null } : { unreadable: true };
      }
      if (read.unreadable) return { unreadable: true };
      try {
        return { data: JSON.parse(read.text) };
      } catch {
        return { unreadable: true };
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        if (Buffer.byteLength(text) > LIMITS.stateFile) {
          throw new Error('state too big');
        }
        const temporary = `${path}.tmp`;
        const handle = await open(temporary, WRITE_FLAGS, 0o600);
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) throw new Error('not a regular file');
          await handle.writeFile(text, 'utf8');
        } finally {
          await handle.close();
        }
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null, { unreadable = false, failSave = false } = {}) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    loads: 0,
    unreadable,
    failSave,
    /** Promises that, while set, every load or save waits for (a hung disk). */
    hang: undefined,
    hangLoad: undefined,
    async load() {
      this.loads += 1;
      if (this.hangLoad) await this.hangLoad;
      if (this.unreadable) return { unreadable: true };
      return { data: this.data === null ? null : JSON.parse(JSON.stringify(this.data)) };
    },
    async save(data) {
      if (this.hang) await this.hang;
      if (this.failSave) throw new Error('disk full');
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

const intIn = (value, min, max) =>
  Number.isInteger(value) && value >= min && value <= max ? value : undefined;

/** An address kept: a host name or IPv4 address in lower case, and a port. */
export function addressOf(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const host =
    typeof raw.host === 'string' && raw.host.length <= 253 && /^[a-z0-9.-]+$/.test(raw.host)
      ? raw.host
      : undefined;
  const port = intIn(raw.port, 1, 65535);
  return host && port ? { host, port } : undefined;
}

export const sameAddress = (a, b) => Boolean(a && b) && a.host === b.host && a.port === b.port;

function normalizeStop(raw, now) {
  const address = addressOf(raw);
  if (!address) return undefined;
  // `since` only dates the status: a date in the future (a clock set back,
  // NTP not there yet) or none keeps the stop, dated now.
  const since = Number.isFinite(raw.since) && raw.since <= now ? raw.since : now;
  const written = raw.written === true;
  // The valves whose close goes to this address (`uid` alone in older files).
  const uids = [];
  for (const u of Array.isArray(raw.uids) ? raw.uids.slice(0, 16) : [raw.uid]) {
    const uid = normalizeUid(u);
    if (uid && !uids.includes(uid)) uids.push(uid);
  }
  return {
    ...address,
    uids,
    since,
    written,
    // Never written: no resend can have been counted (a close that never left
    // is never held); a count that cannot be read is 0.
    resends: written ? (intIn(raw.resends, 0, 100) ?? 0) : 0,
    seenApplied: written && raw.seenApplied === true,
  };
}

function normalizeController(raw, now) {
  const address = addressOf(raw);
  if (!address) return undefined;
  return {
    ...address,
    uid: normalizeUid(raw.uid) ?? null,
    // A time in the future counts as now: never a longer wait than the interval.
    lastAttemptAt: Number.isFinite(raw.lastAttemptAt) ? Math.min(raw.lastAttemptAt, now) : null,
  };
}

/** The persisted state, repaired and bounded (see the header). */
export function normalizeMemory(raw, now) {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const controllers = [];
  for (const entry of Array.isArray(data.controllers) ? data.controllers.slice(0, 64) : []) {
    const c = normalizeController(entry, now);
    if (c && !controllers.some((k) => sameAddress(k, c))) controllers.push(c);
  }
  const stops = [];
  for (const entry of Array.isArray(data.stops) ? data.stops.slice(0, 64) : []) {
    const s = normalizeStop(entry, now);
    if (s && !stops.some((k) => sameAddress(k, s))) stops.push(s);
  }
  // The closes of valves found at no address yet (another valve answered where
  // they were sent): kept until their valve answers somewhere.
  const lost = [];
  for (const entry of Array.isArray(data.lost) ? data.lost.slice(0, 64) : []) {
    const uid = normalizeUid(entry?.uid);
    if (uid && !lost.some((l) => l.uid === uid)) {
      lost.push({
        uid,
        since: Number.isFinite(entry.since) && entry.since <= now ? entry.since : now,
      });
    }
  }
  return {
    version: 1,
    controllers: controllers.slice(-LIMITS.keptControllers),
    stops: stops.slice(0, LIMITS.keptControllers),
    lost: lost.slice(0, LIMITS.keptControllers),
  };
}
