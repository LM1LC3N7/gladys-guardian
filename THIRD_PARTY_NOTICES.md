# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`).

## aioguardian

The Guardian local API client (`src/guardian/udp.js`, `src/guardian/model.js`,
`src/constants.js`) ports parts of **aioguardian** 2026.1.1
(<https://github.com/bachya/aioguardian>, read at commit `92010cb` of
2026-01-26), the Python client of the Guardian valve controller used by Home
Assistant, to JavaScript: the JSON datagram to UDP port 7777 with `command`
and `silent`, the command codes (ping, diagnostics, valve status, open,
close, pair dump, paired sensor status, onboard sensor status), the
`error_code` values, the valve states 0 to 12 and the fields of the answers.
Its test fixtures (`tests/fixtures/*_success_response.json`) are copied in
`test/fixtures/` and shaped the fake controller of the tests. No Python code
runs here and aioguardian is not a dependency. This port was modified:
written in JavaScript, one socket per request, every answer bounded in size
and time, only the answer echoing the command taken, no halt, no firmware
update, no Wi-Fi setting, no pairing, no reset.

Its license:

```
MIT License

Copyright (c) 2020-2025 Aaron Bach

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## gladys-rainmachine, gladys-warp-charger

`src/lane.js` and `src/publisher.js` are taken from gladys-warp-charger by way
of gladys-rainmachine, by the same author, under the same Apache License 2.0.

## gladys-testkit

`test/kit/` holds files of gladys-testkit (commit `f8f5301`), Apache License
2.0, by the same author: the virtual and real clocks of the tests.
