// -----------------------------------------------------------------------------
// Opening the valve: off by default, decided on a fresh read, never against
// a leak, and the closes kept.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, SECOND } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { ALLOWED, ackError, setup, statusText } from './helpers/app.js';
import { SENSOR } from './helpers/fakeGuardian.js';

const OPEN = COMMANDS.VALVE_OPEN;
const CLOSE = COMMANDS.VALVE_CLOSE;

test('open: refused by default, nothing sent', async (t) => {
  const { dev, press } = await setup(t);
  dev.valve = 8;
  const outcome = await press('open');
  assert.match(ackError(outcome), /ouverture est désactivée/);
  assert.equal(dev.count(OPEN), 0);
});

test('open: refused for any value but a push', async (t) => {
  const { dev, press } = await setup(t, { config: ALLOWED });
  dev.valve = 8;
  const outcome = await press('open', 0);
  assert.match(ackError(outcome), /Valeur inattendue/);
  assert.equal(dev.count(OPEN), 0);
});

test('open with the option: a fresh read, the datagram, confirmed by the read back', async (t) => {
  const { dev, press, clock } = await setup(t, { config: ALLOWED });
  dev.valve = 8;
  const before = dev.requests.length;
  const start = clock.monotonic();
  const outcome = await press('open');
  assert.equal(ackError(outcome), undefined);
  assert.ok(clock.monotonic() - start < 3500);
  assert.deepEqual(
    dev.requests
      .slice(before)
      .map((r) => r.command)
      .slice(0, 5),
    [0, 16, 80, 51, OPEN],
  );
});

test('open: refused on a leak (onboard or paired), unknown leak, moving, fault', async (t) => {
  const { dev, press } = await setup(t, { config: ALLOWED });
  dev.valve = 8;
  dev.onboard.wet = true;
  assert.match(ackError(await press('open')), /capteur intégré détecte une fuite/);
  dev.onboard.wet = false;
  dev.sensors.get(SENSOR).wet = true;
  assert.match(ackError(await press('open')), /6309FB799CDE détecte une fuite/);
  dev.sensors.get(SENSOR).wet = false;
  dev.forge.set(COMMANDS.ONBOARD_SENSOR_STATUS, (a) => ({ ...a, data: { temperature: 70 } }));
  assert.match(ackError(await press('open')), /capteur de fuite intégré ne peut pas être lu/);
  dev.forge.delete(COMMANDS.ONBOARD_SENSOR_STATUS);
  dev.valve = 6;
  assert.match(ackError(await press('open')), /La vanne bouge/);
  dev.valve = 10;
  assert.match(ackError(await press('open')), /bloquée/);
  assert.equal(dev.count(OPEN), 0);
});

test('open: another controller at the address now: refused', async (t) => {
  const { dev, press } = await setup(t, { config: ALLOWED });
  dev.valve = 8;
  dev.uid = '998877665544';
  assert.match(ackError(await press('open')), /autre contrôleur/);
  assert.equal(dev.count(OPEN), 0);
});

test('open of an open valve: nothing sent', async (t) => {
  const { dev, press } = await setup(t, { config: ALLOWED });
  assert.equal(ackError(await press('open')), undefined);
  assert.equal(dev.count(OPEN), 0);
});

test('open: the option turned off between click and datagram stops it', async (t) => {
  const s = await setup(t, { config: ALLOWED });
  s.dev.valve = 8;
  s.dev.latencyMs = 200;
  const ack = s.send('open');
  await s.advance(100, 10);
  s.app.configUpdated({ addresses: '192.168.1.50' });
  await s.advance(5 * SECOND, 50);
  const result = await ack;
  assert.equal(result.success, false);
  assert.equal(s.dev.count(OPEN), 0);
});

test('an open that left lets the close kept go; one refused keeps it', async (t) => {
  const { dev, press, store, advance } = await setup(t, { config: ALLOWED });
  // A close refused by the controller: kept (sent again at each check).
  dev.refuse.set(CLOSE, 99);
  assert.match(ackError(await press('close')), /Fermeture refusée/);
  assert.equal(store.data.stops.length, 1);
  // An open refused by the controller: the close stays kept.
  dev.refuse.set(OPEN, 20);
  assert.match(ackError(await press('open')), /refusée par le contrôleur/);
  assert.equal(store.data.stops.length, 1);
  // An open that left ("already open" is an answer to it): the close is let go.
  dev.refuse.delete(OPEN);
  assert.equal(ackError(await press('open')), undefined);
  assert.equal(dev.count(OPEN), 2);
  assert.equal(store.data.stops.length, 0);
  // Never closed again by a check.
  dev.refuse.delete(CLOSE);
  const closes = dev.count(CLOSE);
  await advance(60 * SECOND, SECOND);
  assert.equal(dev.count(CLOSE), closes);
});

test('an open while a close is kept and /data cannot be written: nothing sent', async (t) => {
  const store = memoryStore();
  const { dev, press } = await setup(t, { config: ALLOWED, store });
  dev.silent = true;
  await press('close');
  dev.silent = false;
  dev.valve = 8;
  store.failSave = true;
  const outcome = await press('open');
  assert.match(ackError(outcome), /\/data ne peut pas être écrit/);
  assert.equal(dev.count(OPEN), 0);
});

test('the status says opening is off, and never shows an address typed wrong', async (t) => {
  const { gladys } = await setup(t, {
    config: { addresses: '192.168.1.50, http://x@y, 239.1.1.1' },
  });
  const text = statusText(gladys);
  assert.match(text, /Address 2, 3 of the list is not valid/);
  assert.doesNotMatch(text, /x@y|239\.1/);
  assert.match(text, /Opening the valve from Gladys is off/);
});
