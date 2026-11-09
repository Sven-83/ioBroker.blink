# CLAUDE.md – ioBroker.blink

## Projekt
ioBroker-Adapter für Blink-Kameras über die **inoffizielle** Blink-Cloud-API. Neufassung in TypeScript (nur Branch `main`, Historie am 09.11.2026 bereinigt), Plan und Vergleich im lokalen Arbeitsordner (`../PLAN.md`, `../VERGLEICH.md`), Spec in Claude-Specs `blink.md`.

- **Adaptername:** `blink` (ersetzt auf dem Pi den gleichnamigen Adapter von Pischleuder1)
- **Installation:** `iob url Sven-83/ioBroker.blink` aus `main`. Keine Releases, keine Tags, kein npm.
- **Autor-Mail** überall nur `276080681+Sven-83@users.noreply.github.com` (lokale git-Config gesetzt, pre-commit-Hook blockt andere Adressen). Die Historie ist bereinigt; alte Kopien mit der alten Historie nie pushen.
- **Sprache:** TypeScript strict, Node ≥ 22, js-controller ≥ 6.0.11, admin ≥ 7.6.20.

## Referenz
`../referenz/pischleuder1-ioBroker.blink` (MIT) dient als Wissensquelle für Endpunkte und Abläufe. Eigene Architektur, eigene Objektstruktur. Wird größerer Code übernommen: Herkunft im Dateikopf + Hinweis in README/LICENSE.

## Regeln (Audit-Template v1.5)
- Tokens per `this.encrypt()` in States, nie im Klartext, nie im Log (B.10).
- Eigene HTTP-Server standardmäßig aus bzw. `127.0.0.1`, Token-Pflicht, kein CORS `*`, **kein offener Proxy** (B.10.20).
- ffmpeg nur per `spawn` ohne Shell, Laufzeitlimit, Beenden in `onUnload` (B.10.21).
- Kamerabilder/Videos personenbezogen: Aufbewahrungsfrist, Weitergabe nur per Opt-in (B.10.22).
- Keine fremden Objekte anlegen (kein Skript im JavaScript-Adapter) (B.10.23).
- Befehle zurücklesen (Scharf 5/15 s), Busy-Cooldown pro Gerät, Batteriekameras schonen (B.11.16).
- Timer nur über `this.setTimeout`, verkettet, mit Jitter, exponentieller Backoff (B.11).
- `ack: true` nur durch den Adapter, nie `ack: false` setzen.
- Keine echten Daten in Tests/Fixtures (Seriennummern, IDs, Mail, Tokens, Bilder).
- Push nur nach OK von Sven und nur bei grünem Lint, Build und allen Tests.
