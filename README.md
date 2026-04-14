# ioBroker.blink

[!\[License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Inoffizieller ioBroker-Adapter für Blink-Kameras. Liest alle Kameradaten aus und liefert Live-Snapshots.

\---

## Features / Funktionen

* Live-Snapshots (Base64-JPEG direkt im State, sowie URL)
* Batteriestatus, Temperatur, WLAN-Stärke
* Scharf-/Unscharf-Schaltung pro System (Network)
* Kamera ein-/ausschalten
* Letzte Video-Events
* Automatisches Token-Refresh
* 2-Faktor-Authentifizierung (2FA) Unterstützung

\---

## Installation

### Via GitHub (ioBroker Admin → Adapter → Von GitHub installieren)

1. ioBroker Admin öffnen → **Adapter** → GitHub-Symbol (oben rechts)
2. Tab **"Beliebig"**
3. URL eingeben: `https://github.com/Sven-83/ioBroker.blink`
4. **Installieren** klicken
5. Instanz anlegen und Konfiguration öffnen

### Manuell (SSH / Shell)

```bash
cd /opt/iobroker
npm install https://github.com/Sven-83/ioBroker.blink
iobroker add blink
```

\---

## Konfiguration

|Feld|Beschreibung|
|-|-|
|**E-Mail**|Blink-Account E-Mail|
|**Passwort**|Blink-Account Passwort|
|**2FA PIN**|Nach erstem Start: Blink schickt einen PIN per E-Mail. Diesen hier eintragen und Adapter neu starten. Danach kann das Feld leer bleiben.|
|**Data Polling Interval**|Wie oft Kameradaten abgerufen werden (Sekunden)|
|**Snapshot Interval**|Wie oft automatisch ein neuer Snapshot ausgelöst wird (0 = nur manuell)|

### 2FA (Zwei-Faktor-Authentifizierung)

Beim ersten Start sendet Blink eine E-Mail mit einem PIN-Code.

1. Adapter starten (ohne PIN)
2. PIN aus der Blink-E-Mail kopieren
3. PIN in der Adapterkonfiguration eintragen
4. Adapter neu starten

Der Token wird danach gespeichert und der PIN wird nicht mehr benötigt.

\---

## Datenpunkte / States

### System-Ebene

```
blink.0.networks.{networkId}.
  ├── name              – Systemname
  ├── armed             – Scharf (true/false) – beschreibbar!
  ├── enabled           – Aktiviert
  ├── networkId         – Interne ID
  ├── arm               – Button: Scharf schalten
  └── disarm            – Button: Unscharf schalten
```

### Kamera-Ebene

```
blink.0.networks.{networkId}.cameras.{cameraId}.
  ├── name              – Kameraname
  ├── enabled           – Kamera aktiviert
  ├── online            – Online-Status
  ├── battery           – Batterie (%)
  ├── batteryVoltage    – Batteriespannung (mV)
  ├── temperature       – Temperatur (°F)
  ├── temperatureC      – Temperatur (°C)
  ├── wifiStrength      – WLAN-Stärke (dBm)
  ├── serial            – Seriennummer
  ├── firmware          – Firmware-Version
  ├── type              – Kameratyp
  ├── status            – Statustext
  ├── motionAlert       – Bewegungserkennung aktiv
  ├── lastMotion        – Letzter Bewegungszeitpunkt
  ├── thumbnail         – Thumbnail-URL
  ├── thumbnailData     – Thumbnail als Base64-JPEG (data:image/jpeg;base64,...)
  ├── lastVideo         – URL des letzten Videos
  ├── lastVideoTime     – Zeitpunkt des letzten Videos
  ├── snapshot          – Button: Neuen Snapshot auslösen
  ├── enableCamera      – Button: Kamera einschalten
  ├── disableCamera     – Button: Kamera ausschalten
  └── lastUpdated       – Letzter Update-Zeitstempel
```

\---

## Snapshot in VIS / Dashboard anzeigen

Den State `thumbnailData` enthält ein vollständiges Base64-kodiertes JPEG-Bild.

**ioBroker VIS:**
Widget `Basic – HTML` mit folgendem Inhalt:

```html
<img src="{blink.0.networks.1.cameras.1.thumbnailData}" style="max-width:100%">
```

**Lovelace / Home Assistant über ioBroker:**
State direkt als `camera`-Entity einbinden.

\---

## sendTo – PIN per Skript eingeben

```javascript
sendTo('blink.0', 'verifyPin', { pin: '123456' }, (result) => {
    console.log(result); // { success: true }
});
```

Status abfragen:

```javascript
sendTo('blink.0', 'getStatus', {}, (result) => {
    console.log(result); // { connected: true, pinPending: false }
});
```

\---

## Hinweise

* Die Blink-API ist **inoffiziell** (Reverse-Engineering) und kann sich jederzeit ändern.
* Zu häufige Abfragen können zur Account-Sperrung führen. Empfohlen: ≥ 30 Sekunden Polling.
* Unterstützte Geräte: Blink Outdoor, Indoor, Mini, XT, XT2, Doorbell

## Lizenz / License

MIT © 2024

