import fs from 'node:fs'

/**
 * Erkennt das tatsächliche Containerformat anhand der ersten Bytes einer Datei.
 * Hoster liefern gern HLS-Segmente (MPEG-TS), HTML-Fehlerseiten oder eine
 * m3u8-Wiedergabeliste unter einer ".mp4"-Adresse aus. Solche Dateien kann weder
 * Google Drive („wird noch für die Wiedergabe verarbeitet“) noch ein Browser
 * abspielen, deshalb wird vor dem Hochladen geprüft, was wirklich in der Datei steckt.
 *
 * Rückgabe: 'mp4' | 'ts' | 'matroska' | 'webm' | 'mp3' | 'aac' | 'flac' | 'ogg' | 'wav'
 *           | 'html' | 'playlist' | 'text' | 'empty' | 'unknown'
 */
export function sniffMediaBuffer(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input ?? [])
  if (buf.length === 0) return 'empty'

  const ascii = (start, end) => buf.subarray(start, end).toString('latin1')

  if (buf.length >= 8) {
    const box = ascii(4, 8)
    if (['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'styp', 'moof', 'sidx', 'pnot'].includes(box)) return 'mp4'
  }

  if (buf[0] === 0x47) {
    const checks = [188, 376, 564].filter((o) => o < buf.length)
    if (checks.length > 0 && checks.every((o) => buf[o] === 0x47)) return 'ts'
  }

  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return ascii(0, Math.min(buf.length, 64)).includes('webm') ? 'webm' : 'matroska'
  }
  if (ascii(0, 3) === 'ID3') return 'mp3'
  if (ascii(0, 4) === 'fLaC') return 'flac'
  if (ascii(0, 4) === 'OggS') return 'ogg'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav'
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return 'aac'
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3'

  const head = buf.subarray(0, Math.min(buf.length, 1024)).toString('utf8').replace(/^﻿/, '').trimStart()
  if (head.startsWith('#EXTM3U')) return 'playlist'
  if (/^<(?:!doctype|html|head|body|\?xml|script|div|title)/i.test(head) || /<html[\s>]/i.test(head)) return 'html'

  const sample = buf.subarray(0, Math.min(buf.length, 512))
  let printable = 0
  for (const b of sample) {
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b < 0x7f)) printable += 1
  }
  if (sample.length > 0 && printable / sample.length > 0.97) return 'text'

  return 'unknown'
}

export function sniffMediaFile(filePath, bytes = 4096) {
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(bytes)
    const read = fs.readSync(fd, buf, 0, bytes, 0)
    return sniffMediaBuffer(buf.subarray(0, read))
  } catch {
    return 'unknown'
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {}
    }
  }
}

/** Inhalte, die sicher kein Video/Audio sind (Fehlerseite, Wiedergabeliste, leere Datei). */
export function isNonMediaKind(kind) {
  return kind === 'html' || kind === 'playlist' || kind === 'text' || kind === 'empty'
}

/** Passende Dateiendung für ein erkanntes Format (null = Endung beibehalten). */
export function extensionForKind(kind) {
  switch (kind) {
    case 'mp4':
      return null
    case 'ts':
      return 'ts'
    case 'matroska':
      return 'mkv'
    case 'webm':
      return 'webm'
    case 'flac':
      return 'flac'
    case 'ogg':
      return null
    case 'wav':
      return 'wav'
    default:
      return null
  }
}

/** Prüft, ob in einer MP4-Datei Fragment-Boxen (moof) auf oberster Ebene liegen. */
export function isFragmentedMp4(filePath, maxBoxes = 64) {
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    const size = fs.fstatSync(fd).size
    const header = Buffer.alloc(16)
    let offset = 0
    for (let i = 0; i < maxBoxes && offset + 8 <= size; i += 1) {
      const read = fs.readSync(fd, header, 0, 16, offset)
      if (read < 8) break
      let boxSize = header.readUInt32BE(0)
      const type = header.subarray(4, 8).toString('latin1')
      if (type === 'moof') return true
      if (boxSize === 1 && read >= 16) boxSize = Number(header.readBigUInt64BE(8))
      else if (boxSize === 0) break
      if (boxSize < 8) break
      offset += boxSize
    }
    return false
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {}
    }
  }
}
