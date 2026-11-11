# ioBroker.blink – Deutsche Anleitung

[English](../../README.md)

ioBroker-Adapter für Blink-Kameras (Amazon). Er nutzt die inoffizielle Blink-Cloud-API, die sich ohne Ankündigung ändern kann.

> **Nicht das npm-Paket `iobroker.blink`.** Das ist ein anderer Adapter eines anderen Autors mit gleichem Namen und
> anderer Objektstruktur. Dieser Adapter ist eine komplette Neufassung in TypeScript und wird nur von GitHub
> installiert (siehe Installation).

## Funktionen
- Login mit PKCE und 2FA-Code (Instanz-Einstellungen oder `sendTo`); die Sitzung wird verschlüsselt gespeichert und
  automatisch erneuert, ohne Login-Schleifen
- Scharf/Unscharf je Netzwerk mit Rückmeldung: der Zustand wird erst bestätigt, wenn Blink ihn meldet
- „Ausgewählte Netzwerke scharf“ und „alle unscharf“
- Bewegungserkennung an/aus je Kamera mit Rückmeldung
- Snapshots im Dateispeicher der Instanz, Löschen nach einer Aufbewahrungsfrist
- Livebild (ffmpeg, MJPEG) – standardmäßig aus, nur lokal erreichbar, zufälliges Token je Sitzung
- Zeit, Auslöser und Erkennung des letzten Bewegungs-Clips; der letzte Clip je Kamera wird gespeichert und ist abspielbar
- Touch-Seite für den Web-Adapter mit allen Kameras nach Netzwerk
- Optionale Batteriewarnung über Telegram (nur Text)

## Voraussetzungen
- Ein Blink-Konto (E-Mail-Adresse und Passwort); für Bewegungs-Clips ein Blink-Abo
- js-controller ab 6.0.11, admin ab 7.6.20, Node.js ab 22
- ffmpeg für das Livebild (`apt install ffmpeg` unter Debian/Raspberry Pi OS)
- Der Web-Adapter für Kamera-Seite, Bilder und Clips

## Installation
Der Adapter steht nicht in den ioBroker-Repositories, und das gleichnamige npm-Paket ist ein anderer Adapter.
Installation von GitHub:
```bash
iob url https://github.com/Sven-83/ioBroker.blink
```
oder im Admin: *Adapter* → *Aus eigener URL installieren* → `https://github.com/Sven-83/ioBroker.blink`.

## Einstellungen
| Einstellung | Bedeutung |
|---|---|
| E-Mail-Adresse / Passwort | Blink-Konto (beide geschützt, das Passwort verschlüsselt gespeichert) |
| 2FA-Code | Nur wenn Blink einen Code schickt; er wird verschlüsselt gespeichert, einmal verwendet und dann gelöscht |
| Abfrageintervall | Sekunden, 30 bis 3600, Standard 60 |
| Bilder aufbewahren | Stunden, 1 bis 720, Standard 24. Bilder und Clips werden danach gelöscht |
| Livebild erlauben | Standardmäßig aus. Braucht ffmpeg; ein Livebild hält eine Batteriekamera wach |
| Adresse / Port des Livebilds | Standard `127.0.0.1:8766` (nur dieser Rechner). Für Anzeigen im Netzwerk die Adresse dieses Rechners eintragen |
| Zeitlimit eines Livebilds | Sekunden, 30 bis 600, Standard 120 |
| Pfad von ffmpeg | Leer: wird an den üblichen Stellen gesucht; sonst der absolute Pfad eines Programms namens ffmpeg |
| Batteriewarnung | Standardmäßig aus. Schickt je Kamera eine Textnachricht über eine Telegram-Instanz (Standard `telegram.0`), wenn Blink eine schwache Batterie meldet; erneut erst, wenn sie zwischendurch wieder gut war, und frühestens nach einem Tag. Keine Bilder. Der Knopf schickt eine Testnachricht |
| Empfänger | Telegram-Benutzernamen, durch Komma getrennt; leer: alle Benutzer der Instanz |

## Login und 2FA
1. E-Mail-Adresse und Passwort eintragen und speichern. Der Adapter meldet sich an.
2. Schickt Blink einen Code (SMS oder E-Mail), zeigt `info.loginState` den Wert `twoFactorRequired`. Innerhalb von 10 Minuten entweder
   - den Code in den Einstellungen (2FA-Code) eintragen und speichern, oder
   - ihn aus einem Skript senden: `sendTo('blink.0', 'verifyPin', { pin: '123456' }, res => log(JSON.stringify(res)));`
3. Neustarts fordern keinen neuen Code an, solange der Login wartet. Die Sitzung wird verschlüsselt gespeichert und automatisch erneuert.

