// -----------------------------------------------------------------------------
// A fake Guardian valve controller, built from aioguardian 2026.1.1 (its
// commands, error codes, valve states and the fixtures of its tests): the
// answers have the shapes of `tests/fixtures/*_response.json`.
//
// The valve moves like a motorised ball valve: a close of an open valve goes
// start_closing (5), closing (6), finish_closing (7), closed (8) over
// `travelMs`; any command is refused with error 20 while it moves; a close of
// a closed valve answers error 18, an open of an open valve error 17.
//
// `network()` routes requests by `host:port` to fake controllers; its
// `exchange` has the contract of src/guardian/udp.js udpExchange (beforeSend,
// abort, timeout, `sent`), on the injected timers. `udpServer(dev)` serves a
// fake over real UDP on 127.0.0.1 for the tests of the real socket.
// -----------------------------------------------------------------------------

import dgram from 'node:dgram';
import { ERROR_KINDS, GuardianError } from '../../src/guardian/udp.js';

export const UID = 'ABCDEF123456';
export const SENSOR = '6309FB799CDE';
export const HOST = '192.168.1.50';
export const NOW = Date.UTC(2026, 9, 31, 10, 0, 0);

export function fakeGuardian({
  uid = UID,
  valve = 4,
  travelMs = 6000,
  sensors = [SENSOR],
  timers = globalThis,
} = {}) {
  const dev = {
    uid,
    valve,
    travelMs,
    timers,
    onboard: { temperature: 71, wet: false },
    sensors: new Map(
      sensors.map((s) => [
        s,
        {
          uid: s,
          codename: 'gld1',
          temperature: 68,
          wet: false,
          moved: true,
          battery_percentage: 79,
        },
      ]),
    ),
    latencyMs: 20,
    /** No answer at all (a controller off). */
    silent: false,
    /** Commands answered by nothing (lost answers), applied all the same. */
    dropAnswers: new Set(),
    /** Commands never received (lost requests). */
    lose: new Set(),
    /** command -> error_code answered instead (the command not applied). */
    refuse: new Map(),
    /** command -> extra ms before its answer. */
    delay: new Map(),
    /** command -> ms between the request and its datagram (a DNS lookup, connect). */
    preSend: new Map(),
    /** command -> function(answer) -> answer: to forge an answer. */
    forge: new Map(),
    /** Every request received: { command, params }. */
    requests: [],
    /** Every command sent to it, received or not (silent, lost). */
    sends: [],
    inFlight: 0,
    peak: 0,
    moveTimers: [],
    move(from, to, steps) {
      for (const t of dev.moveTimers) dev.timers.clearTimeout(t);
      dev.moveTimers = [];
      dev.valve = from;
      steps.forEach(([state, at]) => {
        dev.moveTimers.push(dev.timers.setTimeout(() => (dev.valve = state), at));
      });
      dev.moveTimers.push(dev.timers.setTimeout(() => (dev.valve = to), dev.travelMs));
    },
    moving: () => (dev.valve >= 1 && dev.valve <= 3) || (dev.valve >= 5 && dev.valve <= 7),
    /** Opens from the app or the button of the controller (not Gladys). */
    openElsewhere() {
      dev.move(1, 4, [
        [2, 300],
        [3, dev.travelMs - 300],
      ]);
    },
    count: (command) => dev.requests.filter((r) => r.command === command).length,
    /** The answer to one request (the shapes of the aioguardian fixtures), or null. */
    handle(command, params = {}) {
      dev.requests.push({ command, params });
      const ok = (data) => ({ command, status: 'ok', ...(data ? { data } : {}) });
      const error = (code) => ({ command, status: 'error', ...(code ? { error_code: code } : {}) });
      if (dev.refuse.has(command)) return error(dev.refuse.get(command));
      let answer;
      switch (command) {
        case 0:
          answer = ok({ uid: dev.uid });
          break;
        case 1:
          answer = ok({
            codename: 'gvc1',
            uid: dev.uid,
            uptime: 41,
            firmware: '0.20.9-beta+official.ef3',
            rf_modem_firmware: '4.0.0',
            available_heap: 34456,
          });
          break;
        case 16:
          answer = ok({
            enabled: false,
            direction: true,
            state: dev.valve,
            travel_count: 0,
            instantaneous_current: 0,
            instantaneous_current_ddt: 0,
            average_current: 34,
          });
          break;
        case 17:
          if (dev.valve === 4) answer = error(17);
          else if (dev.moving()) answer = error(20);
          else {
            dev.move(1, 4, [
              [2, 300],
              [3, dev.travelMs - 300],
            ]);
            answer = ok();
          }
          break;
        case 18:
          if (dev.valve === 8) answer = error(18);
          else if (dev.moving()) answer = error(20);
          else {
            dev.move(5, 8, [
              [6, 300],
              [7, dev.travelMs - 300],
            ]);
            answer = ok();
          }
          break;
        case 48:
          answer = ok({ pair_count: dev.sensors.size, paired_uids: [...dev.sensors.keys()] });
          break;
        case 51: {
          const s = dev.sensors.get(params.uid);
          answer = s ? { ...ok({ ...s }), silent: true } : { ...error(3), silent: true };
          break;
        }
        case 80:
          answer = ok({ ...dev.onboard });
          break;
        default:
          answer = error();
      }
      const forge = dev.forge.get(command);
      return forge ? forge(answer) : answer;
    },
  };
  return dev;
}

