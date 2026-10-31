// -----------------------------------------------------------------------------
// One request to a Guardian valve controller: one JSON datagram to UDP port
// 7777, one JSON datagram back (aioguardian `client.py`).
//
// Every request has its own socket (a new local port), connected to the
// controller: the kernel drops datagrams from any other address, and the
// answer to an older request (late, or tried again) reaches a socket that is
// already closed, never this one. Only an answer echoing the command sent is
// taken. A request ends only once its socket is closed, so two never overlap
// (src/lane.js gives the line to one at a time).
//
// Bounds: a datagram above 4 KiB is refused (the kernel hands a datagram whole:
// the socket's receive buffer is set to that size, a bigger one is cut by the
// kernel and refused here); the time is bounded by `timeoutMs`; an abort (a
// close taking the line) ends the request at once. No broadcast: the socket
// never sets SO_BROADCAST, and "any", the limited broadcast and multicast are
// refused before a byte.
// -----------------------------------------------------------------------------

import dgram from 'node:dgram';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { unusableIpv4 } from '../config.js';
import { DEVICE_ERRORS, LIMITS } from '../constants.js';

export const ERROR_KINDS = {
  /** No answer in time (`sent` says whether the datagram left). */
  TIMEOUT: 'timeout',
  /** The host refused the port (ICMP port unreachable) or no route. */
  UNREACHABLE: 'unreachable',
  /** The host name did not resolve, or to an address never used. */
  ADDRESS: 'address',
  /** An answer that is not the protocol (not JSON, too big, no status). */
  PROTOCOL: 'protocol',
  /** The controller answered with `status: "error"` (`code`: its error_code). */
  DEVICE: 'device',
  /** Aborted by the caller (a close took the line, the app stopped). */
  ABORTED: 'aborted',
  /** `beforeSend` refused: nothing left. */
  BEFORE_SEND: 'before-send',
};

