export const APP_VERSION = '1.0.5'

export interface ReleaseNoteEntry {
  version: string
  date: string
  title: string
  items: string[]
}

export const RELEASE_NOTES: ReleaseNoteEntry[] = [
  {
    version: '1.0.5',
    date: '25.11.2026',
    title: 'Auto-Updater, Zeitfenster, Speicherziele & Wochenplan',
    items: [
      'Integrierter Auto-Updater für die Windows-Desktop-App samt Release Notes direkt in der App.',
      'Warteschlangen-Trigger „Danach herunterfahren“ direkt in der Warteschlange und im System-Tray.',
      'Download-Zeitfenster / Nachtmodus: nachts volle Leitung, tagsüber wahlweise drosseln oder pausieren.',
      'Ausstrahlungs-Wochenplan in der Merkliste (Liste | Wochenplan) mit eigenem Ausstrahlungstag je Serie.',
      'Handy-Push-Benachrichtigungen über Telegram, ntfy und Pushover zusätzlich zu Discord, inkl. Test-Meldung.',
      'Speicherbudget pro Serie (GB) und automatische Download-Pause bei knappem lokalen Speicher.',
      'Sprach-Prioritätsliste (z. B. Ger-Dub → Ger-Sub → Eng-Sub) mit optionalem Auto-Upgrade bestehender Folgen.',
      'Alternative Speicherziele: NAS/SMB-Netzwerkpfade, WebDAV (z. B. Nextcloud) und Jellyfin/Plex-Ordnerstruktur (Season 01).',
      'Erweitertes System-Tray-Menü mit Live-Fortschritt, Pause/Fortsetzen, Nach-Queue-Herunterfahren und Update-Prüfung.',
    ],
  },
  {
    version: '1.0.4',
    date: '25.11.2026',
    title: 'Geplantes Herunterfahren',
    items: [
      'Geplantes Herunterfahren, Energiesparmodus oder Ruhezustand zu einer wählbaren Uhrzeit.',
      'Optionale Wartezeit auf laufende Downloads & Uploads, tägliche Wiederholung und abbrechbarer 60-Sekunden-Countdown.',
    ],
  },
  {
    version: '1.0.3',
    date: '25.11.2026',
    title: 'Direkte Geräte-Kopplung statt QR-Code',
    items: [
      'QR-Code-Anmeldung entfernt und durch ein verschlüsseltes Kopplungspaket („Mit anderem Gerät koppeln“) ersetzt.',
    ],
  },
  {
    version: '1.0.2',
    date: '25.11.2026',
    title: 'Staffel-Regeln & aufgeräumte Einstellungen',
    items: [
      'Staffel-spezifische Download-Regeln pro Serie (ein/aus, ab/bis Folge, Maximalanzahl).',
      '„Alle abbrechen“-Button in der Warteschlange und neu gegliederte 4-Tab-Einstellungen.',
    ],
  },
  {
    version: '1.0.1',
    date: '25.11.2026',
    title: 'Google-Drive-Anmeldung über lokalen Rückruf',
    items: [
      'Google-OAuth auf RFC-8252-Loopback mit PKCE umgestellt, inklusive eingebetteter Desktop-App-Konfiguration.',
    ],
  },
  {
    version: '1.0.0',
    date: '24.11.2026',
    title: 'Erste Veröffentlichung',
    items: [
      'Automatischer Hintergrund-Downloader für die gemeinsame Sondra-Merkliste mit Google Drive, Speicher-Bereinigung und System-Tray.',
    ],
  },
]
