![Logo](admin/blink.png)

# ioBroker.blink

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Test and Release](https://github.com/Sven-83/ioBroker.blink/workflows/Test%20and%20Release/badge.svg)

German documentation: [docs/de/README.md](docs/de/README.md)

ioBroker adapter for Blink cameras (Amazon). It uses the unofficial Blink cloud API, which can change without notice.

> **Not the npm package `iobroker.blink`.** That package is a different adapter by another author with the same
> name and a different object structure. This adapter is a complete rewrite in TypeScript and is installed from
> GitHub only (see Installation).

### Features
- Login with PKCE and 2FA code (instance settings or `sendTo`); the session is stored encrypted and renewed
  automatically, without login loops
- Arm/disarm per network with readback: the state is confirmed only after Blink reports it
- "Arm selected networks" and "disarm all"
- Motion detection on/off per camera with readback
- Snapshots stored in the file storage of the instance, deleted after a retention period
- Live image (ffmpeg, MJPEG) - off by default, local access only, random token per session
- Time, source and detection of the last motion clip; the last clip of each camera is stored and can be played
- Touch page for the web adapter with all cameras grouped by network
- Optional battery warning through Telegram (text only)

### Requirements
- A Blink account (e-mail address and password); a Blink subscription for motion clips
- js-controller 6.0.11 or newer, admin 7.6.20 or newer, Node.js 22 or newer
- ffmpeg for the live image (`apt install ffmpeg` on Debian/Raspberry Pi OS)
- The web adapter for the camera page, images and clips

### Installation
The adapter is not listed in the ioBroker repositories, and the npm package of the same name is a different adapter.
Install it from GitHub:
```bash
iob url https://github.com/Sven-83/ioBroker.blink
```
or in Admin: *Adapters* → *Install from custom URL* → `https://github.com/Sven-83/ioBroker.blink`.

### Configuration
| Setting | Meaning |
|---|---|
| E-mail address / password | Blink account (both protected, the password is stored encrypted) |
| 2FA code | Only when Blink sends a code; it is stored encrypted, used once and then deleted |
| Polling interval | Seconds, 30 to 3600, default 60 |
| Keep images for | Hours, 1 to 720, default 24. Images and clips are deleted after this time |
| Allow live image | Off by default. Needs ffmpeg; a live image keeps a battery camera awake |
| Address / port of the live image | Default `127.0.0.1:8766` (this computer only). Enter the address of this computer for displays in your network |
| Time limit of a live image | Seconds, 30 to 600, default 120 |
| Path of ffmpeg | Empty: searched in the usual places; otherwise the absolute path of a program called ffmpeg |
| Battery warning | Off by default. Sends one text message per camera through a Telegram instance (default `telegram.0`) when Blink reports a low battery; again only after the battery was fine and at least a day later. No images. The button sends a test message |
| Receivers | Telegram user names separated by commas; empty: all users of the instance |

### Login and 2FA
1. Enter e-mail address and password and save. The adapter logs in.
2. If Blink sends a code (SMS or e-mail), `info.loginState` shows `twoFactorRequired`. Within 10 minutes either
   - enter the code in the settings (2FA code) and save, or
   - send it from a script: `sendTo('blink.0', 'verifyPin', { pin: '123456' }, res => log(JSON.stringify(res)));`
3. Restarts do not request a new code while the login is waiting. The session is stored encrypted and renewed automatically.

### States
| State | Meaning |
|---|---|
| `info.connection` | Logged in to the Blink cloud |
| `info.loginState` | `ok`, `connecting`, `twoFactorRequired`, `twoFactorRejected`, `credentialsRejected` (no further attempts until the settings change), `rateLimited`, `error` (retry with backoff), `noConfig` |
| `info.lastPoll` | Time of the last successful poll |
| `info.batteryWarnings` | Battery warnings sent (internal, only with the battery warning on) |
| `auth.*` | Session, pending login and device ID - encrypted, do not edit |
| `networks.<id>.armed` | Arm (`true`) or disarm (`false`); ack only after Blink reports the new state |
| `networks.<id>.armPending` / `armResult` | Command running / result: `confirmed`, `rejected`, `unconfirmed` |
| `networks.<id>.armWithAll` | The network is armed by `control.armSelected`. A setting: kept until you change it |
| `control.armSelected` | Button: arms the selected networks |
| `control.disarmAll` | Button: disarms all networks |
| `syncModules.<id>.*` | Name, network, status, local storage of the Sync Modules |
| `cameras.<id>.enabled` | Motion detection on/off; ack only after Blink reports it (`motionPending`, `motionResult`) |
| `cameras.<id>.available` | `false` if Blink no longer reports the device; devices are never deleted automatically |
| `cameras.<id>.batteryLow` / `batteryLevel` / `batteryVoltage` | Battery as reported by Blink (not every model reports every value) |
| `cameras.<id>.temperature` / `wifi` / `lfr` | Temperature, Wi-Fi bars, signal bars to the Sync Module |
| `cameras.<id>.snapshot` | Button: new image (`snapshotPending`, `snapshotResult`) |
| `cameras.<id>.image` / `imageTime` | Address of the last image in the file storage (with `?t=` so browsers reload it) / its time |
| `cameras.<id>.motionTime` / `motionSource` / `motionDetection` | Last motion clip: time, source (`pir`, `cv_motion`), detection (`person`, `animal`, `vehicle`, `package`, empty) |
| `cameras.<id>.clip` / `clipTime` | Address of the stored last clip (MP4) / its time; empty when deleted at Blink or after the retention period |
| `cameras.<id>.liveActive` / `liveResult` | Live image running / state of the last request |

`cameras` contains cameras, Minis and doorbells; values a model does not report are not created.

### Live image
The live image is started with `sendTo('blink.0', 'liveStart', { cameraId })`. The answer contains the port and the
path with a random token for this session (never in a state or the log); `liveStop` ends it. One session at a time;
it ends after the time limit, 20 s without a viewer or 30 s without a first image. The camera page uses this.

### Camera page
The web adapter serves a touch page at `http://<host>:<web port>/blink/index.html`: all cameras grouped by network,
images with their age, arm/disarm, motion detection, new image, live image and the last clip.
- `?view=all` (default) shows all networks on one page, `?view=tabs` one network per tab.
- `?pin=0_userdata.0.<path>` lets disarming ask for a PIN that a script checks: the page writes `kameras:<network id>`
  to `<path>.pinZiel` and the entry to `<path>.pinEingabe` and shows `<path>.meldung`.
- The live image needs the live image switched on in the settings and an address the browser can reach (not
  `127.0.0.1`); it only works when the page is opened via http.

### Security
Cameras show private areas, and arming controls a security system. Only make ioBroker admin and web reachable with
authentication and HTTPS. Images and clips are personal data: they stay in the file storage of the instance and are
deleted after the retention period; only the optional battery warning sends text to Telegram.
Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

### Known limitations
- The Blink API is unofficial and may change at any time.
- The live image has about 2 s delay and about 10 images per second without sound; it can stutter.
- Smart detection (person, animal, ...) depends on the Blink subscription and the camera model.
- The homescreen of Blink often has no battery voltage; `batteryLow` is the reliable value.
- Only the last clip per camera is kept; there is no archive. Local storage on the Sync Module is not used.
- Doorbells are implemented from the API but not tested on a real device.

## Credits
Knowledge of the login flow, the homescreen fields and the live stream packets comes from community clients, in
particular [Pischleuder1/ioBroker.blink](https://github.com/Pischleuder1/ioBroker.blink) (MIT). The files that use it
name it in their header; its copyright notice is in [LICENSE](LICENSE).

## Disclaimer
This project is not affiliated with, endorsed by or connected to Amazon or Blink. Blink is a trademark of its owners.
Use at your own risk.

## Changelog
<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### 0.1.0 (work in progress)
- Complete rewrite in TypeScript: new object structure, the open proxy of 0.0.x is gone
- Login with PKCE and 2FA (settings or sendTo), encrypted session, token refresh, no login loops
- Arm/disarm with readback, snapshots, live view (pinned certificate of the stream servers)
- Arm selected networks / disarm all, motion detection per camera with readback
- Camera page for the web adapter (overview of all networks or tabs, optional PIN for disarming)
- Motion time, detection and the last clip per camera, playable on the camera page
- Optional battery warning through Telegram (text only)
- Serial numbers are no longer stored as states; the 2FA code is stored encrypted

## License
MIT License

Copyright (c) 2026 Sven-83

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
