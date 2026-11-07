![Logo](admin/blink.png)

# ioBroker.blink

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **Work in progress:** complete rewrite in TypeScript (branch `ts-rewrite`). Not usable yet.
> **In Arbeit:** komplette Neufassung in TypeScript (Branch `ts-rewrite`). Noch nicht nutzbar.

[English](#english) | [Deutsch](#deutsch)

## English

ioBroker adapter for Blink cameras (Amazon). It uses the unofficial Blink cloud API, which can change without notice.

### Planned features
- Login with 2FA code in the instance settings
- Arm/disarm with readback (the state is confirmed only after Blink reports it)
- Snapshots stored in the adapter file storage
- Live view (ffmpeg) - off by default, local access only, token required
- Motion clips and smart detection (person, animal, vehicle, package)

### Installation
```bash
iob url https://github.com/Sven-83/ioBroker.blink
```
There are no npm releases; the adapter is installed from the `main` branch.

### Configuration
| Setting | Meaning |
|---|---|
| E-mail address / password | Blink account (the password is stored encrypted) |
| 2FA code | Only when Blink sends a code; it is used once and then deleted |
| Polling interval | Seconds, 30 to 3600, default 60 |

### Login and 2FA
1. Enter e-mail address and password and save. The adapter logs in.
2. If Blink sends a code (SMS or e-mail), `info.loginState` shows `twoFactorRequired`. Within 10 minutes either
   - enter the code in the settings (2FA code) and save, or
   - send it from a script: `sendTo('blink.0', 'verifyPin', { pin: '123456' }, res => log(JSON.stringify(res)));`
3. Restarts do not request a new code while the login is waiting. The session is stored encrypted and renewed automatically.

| State | Meaning |
|---|---|
| `info.connection` | Logged in to the Blink cloud |
| `info.loginState` | `ok`, `connecting`, `twoFactorRequired`, `twoFactorRejected`, `credentialsRejected` (no further attempts until the settings change), `rateLimited`, `error` (retry with backoff), `noConfig` |
| `auth.*` | Session, pending login and device ID - encrypted, do not edit |

### Security
Cameras show private areas. Only make ioBroker admin and web reachable with authentication and HTTPS.
Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Deutsch

ioBroker-Adapter für Blink-Kameras (Amazon). Er nutzt die inoffizielle Blink-Cloud-API, die sich ohne Ankündigung ändern kann.

### Geplante Funktionen
- Login mit 2FA-Code in den Instanz-Einstellungen
- Scharf/Unscharf mit Rückmeldung (der Zustand wird erst bestätigt, wenn Blink ihn meldet)
- Snapshots im Dateispeicher des Adapters
- Livebild (ffmpeg) - standardmäßig aus, nur lokal erreichbar, mit Token
- Bewegungs-Clips und Erkennung (Person, Tier, Fahrzeug, Paket)

### Installation
```bash
iob url https://github.com/Sven-83/ioBroker.blink
```
Es gibt keine npm-Releases; installiert wird aus dem Branch `main`.

### Einstellungen
| Einstellung | Bedeutung |
|---|---|
| E-Mail-Adresse / Passwort | Blink-Konto (das Passwort wird verschlüsselt gespeichert) |
| 2FA-Code | Nur wenn Blink einen Code schickt; er wird einmal verwendet und dann gelöscht |
| Abfrageintervall | Sekunden, 30 bis 3600, Standard 60 |

### Login und 2FA
1. E-Mail-Adresse und Passwort eintragen und speichern. Der Adapter meldet sich an.
2. Schickt Blink einen Code (SMS oder E-Mail), zeigt `info.loginState` den Wert `twoFactorRequired`. Innerhalb von 10 Minuten entweder
   - den Code in den Einstellungen (2FA-Code) eintragen und speichern, oder
   - ihn aus einem Skript senden: `sendTo('blink.0', 'verifyPin', { pin: '123456' }, res => log(JSON.stringify(res)));`
3. Neustarts fordern keinen neuen Code an, solange der Login wartet. Die Sitzung wird verschlüsselt gespeichert und automatisch erneuert.

| Datenpunkt | Bedeutung |
|---|---|
| `info.connection` | Mit der Blink-Cloud verbunden |
| `info.loginState` | `ok`, `connecting`, `twoFactorRequired`, `twoFactorRejected`, `credentialsRejected` (keine weiteren Versuche, bis die Einstellungen geändert werden), `rateLimited`, `error` (neuer Versuch mit Backoff), `noConfig` |
| `auth.*` | Sitzung, wartender Login und Geräte-ID - verschlüsselt, nicht ändern |

### Sicherheit
Kameras zeigen private Bereiche. ioBroker-Admin und -Web nur mit Anmeldung und HTTPS erreichbar machen.
Schwachstellen bitte wie in [SECURITY.md](SECURITY.md) beschrieben melden.

## Changelog
<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### 0.1.0 (work in progress)
- Complete rewrite in TypeScript: new object structure, the open proxy of 0.0.x is gone
- Login with PKCE and 2FA (settings or sendTo), encrypted session, token refresh, no login loops

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