## Datenpunkte
| Datenpunkt | Bedeutung |
|---|---|
| `info.connection` | Mit der Blink-Cloud verbunden |
| `info.loginState` | `ok`, `connecting`, `twoFactorRequired`, `twoFactorRejected`, `credentialsRejected` (keine weiteren Versuche, bis die Einstellungen geändert werden), `rateLimited`, `error` (neuer Versuch mit Backoff), `noConfig` |
| `info.lastPoll` | Zeit der letzten erfolgreichen Abfrage |
| `info.batteryWarnings` | Gesendete Batteriewarnungen (intern, nur mit eingeschalteter Batteriewarnung) |
| `auth.*` | Sitzung, wartender Login und Geräte-ID – verschlüsselt, nicht ändern |
| `networks.<id>.armed` | Scharf (`true`) oder unscharf (`false`); ack erst, wenn Blink den neuen Zustand meldet |
| `networks.<id>.armPending` / `armResult` | Befehl läuft / Ergebnis: `confirmed`, `rejected`, `unconfirmed` |
| `networks.<id>.armWithAll` | Das Netzwerk wird von `control.armSelected` scharf geschaltet. Eine Einstellung: bleibt, bis du sie änderst |
| `control.armSelected` | Taster: schaltet die ausgewählten Netzwerke scharf |
| `control.disarmAll` | Taster: schaltet alle Netzwerke unscharf |
| `syncModules.<id>.*` | Name, Netzwerk, Status, lokaler Speicher der Sync-Module |
| `cameras.<id>.enabled` | Bewegungserkennung an/aus; ack erst, wenn Blink es meldet (`motionPending`, `motionResult`) |
| `cameras.<id>.available` | `false`, wenn Blink das Gerät nicht mehr meldet; Geräte werden nie automatisch gelöscht |
| `cameras.<id>.batteryLow` / `batteryLevel` / `batteryVoltage` | Batterie, wie Blink sie meldet (nicht jedes Modell meldet jeden Wert) |
| `cameras.<id>.temperature` / `wifi` / `lfr` | Temperatur, WLAN-Balken, Signalbalken zum Sync-Modul |
| `cameras.<id>.snapshot` | Taster: neues Bild (`snapshotPending`, `snapshotResult`) |
| `cameras.<id>.image` / `imageTime` | Adresse des letzten Bildes im Dateispeicher (mit `?t=`, damit Browser es neu laden) / seine Zeit |
| `cameras.<id>.motionTime` / `motionSource` / `motionDetection` | Letzter Bewegungs-Clip: Zeit, Auslöser (`pir`, `cv_motion`), Erkennung (`person`, `animal`, `vehicle`, `package`, leer) |
| `cameras.<id>.clip` / `clipTime` | Adresse des gespeicherten letzten Clips (MP4) / seine Zeit; leer, wenn in der App gelöscht oder nach Ablauf der Frist |
| `cameras.<id>.liveActive` / `liveResult` | Livebild läuft / Stand der letzten Anfrage |

`cameras` enthält Kameras, Minis und Türklingeln; Werte, die ein Modell nicht meldet, werden nicht angelegt.

## Livebild
Das Livebild startet mit `sendTo('blink.0', 'liveStart', { cameraId })`. Die Antwort enthält Port und Pfad mit einem
zufälligen Token für diese Sitzung (nie in einem Datenpunkt oder im Log); `liveStop` beendet es. Es läuft immer nur
eine Sitzung; sie endet nach dem Zeitlimit, nach 20 s ohne Zuschauer oder nach 30 s ohne erstes Bild. Die
Kamera-Seite nutzt das.

## Kamera-Seite
Der Web-Adapter liefert eine Touch-Seite unter `http://<host>:<web-port>/blink/index.html`: alle Kameras nach Netzwerk,
Bilder mit Alter, Scharf/Unscharf, Bewegungserkennung, neues Bild, Livebild und letzter Clip.
- `?view=all` (Standard) zeigt alle Netzwerke auf einer Seite, `?view=tabs` ein Netzwerk je Reiter.
- `?pin=0_userdata.0.<pfad>` lässt das Unscharfschalten eine PIN abfragen, die ein Skript prüft: Die Seite schreibt
  `kameras:<Netzwerk-ID>` nach `<pfad>.pinZiel`, die Eingabe nach `<pfad>.pinEingabe` und zeigt `<pfad>.meldung`.
- Das Livebild braucht das eingeschaltete Livebild in den Einstellungen und eine Adresse, die der Browser erreicht
  (nicht `127.0.0.1`); es geht nur, wenn die Seite über http geöffnet ist.

## Sicherheit
Kameras zeigen private Bereiche, und Scharfschalten steuert eine Sicherheitsanlage. ioBroker-Admin und -Web nur mit
Anmeldung und HTTPS erreichbar machen. Bilder und Clips sind personenbezogene Daten: Sie bleiben im Dateispeicher der
Instanz und werden nach der Frist gelöscht; nur die optionale Batteriewarnung schickt Text an Telegram.
Schwachstellen bitte wie in [SECURITY.md](../../SECURITY.md) beschrieben melden.

## Bekannte Grenzen
- Die Blink-API ist inoffiziell und kann sich jederzeit ändern.
- Das Livebild hat etwa 2 s Verzögerung und etwa 10 Bilder pro Sekunde ohne Ton; es kann stocken.
- Die Erkennung (Person, Tier, …) hängt vom Blink-Abo und vom Kameramodell ab.
- Der Homescreen von Blink enthält oft keine Batteriespannung; `batteryLow` ist der verlässliche Wert.
- Pro Kamera wird nur der letzte Clip behalten, kein Archiv. Der lokale Speicher am Sync-Modul wird nicht genutzt.
- Türklingeln sind nach der API umgesetzt, aber nicht an einem echten Gerät getestet.

## Herkunft
Wissen über Login-Ablauf, Homescreen-Felder und die Pakete des Livebilds stammt aus Community-Clients, vor allem
[Pischleuder1/ioBroker.blink](https://github.com/Pischleuder1/ioBroker.blink) (MIT). Die betroffenen Dateien nennen
das im Kopfkommentar; der Copyright-Hinweis steht in [LICENSE](../../LICENSE).