/** Fake controllers by `host:port` (7777 by default), one exchange of src/guardian/udp.js. */
export function network({ timers = globalThis } = {}) {
  const net = {
    devices: new Map(),
    add(dev, host = HOST, port = 7777) {
      dev.timers = timers;
      net.devices.set(`${host}:${port}`, dev);
      return dev;
    },
    async exchange({ host, port, command, params, timeoutMs, signal, beforeSend }) {
      if (signal?.aborted) throw new GuardianError(ERROR_KINDS.ABORTED, 'Aborted');
      const dev = net.devices.get(`${host}:${port}`);
      const pre = dev?.preSend.get(command) ?? 0;
      if (pre > 0) await new Promise((resolve) => timers.setTimeout(resolve, pre));
      if (signal?.aborted) throw new GuardianError(ERROR_KINDS.ABORTED, 'Aborted');
      try {
        beforeSend?.();
      } catch (err) {
        throw Object.assign(
          new GuardianError(ERROR_KINDS.BEFORE_SEND, 'Not sent', { cause: err }),
          {
            beforeSend: true,
          },
        );
      }
      const sent = true;
      dev?.sends.push(command);
      if (dev) {
        dev.inFlight += 1;
        dev.peak = Math.max(dev.peak, dev.inFlight);
      }
      let timer;
      let late;
      let onAbort;
      try {
        return await new Promise((resolve, reject) => {
          const fail = (err) => reject(err);
          timer = timers.setTimeout(
            () => fail(new GuardianError(ERROR_KINDS.TIMEOUT, 'No answer in time', { sent })),
            Math.max(0, timeoutMs),
          );
          onAbort = () => fail(new GuardianError(ERROR_KINDS.ABORTED, 'Aborted', { sent }));
          signal?.addEventListener('abort', onAbort, { once: true });
          if (!dev || dev.silent || dev.lose.has(command)) return;
          // Received (and applied) as it leaves; answered after the latency.
          const answer = dev.handle(command, params);
          late = timers.setTimeout(
            () => {
              if (signal?.aborted) return;
              if (!answer || dev.dropAnswers.has(command)) return;
              if (answer.command !== command) return;
              if (answer.status === 'ok') resolve(answer);
              else
                fail(
                  new GuardianError(ERROR_KINDS.DEVICE, 'Refused by the controller', {
                    sent,
                    code: answer.error_code,
                  }),
                );
            },
            dev.latencyMs + (dev.delay.get(command) ?? 0),
          );
        });
      } finally {
        timers.clearTimeout(timer);
        timers.clearTimeout(late);
        signal?.removeEventListener('abort', onAbort);
        if (dev) dev.inFlight -= 1;
      }
    },
  };
  return net;
}

/** Serves `dev` over real UDP on 127.0.0.1; `raw(buffer)` forges a datagram instead. */
export async function udpServer(dev, { raw } = {}) {
  const socket = dgram.createSocket('udp4');
  let inFlight = 0;
  socket.on('message', (message, rinfo) => {
    let request;
    try {
      request = JSON.parse(message.toString('utf8'));
    } catch {
      return;
    }
    inFlight += 1;
    dev.peak = Math.max(dev.peak, inFlight);
    setTimeout(() => {
      inFlight -= 1;
      if (dev.silent) return;
      const { command, silent: _silent, ...params } = request;
      const answer = raw ? raw(request) : dev.handle(command, params);
      if (!answer) return;
      const buffer = Buffer.isBuffer(answer) ? answer : Buffer.from(JSON.stringify(answer));
      socket.send(buffer, rinfo.port, rinfo.address);
    }, dev.latencyMs);
  });
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return {
    port: socket.address().port,
    close: () => new Promise((resolve) => socket.close(resolve)),
  };
}
