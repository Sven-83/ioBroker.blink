# ioBroker.blink

Dieser Adapter integriert Amazon Blink Kameras und Sicherheitssysteme in ioBroker.

Kompatible Kameras: siehe https://blinkforhome.com/

## Konfiguration

1. E-Mail-Adresse und Passwort des Blink-Kontos in den Adapter-Einstellungen eintragen
2. Adapter starten - er meldet sich automatisch bei Blink an
3. Falls 2FA erforderlich ist, wird eine SMS gesendet. PIN übermitteln per:
   ```javascript
   sendTo('blink.0', 'verifyPin', {pin: '123456'});
   ```

## Datenpunkte

### Netzwerke (`blink.0.networks.<netzwerkId>`)
| Datenpunkt | Typ | Beschreibung |
|------------|-----|--------------|
| name | string | Netzwerkname |
| armed | boolean | Scharf-Status (lesen/schreiben) |
| enabled | boolean | Netzwerk aktiv |

### Kameras (`blink.0.networks.<netzwerkId>.cameras.<kameraId>`)
| Datenpunkt | Typ | Beschreibung |
|------------|-----|--------------|
| name | string | Kameraname |
| online | boolean | Kamera online |
| batteryOk | boolean | Batterie OK (false = niedrig) |
| batteryPercent | number | Batteriestand (%) |
| temperatureC | number | Temperatur (°C) |
| motionAlert | boolean | Bewegungsalarm aktiv |
| thumbnail | string | Vorschaubild-URL |
| snapshot | button | Neues Snapshot auslösen |
| lastUpdated | string | Letzte Aktualisierung |
| wifiStrength | number | WLAN-Signalstärke (dBm) |

## Dashboard

Ein Web-Dashboard (`blink-dashboard.html`) ist enthalten. In den www-Ordner des Web-Adapters kopieren und unter `http://RASPBERRY-IP:PORT/blink-dashboard.html` aufrufen.

## Changelog

### 0.1.0
- Erstveröffentlichung mit OAuth2 PKCE Login, Live-Snapshots, Bewegungserkennung und Scharf-/Unscharf-Schaltung

## Lizenz

MIT Lizenz
