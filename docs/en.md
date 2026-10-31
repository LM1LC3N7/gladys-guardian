# Guardian (Elexa) for Gladys

Shows your **Guardian valve controller** (Elexa, GVC1) and the **leak
sensors** paired with it in Gladys through its **local API** (UDP port 7777):
no Guardian cloud, straight on your network.

> **Never tested with a real device.** Not affiliated with Elexa. The
> integration follows aioguardian, the Guardian library of Home Assistant,
> and the captures of its tests. A firmware update may change the API.

> **The local API has no password.** Anyone on your network can open or
> close the valve with it, with or without Gladys. Keep the controller on a
> trusted network (no guest Wi-Fi, no port forwarding).

## What you get

One device per controller and one per paired leak sensor, keyed by the UID
the device gives (never by its IP address):

| Device           | Feature               | Content                                                           |
| ---------------- | --------------------- | ----------------------------------------------------------------- |
| Valve controller | Valve                 | Text: open, closed, opening, closing, stalled, halted mid-way...  |
| Valve controller | Valve open            | 1 open, 0 closed (unchanged while it moves or is in a fault)      |
| Valve controller | Close the valve       | Button, **always available**                                      |
| Valve controller | Open the valve        | Button, only with "Allow opening the valve"                       |
| Valve controller | Leak (onboard sensor) | 1 leak, 0 dry                                                     |
| Valve controller | Temperature           | °C (the controller gives °F, converted exactly: (F - 32) x 5 / 9) |
| Leak sensor      | Leak, Temperature     | As above                                                          |
| Leak sensor      | Battery               | %                                                                 |
| Leak sensor      | Moved                 | 1 when the sensor reports it was moved                            |

Each controller is read every 30 seconds by default (10 s to 1 h), one
request at a time. The onboard sensor, the list of the paired sensors (every
10 minutes), each sensor and the diagnostics (firmware, every 6 hours) are
secondary: when one does not answer, the valve is published anyway and the
status says "Not read: ...". A value is never published as 0 when it is
unknown; a value read more than 2 minutes ago is never sent as new.

The controller keeps the last values of each sensor; the API gives no date
for them: a sensor whose battery is dead may keep showing its last values.

## Installation

1. Give the controller a fixed IP address in your router.
2. In Gladys, install the integration and enter the IP address of the
   controller (optionally followed by a port, 7777 by default). Several
   controllers: their addresses separated by commas (8 at most).
3. Save, then add the devices from the **Discovery** tab.

The controller is never searched on the network: no broadcast, no multicast.

## Closing the valve (always)

"Close the valve" is the stop of this integration: it is never held back by
an option, a read or an open in progress (it ends them), a controller that
did not answer the last read, the configuration not read yet, or a slow
disk. It goes:

- to the address where that valve answered since the start;
- else to the address where it was last read before a restart (kept in
  `/data`);
- else to every configured address whose controller was never identified
  (the address you typed).

It is sent at once, then every 250 ms for 3 seconds while the controller does
not answer or answers that its valve is moving (it refuses any command while
the valve moves). Then it is **kept** in `/data` and checked every 15 seconds
(5 seconds while the valve closes), also after a restart, before Gladys even
gives the configuration, until a read shows the valve **closed**. It is sent
again while the valve stays open or in a fault. Each try that the controller
accepted counts: after 3 of them without effect, it is held (no more tries
until you click again) and the status asks you to check the valve. A silence,
an unreachable controller or a "moving" answer never counts.

The close is refused, nothing sent, in two cases only:

- no address is known at all (nothing configured, nothing in `/data`);
- every known address answers with another valve (another UID).

A close kept is let go only when: a read shows the valve closed; an open
clicked in Gladys (with the option) left; two reads in a row show the valve
opened again after it was seen closing (opened from the app or the button of
the controller); a read shows another controller at its address. Never by
time.

Gladys gets its answer within 3.5 seconds: success when the valve reads
closing or closed; otherwise the message says exactly what happened (sent
without an answer, not sent yet, refused, moving), and the close stays kept.

## Opening the valve (off by default)

"Allow opening the valve" is **off** by default: the button then refuses
every command. When it is on, an open is decided on a **fresh read** (never
on the values in memory) and refused when:

- the controller at the address is not the same one (UID), or cannot say;
- the valve moves, or is in a fault (stalled, motor spinning, halted, position
  unknown);
- the onboard sensor reads a leak, or cannot be read;
- a paired sensor that answers reads a leak (a sensor that does not answer
  does not block);
- a close of that controller is being sent (a close clicked after an open
  always wins: the open never leaves after it);
- the option is turned off before the datagram leaves;
- a close is kept for that valve and `/data` cannot be written (a restart
  would close it again);
- the controller does not answer in time (nothing sent after 2.7 s).

An open is confirmed only by a read back showing the valve opening or open;
otherwise "sent, without confirmation", and the valve is read again after 5
and 20 seconds. The integration never halts the valve (a halted Guardian no
longer reacts to its leak sensors).

## Status

The configuration screen shows, for each controller: its UID, the valve,
the number of paired sensors, a leak, the parts not read, and for each close
kept where it stands. "Test the connection" reads each controller once,
never sooner than the refresh interval.

## Limits

- Tested only against a fake controller built from aioguardian 2026.1.1 and
  its fixtures; never with a real device.
- No firmware update, Wi-Fi setup, pairing, reboot or factory reset from
  Gladys: use the Guardian app.
- The API has no authentication (see above).
