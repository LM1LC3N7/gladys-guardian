# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-31

### Added

- Guardian (Elexa) valve controllers read over their local UDP API (port
  7777, one to eight addresses; the Guardian cloud is never used): one device
  per controller and per paired leak sensor, keyed by their UID.
- Valve state (text, and open/closed), onboard leak sensor and temperature
  (°F converted exactly to °C); paired sensors: leak, temperature, battery,
  moved. The onboard sensor, the paired sensors and the diagnostics never
  hold the valve back.
- "Close the valve", never held back (no option, reads, an open in progress,
  the configuration not read, `/data` slow), kept in `/data` until seen
  closed, never given up before it left, never let go by time; held after 3
  accepted resends without effect, then sent again less and less often;
  following its valve (UID) when another valve answers at its address; a
  click that finds a close already moving the valve is answered as a close
  under way, and its datagram never waits for a check's.
- "Open the valve" behind "Allow opening the valve" (off by default), decided
  on a fresh read of the valve and of every paired sensor, refused on a leak
  or a sensor not read, a moving or faulty valve, or another controller at
  the address.
- "Test the connection" button, never reading sooner than the interval.

[Unreleased]: https://github.com/LM1LC3N7/gladys-guardian/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-guardian/releases/tag/v0.1.1