export class GuardianError extends Error {
  constructor(kind, message, { sent = false, code, cause } = {}) {
    super(message);
    this.name = 'GuardianError';
    this.kind = kind;
    /** Whether the request datagram may have left (true once handed to the socket). */
    this.sent = sent;
    /** The controller's error_code, for DEVICE. */
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/** An answer of the controller: it received the request (not a silence, not a cut). */
export const answered = (err) =>
  err instanceof GuardianError &&
  (err.kind === ERROR_KINDS.DEVICE || err.kind === ERROR_KINDS.PROTOCOL);

/** "already closed", "moving"... for the logs and statuses (never the raw answer). */
export function errorReason(err) {
  if (!(err instanceof GuardianError)) return 'error';
  if (err.kind === ERROR_KINDS.DEVICE) {
    const name = Object.entries(DEVICE_ERRORS).find(([, code]) => code === err.code)?.[0];
    return name ? name.toLowerCase().replace(/_/g, ' ') : `error ${err.code ?? '?'}`;
  }
  return err.kind;
}

function unusableAddress(address, family) {
  if (family === 4) return unusableIpv4(address);
  const a = address.toLowerCase();
  return a === '::' || a.startsWith('ff');
}

/** Resolves a host name (an IP address as is), within `timeoutMs`. */
async function resolve(host, timeoutMs, signal, timers) {
  const family = isIP(host);
  if (family) return { address: host, family };
  let timer;
  let onAbort;
  try {
    return await Promise.race([
      dnsLookup(host, { verbatim: true }).then((r) => ({ address: r.address, family: r.family })),
      new Promise((_, reject) => {
        timer = timers.setTimeout(
          () => reject(new GuardianError(ERROR_KINDS.TIMEOUT, 'Name resolution timed out')),
          Math.max(0, timeoutMs),
        );
        onAbort = () => reject(new GuardianError(ERROR_KINDS.ABORTED, 'Aborted'));
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } catch (err) {
    if (err instanceof GuardianError) throw err;
    throw new GuardianError(ERROR_KINDS.ADDRESS, `Name not resolved (${err.code ?? 'error'})`);
  } finally {
    timers.clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Parses one datagram of the controller: the object, or a GuardianError.
 * `command`: the code sent (the answer must echo it).
 */
export function parseAnswer(buffer, command) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return new GuardianError(ERROR_KINDS.PROTOCOL, 'Empty answer');
  }
  if (buffer.length > LIMITS.datagram) {
    return new GuardianError(ERROR_KINDS.PROTOCOL, 'Answer too big');
  }
  let json;
  try {
    json = JSON.parse(buffer.toString('utf8'));
  } catch {
    return new GuardianError(ERROR_KINDS.PROTOCOL, 'Answer is not JSON');
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return new GuardianError(ERROR_KINDS.PROTOCOL, 'Answer is not an object');
  }
  if (json.command !== command) {
    // Not the answer to this request: ignored (src: the caller keeps waiting).
    return undefined;
  }
  if (json.status === 'ok') {
    return json;
  }
  if (json.status === 'error') {
    const code = Number.isInteger(json.error_code) ? json.error_code : undefined;
    return new GuardianError(ERROR_KINDS.DEVICE, 'Refused by the controller', { sent: true, code });
  }
  return new GuardianError(ERROR_KINDS.PROTOCOL, 'Answer without a status');
}

/**
 * One request. `beforeSend()` runs right before the datagram leaves (after
 * the name is resolved and the socket connected): it may throw to send
 * nothing. Resolves the answer (`status: "ok"`); rejects a GuardianError
 * whose `sent` says whether the datagram may have left.
 */
export async function udpExchange({
  host,
  port,
  command,
  params = {},
  timeoutMs,
  signal,
  beforeSend,
  timers = globalThis,
  createSocket = dgram.createSocket,
}) {
  const started = performance.now();
  if (signal?.aborted) {
    throw new GuardianError(ERROR_KINDS.ABORTED, 'Aborted');
  }
  const { address, family } = await resolve(host, timeoutMs, signal, timers);
  if (unusableAddress(address, family)) {
    throw new GuardianError(ERROR_KINDS.ADDRESS, 'Broadcast, multicast or "any" address');
  }
  const left = timeoutMs - (performance.now() - started);
  const socket = createSocket({
    type: family === 6 ? 'udp6' : 'udp4',
    recvBufferSize: LIMITS.datagram,
  });
  let sent = false;
  let timer;
  let onAbort;
  let settled = false;
  try {
    return await new Promise((resolveAnswer, reject) => {
      const fail = (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
      timer = timers.setTimeout(
        () => fail(new GuardianError(ERROR_KINDS.TIMEOUT, 'No answer in time', { sent })),
        Math.max(0, left),
      );
      onAbort = () => fail(new GuardianError(ERROR_KINDS.ABORTED, 'Aborted', { sent }));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      // ECONNREFUSED (ICMP port unreachable), EHOSTUNREACH, ENETUNREACH...
      socket.on('error', (err) => {
        fail(
          new GuardianError(ERROR_KINDS.UNREACHABLE, `Socket error (${err.code ?? 'error'})`, {
            sent,
          }),
        );
      });
      socket.on('message', (message) => {
        if (settled) return;
        const answer = parseAnswer(message, command);
        if (answer === undefined) return;
        if (answer instanceof GuardianError) {
          answer.sent = true;
          fail(answer);
          return;
        }
        settled = true;
        resolveAnswer(answer);
      });
      socket.connect(port, address, () => {
        if (settled) return;
        try {
          beforeSend?.();
        } catch (err) {
          fail(
            Object.assign(new GuardianError(ERROR_KINDS.BEFORE_SEND, 'Not sent', { cause: err }), {
              beforeSend: true,
            }),
          );
          return;
        }
        if (settled) return;
        sent = true;
        const body = Buffer.from(JSON.stringify({ command, silent: true, ...params }));
        socket.send(body, (err) => {
          if (err) fail(new GuardianError(ERROR_KINDS.UNREACHABLE, 'Send failed', { sent }));
        });
      });
    });
  } finally {
    timers.clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    // The request ends once its socket is closed (never two at once).
    await new Promise((done) => {
      try {
        socket.close(() => done());
      } catch {
        done();
      }
    });
  }
}
