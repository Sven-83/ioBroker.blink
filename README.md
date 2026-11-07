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
