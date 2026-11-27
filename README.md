# Sondra AD

Automatischer Hintergrund-Downloader für die Merkliste von [Sondra](https://github.com/bananaaboy/Sondra). Läuft unterbrechungsfrei als Windows-App im System-Tray (mit Windows-Autostart und Standby-Schutz) oder ohne Fenster als Server-Dienst auf einem Laptop, Heimserver oder VPS.

Vite 7 · React 19 · TypeScript · Tailwind v4 · zustand · SQLite 3 · Electron · Node.js 22.

## Überblick

Sondra AD verbindet sich mit demselben `Sondra`-Ordner in Google Drive (`drive.file`), liest und synchronisiert `Sondra/Merkliste/Sondra-Merkliste.sqlite`, erkennt neu erschienene Staffeln und Episoden automatisch und lädt sie im Hintergrund herunter. Geladene Folgen landen fertig benannt und mit den passenden `appProperties` (`sondraSerie`, `sondraStaffel`, `sondraFolge`) direkt unter `Sondra/Serien/<Titel>/Staffel <n>/`, sodass sie in Sondra auf jedem Gerät sofort zum Abspielen bereitstehen.

| Reiter | Aufgabe |
|---|---|
| **Übersicht** | Laufzeitstatus, letzte und nächste Prüfung, verbundene Sondra-Geräte, aktive Downloads, Speicherbelegung und letzte Ereignisse |
| **Merkliste** | Serien aus `Sondra-Merkliste.sqlite`, Einzelprüfung, Hinzufügen neuer Serien sowie serienbezogene Regeln für Sprache, Modus und Vorausladen |
| **Kalender** | Derselbe Wochenkalender wie in Sondra: Sendetage Ihrer Serien und eigene Termine mit Uhrzeit, Wiederholung und Erinnerung – erinnert wird vom Hintergrunddienst, auch bei geschlossenem Fenster |
| **Warteschlange** | Laufende Downloads und Resumable-Uploads, Hoster-Wechsel, Sprach-Warteliste, Wiederholungszähler, Pause, Sofort-Wiederholung und manueller Link-Einwurf |
| **Speicher & Archiv** | Grenzwerte für Google Drive und lokale Datenträger, automatisches Löschen gesehener Folgen, Inaktivitäts-Regeln, Archiv-Verwaltung und Wiederherstellung |
| **Protokoll** | Durchsuchbares Ereignisprotokoll (`logs.jsonl`) für Downloads, Hoster-Fallbacks, Fehlversuche, Synchronisation, Speicherbereinigung und Archivierung |
| **Einstellungen** | Verbindung mit Sondra und Google Drive, Qualitäts- und Sprach-Grundeinstellungen, Hoster-Reihenfolge, Windows-Autostart, Benachrichtigungen und Server-Zugang |

## Verbindung mit Sondra & Google Drive

Sondra AD unterstützt drei Wege zur Anmeldung, damit sowohl lokale Windows-Rechner als auch entfernte Server ohne Bildschirm unkompliziert eingerichtet werden können:

1. **Übernahme aus einer lokalen Sondra-App:** Erkennt eine bestehende Installation unter `%APPDATA%\Sondra` automatisch und übernimmt Google-Drive-Anmeldung, `Sondra-Merkliste.sqlite`, Cookie-Quelle, Netzwerkadapter sowie vorhandene `yt-dlp`- und `ffmpeg`-Werkzeuge mit einem Klick.
2. **Direkte Anmeldung im Browser:** Öffnet den OAuth-PKCE-Ablauf lokal und speichert den Schlüssel verschlüsselt über die Betriebssystem-Schlüsselverwaltung.
3. **Mit anderem Gerät koppeln (`SONDRA-AD-PAIR-1.`):** Exportiert Anmeldung, Cookies und Grundeinstellungen auf dem Hauptrechner mit Passwort (PBKDF2-SHA256 + AES-256-GCM) zur direkten Übernahme auf einem Server oder zweiten Laptop — ganz ohne Browser auf dem Zielgerät.

Zusätzlich trägt sich Sondra AD mit einem ECDSA-P-256-signierten Geräteeintrag unter `Sondra/Geräte/` ein.

## Automatischer Download, Hoster-Fallback & Wiederholungen

- **Merklisten-Umfang:** Überwacht wahlweise Einträge mit Status `Am Schauen`, `Später` und `Fertig`. Erscheint bei einer bereits abgeschlossenen Serie online eine neue Staffel oder Zusatzfolge, wird sie automatisch erkannt und eingereiht.
- **Hoster-Reihenfolge:** Prüft bei AniWorld- und SerienStream-Episoden nacheinander `VOE`, `FileMoon`, `Vidmoly`, `Streamtape`, `Vidoza` und `Doodstream` (Reihenfolge frei anpassbar) sowie `yt-dlp` für weitere Quellen. Antwortet ein Hoster mit einem Fehler oder abgebrochenem Stream, wechselt Sondra AD sofort zum nächsten Spiegelserver.
- **Auf Wunschsprache warten:** Ist etwa `Deutsch Sub` oder `Deutsch Dub` gewählt, aber online bisher nur `Englisch Sub` verfügbar, verbleibt die Folge in der Sprach-Warteliste und wird bei den nächsten Prüfläufen geladen, sobald die Wunschsprache erscheint (optional mit Zeitgrenze für den Ausweich-Download).
- **Exponentielle Wiederholung:** Fehlgeschlagene Aufträge werden automatisch mit wachsendem Abstand erneut versucht und bei zurückkehrender Internetverbindung sofort wieder aufgenommen.
- **Zero-Footprint-Upload:** Im Standardmodus `Nur Google Drive` wird jede Folge in einem temporären Arbeitsordner vorbereitet, per wiederaufnehmbarem Chunk-Upload (HTTP 308) nach Google Drive übertragen und lokal unmittelbar danach gelöscht.

## Speicherbereinigung & Inaktivitäts-Archiv

Unter **Speicher & Archiv** lässt sich genau festlegen, ab wann Sondra AD Platz schafft:

- **Speicher-Grenzwerte:** Maximalbelegung des `Sondra`-Ordners in Google Drive (GB), minimal freizuhaltender Google-Drive-Speicher (GB) sowie minimaler lokaler Freispeicher (GB).
- **Lösch-Reihenfolge:** Zuerst wird der Papierkorb geleert, danach werden bereits als `gesehen` markierte Episoden ab der ältesten gelöscht (wobei pro Serie eine einstellbare Anzahl zuletzt gesehener Folgen erhalten bleibt). Ungesehene Episoden bleiben geschützt. Eine Vorschau zeigt vorab alle betroffenen Dateien.
- **Lange nicht genutzt:** Serien ohne Aktivität seit `X` Tagen (gemessen an `lastOpenedAt`, Schau-Historie und Dateiänderungsdatum) können automatisch nach `Sondra/Archiv/<Titel>/Staffel <n>/` verschoben, mit FFmpeg platzsparend auf `720p` oder `480p` verkleinert, aus Google Drive auf eine lokale Festplatte ausgelagert, für weitere Auto-Downloads pausiert oder nach einer zweiten Frist endgültig entfernt werden. Archivierte Folgen lassen sich jederzeit mit einem Klick nach `Sondra/Serien/` zurücklegen.

## Installation, Microsoft Store & Website

### Windows-App (Microsoft Store, Setup-`.exe` & Portabel)

Sondra AD ist hauptsächlich als eigenständige Windows-Anwendung konzipiert und wird in drei Fassungen gebaut:

- **Microsoft Store (`.appx` / MSIX):** Signiertes Store-Paket für Windows 10 und 11 (`Sondra-AD-Store-<Version>.appx` für `x64` und `Arm64`) ohne SmartScreen-Abfrage und mit automatischen Updates über den Store.
- **`Sondra-AD-Setup.exe`** (für Arm-Rechner: `Sondra-AD-Setup-arm64.exe`): Installiert Sondra AD unter `Programme`, legt Startmenü- und Desktop-Verknüpfungen an und startet auf Wunsch automatisch minimiert im System-Tray (`--minimized`). Stille Installation: `Sondra-AD-Setup.exe /S`.
- **`Sondra-AD-Portable.exe`** (für Arm-Rechner: `Sondra-AD-Portable-arm64.exe`): Startet ohne Installation und legt sämtliche Einstellungen, Datenbanken und Protokolle daneben im Ordner `Sondra-AD-Daten` ab.

Über die [Releases](https://github.com/bananaaboy/Sondra-AD/releases/latest) stehen die `.exe`-Pakete bereit; die MSIX-Pakete für das Partner Center entstehen bei jedem Lauf des `Desktop`-Workflows.

Die lokale Oberfläche nutzt Port `47210` (portabel: `47211`), sodass Sondra und Sondra AD problemlos gleichzeitig auf demselben Rechner laufen.

### Statische Website (`dist/`)

Wird das gebaute Verzeichnis `dist/` statisch ausgeliefert (etwa über Vercel, Cloudflare Pages oder GitHub Pages ohne lokalen Hintergrunddienst), zeigt Sondra AD automatisch die reine Informations- und Download-Website mit **Downloads** (Windows-Setup, Microsoft Store, Portabel, SmartScreen-Hinweis), **Datenschutz**, **Lizenzen** und **Einrichtung & Hilfe** an.

### Server-Modus (Windows, Linux, macOS)

Auf einem Server oder Laptop ohne Fenster startet Sondra AD direkt über Node.js 22:

```bash
npm ci
npm run build
npm start
```

Optionale Umgebungsvariablen für den Server-Betrieb:

| Variable | Bedeutung |
|---|---|
| `SONDRA_AD_PORT` | HTTP-Port der Oberfläche und API (Standard: `47210`) |
| `SONDRA_AD_HOST` | Bind-Adresse, z. B. `127.0.0.1` oder `0.0.0.0` im Heimnetz |
| `SONDRA_AD_DATA_DIR` | Pfad für Konfiguration, SQLite-Merkliste und Protokolle |
| `SONDRA_AD_ACCESS_TOKEN` | Zugriffsschlüssel für den geschützten Fernzugriff im Browser |
| `SONDRA_GOOGLE_CLIENT_ID` | Eigene Google-OAuth-Client-ID (Typ „Desktop-App“) |
| `SONDRA_GOOGLE_CLIENT_SECRET` | Zugehöriger Google-OAuth-Client-Schlüssel |

## Entwicklung & Prüfung

| Befehl | Beschreibung |
|---|---|
| `npm run dev` | Vite-Entwicklungsserver |
| `npm run typecheck` | TypeScript-Typprüfung ohne Dateiausgabe |
| `npm run build` | Produktionsbündel nach `dist/` bauen |
| `npm run verify` | Vollständige Funktionsprüfung (Tray-Icons, Store-Kacheln, SQLite-Merkliste, Kopplungspaket, Geräte-Signatur, Hoster-Fallback, Resumable-Upload, Staffel-Erkennung, Speicherbereinigung, Archiv) |
| `npm run verify:e2e` | Browser-End-to-End-Prüfung (App-Modus und statische Download-/Datenschutz-/Lizenz-Website) |
| `npm run build:desktop` | Windows-Installer (`NSIS`) und portable Fassung bauen |
| `node scripts/build-desktop.mjs --store` | MSIX-Paket für den Microsoft Store bauen |

## Lizenz

MIT — siehe [`LICENSE`](LICENSE) und [`public/lizenz.html`](public/lizenz.html). Datenschutzerklärung unter [`public/datenschutz.html`](public/datenschutz.html).
