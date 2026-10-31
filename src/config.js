// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. There is no
// secret: the local API of a Guardian has no password.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { DEFAULT_PORT, LIMITS, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  addresses: '',
  allow_valve_open: false,
  refresh_interval: POLL_INTERVAL.default,
  language: 'fr',
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** Addresses that are never one controller: "any", broadcast, multicast. */
export function unusableIpv4(host) {
  const [a, b, c, d] = host.split('.').map(Number);
  return (
    (a === 0 && b === 0 && c === 0 && d === 0) ||
    (a === 255 && b === 255 && c === 255 && d === 255) ||
    (a >= 224 && a <= 239)
  );
}

/**
 * One address typed by the user: an IPv4 address or a host name, with an
 * optional port (7777 by default).
 * @returns {{ host: string, port: number } | undefined} undefined when invalid.
 */
export function parseAddress(raw) {
  const text = String(raw ?? '')
    .trim()
    .toLowerCase();
  // Spaces and control characters (CR, LF...) are never part of an address.
  // eslint-disable-next-line no-control-regex
  if (text === '' || text.length > 260 || /[\s\u0000-\u001f\u007f]/.test(text)) {
    return undefined;
  }
  const match = text.match(/^([^:/@[\]]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  if (isIP(host) === 4) {
    return unusableIpv4(host) ? undefined : { host, port };
  }
  // Digits and dots only, and not an IPv4 address: a typo, never a name.
  if (/^[\d.]+$/.test(host)) {
    return undefined;
  }
  return host.split('.').every((label) => LABEL.test(label)) ? { host, port } : undefined;
}

/** The address as text: `host` alone on the default port. */
export const addressKey = ({ host, port }) => (port === DEFAULT_PORT ? host : `${host}:${port}`);

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

/** A whole number typed in the form, bounded; the default when missing or not a number. */
function bounded(value, { min, max, fallback }) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return fallback;
  }
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

/**
 * The addresses typed (comma, semicolon or space separated): the valid ones in
 * order, without duplicates, 8 at most; the positions of the invalid ones
 * (never their text: an entry the user typed is not shown back).
 */
export function parseAddresses(raw) {
  const text = typeof raw === 'string' ? raw : '';
  const entries = text
    .slice(0, 4000)
    .split(/[,;\s]+/)
    .map((e) => e.trim())
    .filter((e) => e !== '');
  const addresses = [];
  const invalid = [];
  for (const [i, entry] of entries.entries()) {
    const address = parseAddress(entry);
    if (!address) {
      invalid.push(i + 1);
    } else if (!addresses.some((a) => addressKey(a) === addressKey(address))) {
      addresses.push(address);
    }
  }
  return {
    addresses: addresses.slice(0, LIMITS.controllers),
    invalid,
    tooMany: addresses.length > LIMITS.controllers,
  };
}

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(DEFAULT_CONFIG, key) && value != null) {
      c[key] = value;
    }
  }
  const { addresses, invalid, tooMany } = parseAddresses(c.addresses);
  return {
    addresses,
    invalid,
    tooMany,
    allowOpen: strictTrue(c.allow_valve_open),
    interval:
      bounded(c.refresh_interval, {
        min: POLL_INTERVAL.min,
        max: POLL_INTERVAL.max,
        fallback: POLL_INTERVAL.default,
      }) * 1000,
    language: c.language === 'en' ? 'en' : 'fr',
  };
}
