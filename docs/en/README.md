# ioBroker.blink

This adapter integrates Amazon Blink cameras and security networks into ioBroker.

Compatible cameras: see https://blinkforhome.com/

## Configuration

1. Enter your Blink account email and password in the adapter settings
2. Start the adapter - it will log into Blink automatically via OAuth2 PKCE
3. If 2FA is required, you will receive an SMS. Send the PIN via:
   ```javascript
   sendTo('blink.0', 'verifyPin', {pin: '123456'});
   ```

## States

### Networks (`blink.0.networks.<networkId>`)
| State | Type | Description |
|-------|------|-------------|
| name | string | Network name |
| armed | boolean | Armed state (read/write) |
| enabled | boolean | Network enabled |

### Cameras (`blink.0.networks.<networkId>.cameras.<cameraId>`)
| State | Type | Description |
|-------|------|-------------|
| name | string | Camera name |
| online | boolean | Camera online |
| batteryOk | boolean | Battery OK (false = low) |
| batteryPercent | number | Battery level (%) |
| temperatureC | number | Temperature (°C) |
| motionAlert | boolean | Motion alert active |
| thumbnail | string | Thumbnail URL |
| snapshot | button | Trigger new snapshot |
| lastUpdated | string | Last update time |
| wifiStrength | number | WiFi signal (dBm) |

## Dashboard

A web dashboard (`blink-dashboard.html`) is included. Copy it to the ioBroker web adapter www folder and access at `http://RASPBERRY-IP:PORT/blink-dashboard.html`.

## Security Notes

- Blink credentials are stored encrypted in ioBroker native config
- Enable authentication on the ioBroker web adapter (web.0) to protect the dashboard
- Tokens are automatically refreshed with exponential backoff on failure

## Changelog

### 0.1.0
- Initial release with OAuth2 PKCE login, live snapshots, motion detection and arm/disarm support

## License

MIT License
