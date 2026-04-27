![Logo](admin/blink.png)

# ioBroker.blink

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![NPM version](https://img.shields.io/npm/v/iobroker.blink.svg)](https://www.npmjs.com/package/iobroker.blink)

ioBroker adapter for Amazon Blink cameras and security networks.

**Compatible cameras and devices:** see https://blinkforhome.com/

## Features

- OAuth2 PKCE login with 2FA SMS support
- Live snapshots (manual, on motion detection, weekly scheduled)
- Motion detection with automatic snapshot trigger
- Arm/disarm security networks
- Battery level monitoring
- WiFi signal strength monitoring
- Thumbnail image storage as files
- Exponential backoff on connection failures

## Installation

Install via ioBroker Admin interface or:
```bash
iobroker url https://github.com/Sven-83/ioBroker.blink
```

## Configuration

1. Enter your Blink account email and password
2. Start the adapter - it logs in automatically via OAuth2 PKCE
3. If Blink requires 2FA, you will receive an SMS PIN. Send it via:
   ```javascript
   sendTo('blink.0', 'verifyPin', {pin: '123456'});
   ```

## States

### Networks (`blink.0.networks.<networkId>`)
| State | Type | R/W | Description |
|-------|------|-----|-------------|
| name | string | R | Network name |
| armed | boolean | R/W | Armed state (true = armed) |
| enabled | boolean | R | Network enabled |

### Cameras (`blink.0.networks.<networkId>.cameras.<cameraId>`)
| State | Type | R/W | Description |
|-------|------|-----|-------------|
| name | string | R | Camera name |
| online | boolean | R | Camera online |
| batteryOk | boolean | R | Battery OK (false = low battery) |
| batteryPercent | number | R | Battery level (%) |
| temperatureC | number | R | Temperature (°C) |
| motionAlert | boolean | R | Motion alert active |
| thumbnail | string | R | Last thumbnail URL |
| snapshot | button | W | Trigger new snapshot |
| lastUpdated | string | R | Last update timestamp |
| wifiStrength | number | R | WiFi signal strength (dBm) |

## Dashboard

A web dashboard is included (`blink-dashboard.html`). Copy it to the ioBroker web adapter www folder:
```bash
cp blink-dashboard.html /opt/iobroker/node_modules/iobroker.web/www/
```
Then access at: `http://RASPBERRY-IP:8082/blink-dashboard.html`

**Security:** Enable authentication on the web adapter (Admin → Instances → web.0) to protect the dashboard from unauthorized access.

## Security

- Credentials and tokens are stored **encrypted** in ioBroker native config (`encryptedNative`)
- Tokens are protected from other adapters (`protectedNative`)
- OAuth2 with PKCE flow - no password sent to third parties
- Automatic token refresh with exponential backoff

## Changelog

### 0.1.0 (2026-04-26)
- Initial release with OAuth2 PKCE login
- Live snapshots on motion, manual trigger, weekly schedule
- Arm/disarm network support
- Battery and WiFi monitoring

## License

MIT License © 2026 Sven-83
