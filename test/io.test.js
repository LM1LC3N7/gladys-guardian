// -----------------------------------------------------------------------------
// The real I/O: the /data file (special files, links, sizes) and the UDP
// socket against a fake controller on 127.0.0.1 (oversize, foreign answers,
// silence, a refused port, abort, beforeSend).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dgram from 'node:dgram';
import { fileStore } from '../src/store.js';
import { ERROR_KINDS, parseAnswer, udpExchange } from '../src/guardian/udp.js';
import { fakeGuardian, udpServer } from './helpers/fakeGuardian.js';

async function dir(t) {
  const path = await mkdtemp(join(tmpdir(), 'guardian-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('/data: a round trip, 0600, no temporary left', async (t) => {
  const path = join(await dir(t), 'state.json');
  const store = fileStore(path);
  assert.deepEqual(await store.load(), { data: null });
  await store.save({ version: 1, stops: [] });
  assert.deepEqual(await store.load(), { data: { version: 1, stops: [] } });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(stat(`${path}.tmp`));
});

test('/data: a FIFO, a link, a big file, bad JSON are unreadable, at once', async (t) => {
  const base = await dir(t);
  const fifo = join(base, 'fifo.json');
  execFileSync('mkfifo', [fifo]);
  const start = performance.now();
  assert.deepEqual(await fileStore(fifo).load(), { unreadable: true });
  assert.ok(performance.now() - start < 1000, 'never a read that hangs');
  const target = join(base, 'target.json');
  await writeFile(target, '{"version":1}');
  const link = join(base, 'link.json');
  await symlink(target, link);
  assert.deepEqual(await fileStore(link).load(), { unreadable: true });
  const big = join(base, 'big.json');
  await writeFile(big, `"${'x'.repeat(70 * 1024)}"`);
  assert.deepEqual(await fileStore(big).load(), { unreadable: true });
  const bad = join(base, 'bad.json');
  await writeFile(bad, '{');
  assert.deepEqual(await fileStore(bad).load(), { unreadable: true });
});

test('/data: a FIFO in place of the temporary file fails the save at once', async (t) => {
  const base = await dir(t);
  const path = join(base, 'state.json');
  execFileSync('mkfifo', [`${path}.tmp`]);
  const start = performance.now();
  await assert.rejects(fileStore(path).save({ version: 1 }));
  assert.ok(performance.now() - start < 1000);
  await assert.rejects(readFile(path));
});

test('UDP: one request, one answer; the JSON the controller expects', async (t) => {
  const dev = fakeGuardian({ valve: 8 });
  const server = await udpServer(dev);
  t.after(() => server.close());
  const answer = await udpExchange({
    host: '127.0.0.1',
    port: server.port,
    command: 16,
    timeoutMs: 1000,
  });
  assert.equal(answer.data.state, 8);
  assert.deepEqual(dev.requests, [{ command: 16, params: {} }]);
  const sensor = await udpExchange({
    host: '127.0.0.1',
    port: server.port,
    command: 51,
    params: { uid: '6309FB799CDE' },
    timeoutMs: 1000,
  });
  assert.equal(sensor.data.battery_percentage, 79);
});

test('UDP: an error answer is a DEVICE error with its code, sent', async (t) => {
  const dev = fakeGuardian({ valve: 8 });
  const server = await udpServer(dev);
  t.after(() => server.close());
  await assert.rejects(
    udpExchange({ host: '127.0.0.1', port: server.port, command: 18, timeoutMs: 1000 }),
    (err) => err.kind === ERROR_KINDS.DEVICE && err.code === 18 && err.sent === true,
  );
});

test('UDP: an answer to another command is ignored, an oversize one refused', async (t) => {
  const dev = fakeGuardian();
  const other = await udpServer(dev, {
    raw: () => ({ command: 0, status: 'ok', data: { uid: 'X' } }),
  });
  t.after(() => other.close());
  await assert.rejects(
    udpExchange({ host: '127.0.0.1', port: other.port, command: 16, timeoutMs: 300 }),
    (err) => err.kind === ERROR_KINDS.TIMEOUT && err.sent === true,
  );
  const big = await udpServer(dev, {
    raw: (r) =>
      Buffer.from(JSON.stringify({ command: r.command, status: 'ok', pad: 'x'.repeat(5000) })),
  });
  t.after(() => big.close());
  await assert.rejects(
    udpExchange({ host: '127.0.0.1', port: big.port, command: 16, timeoutMs: 1000 }),
    (err) => [ERROR_KINDS.PROTOCOL, ERROR_KINDS.TIMEOUT].includes(err.kind),
  );
  assert.equal(parseAnswer(Buffer.alloc(5000, 32), 16).kind, ERROR_KINDS.PROTOCOL);
  assert.equal(parseAnswer(Buffer.from('[]'), 16).kind, ERROR_KINDS.PROTOCOL);
  assert.equal(parseAnswer(Buffer.from('{"command":16}'), 16).kind, ERROR_KINDS.PROTOCOL);
  assert.equal(parseAnswer(Buffer.from('{"command":"16","status":"ok"}'), 16), undefined);
});

test('UDP: an answer from another address never reaches the socket', async (t) => {
  // A server that answers from a second socket (another port): dropped by the kernel.
  const reply = dgram.createSocket('udp4');
  const listen = dgram.createSocket('udp4');
  await new Promise((r) => reply.bind(0, '127.0.0.1', r));
  listen.on('message', (m, rinfo) => {
    const request = JSON.parse(m);
    reply.send(
      JSON.stringify({ command: request.command, status: 'ok' }),
      rinfo.port,
      rinfo.address,
    );
  });
  await new Promise((r) => listen.bind(0, '127.0.0.1', r));
  t.after(() => {
    reply.close();
    listen.close();
  });
  await assert.rejects(
    udpExchange({ host: '127.0.0.1', port: listen.address().port, command: 0, timeoutMs: 300 }),
    (err) => err.kind === ERROR_KINDS.TIMEOUT,
  );
});

test('UDP: abort ends at once; beforeSend refusing sends nothing; broadcast refused', async (t) => {
  const dev = fakeGuardian();
  dev.silent = true;
  const server = await udpServer(dev);
  t.after(() => server.close());
  const controller = new AbortController();
  const pending = udpExchange({
    host: '127.0.0.1',
    port: server.port,
    command: 0,
    timeoutMs: 5000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  const start = performance.now();
  await assert.rejects(pending, (err) => err.kind === ERROR_KINDS.ABORTED && err.sent === true);
  assert.ok(performance.now() - start < 1000);
  const before = dev.requests.length;
  await assert.rejects(
    udpExchange({
      host: '127.0.0.1',
      port: server.port,
      command: 18,
      timeoutMs: 500,
      beforeSend: () => {
        throw new Error('no');
      },
    }),
    (err) => err.beforeSend === true && err.sent === false,
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(dev.requests.length, before);
  for (const host of ['255.255.255.255', '224.0.0.1', '0.0.0.0']) {
    await assert.rejects(
      udpExchange({ host, port: 7777, command: 18, timeoutMs: 500 }),
      (err) => err.kind === ERROR_KINDS.ADDRESS && err.sent === false,
    );
  }
});

test('UDP: a closed port is "unreachable"', async () => {
  const probe = dgram.createSocket('udp4');
  await new Promise((r) => probe.bind(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  await assert.rejects(
    udpExchange({ host: '127.0.0.1', port, command: 0, timeoutMs: 1000 }),
    (err) => err.kind === ERROR_KINDS.UNREACHABLE || err.kind === ERROR_KINDS.TIMEOUT,
  );
});
