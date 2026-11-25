import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_USER_AGENT, detectPrimaryIpv4, isVirtualAdapterName } from '../api/extractors.js'
import { detectLocalSondra } from './driveAuth.mjs'

const YTDLP_RELEASES = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/'
const YTDLP_ASSET = { win32: 'yt-dlp.exe', darwin: 'yt-dlp_macos', linux: 'yt-dlp_linux' }[process.platform] ?? 'yt-dlp'
const YTDLP_OWN_NAME = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
const UPDATE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

export function listNetworkAdapters() {
  const nets = os.networkInterfaces()
  const list = []
  for (const [name, addrs] of Object.entries(nets)) {
    if (!addrs) continue
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
        list.push({ id: a.address, name: `${name} (${a.address})`, rawName: name, address: a.address })
      }
    }
  }
  list.sort((a, b) => Number(isVirtualAdapterName(a.rawName)) - Number(isVirtualAdapterName(b.rawName)))
  return [
    { id: 'default', name: 'Automatisch (System-Standard)', rawName: 'default', address: null },
    ...list,
  ]
}

export function resolveBindIpv4(chosen) {
  if (!chosen || chosen === 'default') return detectPrimaryIpv4()
  const active = listNetworkAdapters().some((a) => a.address === chosen)
  return active ? String(chosen) : detectPrimaryIpv4()
}

export function createMediaTools({ dataDir, store, fetchImpl = fetch }) {
  const ownYtdlp = path.join(dataDir, 'bin', YTDLP_OWN_NAME)
  let cachedYtdlp = null
  let cachedFfmpeg = undefined
  let cachedGpuEncoder = undefined
  let installingYtdlp = null

  function runProcess(bin, args, { timeoutMs = 120_000, signal, onStderrLine, onStdoutLine } = {}) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        return resolve({ code: -1, stdout: '', stderr: String(err?.message ?? err), missing: true })
      }
      let stdout = ''
      let stderr = ''
      let stdoutBuf = ''
      let stderrBuf = ''
      const timer = timeoutMs > 0 ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null
      const onAbort = () => child.kill('SIGTERM')
      if (signal) {
        if (signal.aborted) {
          child.kill('SIGTERM')
        } else {
          signal.addEventListener('abort', onAbort, { once: true })
        }
      }
      child.stdout.on('data', (chunk) => {
        const str = chunk.toString('utf8')
        stdout += str
        if (onStdoutLine) {
          stdoutBuf += str
          const lines = stdoutBuf.split(/[\r\n]+/)
          stdoutBuf = lines.pop() || ''
          for (const line of lines) if (line.trim()) onStdoutLine(line.trim())
        }
      })
      child.stderr.on('data', (chunk) => {
        const str = chunk.toString('utf8')
        stderr += str
        if (onStderrLine) {
          stderrBuf += str
          const lines = stderrBuf.split(/[\r\n]+/)
          stderrBuf = lines.pop() || ''
          for (const line of lines) if (line.trim()) onStderrLine(line.trim())
        }
      })
      child.on('error', (err) => {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve({ code: -1, stdout, stderr: String(err?.message ?? err), missing: err.code === 'ENOENT' })
      })
      child.on('close', (code) => {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve({ code: code ?? -1, stdout, stderr })
      })
    })
  }

  function ytdlpCandidates() {
    const list = [process.env.SONDRA_YTDLP, ownYtdlp]
    const localSondra = detectLocalSondra()
    if (localSondra.ytdlpPath) list.push(localSondra.ytdlpPath)
    if (process.platform === 'win32') {
      const local = process.env.LOCALAPPDATA || ''
      list.push(
        path.join(local, 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe'),
        path.join(local, 'Microsoft', 'WindowsApps', 'yt-dlp.exe'),
      )
    }
    return [...list.filter((p) => p && fs.existsSync(p)), 'yt-dlp']
  }

  async function locateYtdlp() {
    if (cachedYtdlp && (cachedYtdlp.bin === 'yt-dlp' || fs.existsSync(cachedYtdlp.bin))) {
      return cachedYtdlp
    }
    for (const candidate of ytdlpCandidates()) {
      const check = await runProcess(candidate, ['--version'], { timeoutMs: 15_000 })
      if (check.code === 0 && check.stdout.trim()) {
        cachedYtdlp = { bin: candidate, version: check.stdout.trim() }
        maybeAutoUpdateYtdlp()
        return cachedYtdlp
      }
    }
    return null
  }

  function maybeAutoUpdateYtdlp() {
    if (!cachedYtdlp || cachedYtdlp.bin !== ownYtdlp) return
    try {
      const age = Date.now() - fs.statSync(ownYtdlp).mtimeMs
      if (age < UPDATE_INTERVAL_MS) return
    } catch {
      return
    }
    void runProcess(ownYtdlp, ['-U'], { timeoutMs: 180_000 }).then((res) => {
      if (res.code === 0) {
        const now = new Date()
        try {
          fs.utimesSync(ownYtdlp, now, now)
        } catch {}
        cachedYtdlp = null
      }
    })
  }

  async function installYtdlp() {
    if (process.windowsStore) return null
    installingYtdlp ??= (async () => {
      store.addLog({
        category: 'system',
        title: 'yt-dlp wird eingerichtet',
        message: `Lade offizielle Version (${YTDLP_ASSET}) und prüfe SHA-256.`,
      })
      const sumsRes = await fetchImpl(`${YTDLP_RELEASES}SHA2-256SUMS`, { redirect: 'follow' })
      if (!sumsRes.ok) throw new Error(`Prüfsummen nicht erreichbar (${sumsRes.status})`)
      const sumsText = await sumsRes.text()
      const line = sumsText.split('\n').find((entry) => entry.trim().endsWith(` ${YTDLP_ASSET}`))
      const expected = line?.trim().split(/\s+/)[0]?.toLowerCase()
      if (!expected) throw new Error(`Keine Prüfsumme für ${YTDLP_ASSET} gefunden`)

      const binRes = await fetchImpl(`${YTDLP_RELEASES}${YTDLP_ASSET}`, { redirect: 'follow' })
      if (!binRes.ok) throw new Error(`yt-dlp Download fehlgeschlagen (${binRes.status})`)
      const bytes = Buffer.from(await binRes.arrayBuffer())
      const actual = createHash('sha256').update(bytes).digest('hex')
      if (actual !== expected) throw new Error('SHA-256-Prüfsumme von yt-dlp stimmt nicht überein.')

      fs.mkdirSync(path.dirname(ownYtdlp), { recursive: true })
      const partial = `${ownYtdlp}.partial`
      fs.writeFileSync(partial, bytes, { mode: 0o755 })
      fs.renameSync(partial, ownYtdlp)
      cachedYtdlp = null
      const found = await locateYtdlp()
      store.addLog({
        category: 'system',
        title: 'yt-dlp bereit',
        message: `Version ${found?.version || 'aktuell'} (${(bytes.length / 1e6).toFixed(1)} MB, SHA-256 geprüft).`,
      })
      return found
    })().finally(() => {
      installingYtdlp = null
    })
    return installingYtdlp
  }

  async function ensureYtdlp({ autoInstall = true } = {}) {
    const existing = await locateYtdlp()
    if (existing) return existing
    if (!autoInstall) return null
    try {
      return await installYtdlp()
    } catch (err) {
      store.addLog({
        category: 'system',
        level: 'warn',
        title: 'yt-dlp nicht verfügbar',
        message: String(err?.message ?? err),
      })
      return null
    }
  }

  function findFfmpeg() {
    if (cachedFfmpeg !== undefined) return cachedFfmpeg
    const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    const candidates = [
      process.env.SONDRA_FFMPEG,
      path.join(dataDir, 'bin', exe),
      ...(process.platform === 'win32'
        ? [
            path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
            path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin', 'ffmpeg.exe'),
          ]
        : []),
      exe,
    ].filter(Boolean)

    for (const bin of candidates) {
      try {
        const res = spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 4000, windowsHide: true })
        if (res.status === 0) {
          cachedFfmpeg = bin
          return bin
        }
      } catch {}
    }
    cachedFfmpeg = null
    return null
  }

  function detectGpuEncoder() {
    const bin = findFfmpeg()
    if (!bin) return null
    if (cachedGpuEncoder !== undefined) return cachedGpuEncoder
    try {
      const out = spawnSync(bin, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 4000, windowsHide: true })
      const text = String(out.stdout || '')
      for (const enc of ['h264_nvenc', 'h264_amf', 'h264_qsv']) {
        if (!text.includes(enc)) continue
        const probe = spawnSync(
          bin,
          ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=128x128:d=0.04', '-frames:v', '1', '-c:v', enc, '-f', 'null', '-'],
          { stdio: 'ignore', timeout: 3500, windowsHide: true },
        )
        if (probe.status === 0) {
          cachedGpuEncoder = enc
          return enc
        }
      }
    } catch {}
    cachedGpuEncoder = null
    return null
  }

  function buildCookieArgs(cfg) {
    if (cfg.cookiesFile && fs.existsSync(cfg.cookiesFile)) {
      return ['--cookies', cfg.cookiesFile]
    }
    if (cfg.browserCookies) {
      return ['--cookies-from-browser', String(cfg.browserCookies)]
    }
    return []
  }

  async function listPlaylistEntries(url) {
    const tool = await ensureYtdlp({ autoInstall: true })
    if (!tool) return null
    const cfg = store.getConfig()
    const bind = resolveBindIpv4(cfg.bindAddress)
    const args = [
      '--flat-playlist',
      '-J',
      '--no-warnings',
      ...(bind ? ['--source-address', bind, '--force-ipv4'] : ['--force-ipv4']),
      '--user-agent',
      DEFAULT_USER_AGENT,
      ...buildCookieArgs(cfg),
      '--',
      url,
    ]
    const res = await runProcess(tool.bin, args, { timeoutMs: 90_000 })
    if (res.code !== 0 || !res.stdout) return null
    try {
      const parsed = JSON.parse(res.stdout)
      if (!Array.isArray(parsed.entries)) return null
      return {
        title: parsed.title || 'Playlist',
        entries: parsed.entries
          .map((e, idx) => ({
            episode: idx + 1,
            title: e.title || `Folge ${idx + 1}`,
            url: e.url || (e.id ? `https://www.youtube.com/watch?v=${e.id}` : null),
          }))
          .filter((e) => Boolean(e.url)),
      }
    } catch {
      return null
    }
  }

  async function downloadViaYtdlp({
    url,
    outputPathNoExt,
    mode = 'video',
    videoPref = 'best',
    audioFormat = 'mp3',
    referer = null,
    onProgress = null,
    signal = undefined,
  }) {
    const tool = await ensureYtdlp({ autoInstall: true })
    if (!tool) throw new Error('yt-dlp ist nicht installiert oder konnte nicht geladen werden.')
    const cfg = store.getConfig()
    const bind = resolveBindIpv4(cfg.bindAddress)
    const ffmpegBin = findFfmpeg()
    const maxHeight =
      videoPref === '1080p'
        ? 1080
        : videoPref === '720p'
          ? 720
          : videoPref === '480p'
            ? 480
            : videoPref === '360p'
              ? 360
              : 0

    let formatExpr = 'bv*[vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b'
    if (mode === 'audio') {
      formatExpr = 'ba[ext=m4a]/ba/b'
    } else if (maxHeight > 0) {
      formatExpr = `bv*[height<=${maxHeight}][vcodec^=avc1]+ba[ext=m4a]/b[height<=${maxHeight}][ext=mp4]/bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]/b`
    }

    const args = [
      '--newline',
      '--no-playlist',
      '--no-warnings',
      ...(bind ? ['--source-address', bind, '--force-ipv4'] : ['--force-ipv4']),
      '--user-agent',
      DEFAULT_USER_AGENT,
      '--socket-timeout',
      '25',
      '--retries',
      '3',
      '--fragment-retries',
      '3',
      ...(referer ? ['--referer', referer] : []),
      ...(cfg.maxBandwidthKbps > 0 ? ['--limit-rate', `${cfg.maxBandwidthKbps}K`] : []),
      ...(ffmpegBin && ffmpegBin !== 'ffmpeg' && ffmpegBin !== 'ffmpeg.exe' ? ['--ffmpeg-location', ffmpegBin] : []),
      ...buildCookieArgs(cfg),
      '-f',
      formatExpr,
    ]

    if (mode === 'audio') {
      if (ffmpegBin && audioFormat && audioFormat !== 'original') {
        args.push('-x', '--audio-format', audioFormat === 'm4a' ? 'm4a' : audioFormat)
      }
    } else if (ffmpegBin) {
      args.push('--merge-output-format', 'mp4')
    }

    args.push('-o', `${outputPathNoExt}.%(ext)s`, '--', url)

    const parseLine = (line) => {
      const m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+~?\s*([\d.]+)([KMGTP]?i?B)(?:\s+at\s+([\d.]+)([KMGTP]?i?B)\/s)?(?:\s+ETA\s+(\d+:\d+(?::\d+)?))?/i)
      if (!m || !onProgress) return
      const pct = Math.min(100, Math.max(0, Number(m[1])))
      const unitMult = (u) => {
        const up = String(u || '').toUpperCase()
        if (up.startsWith('G')) return 1024 ** 3
        if (up.startsWith('M')) return 1024 ** 2
        if (up.startsWith('K')) return 1024
        return 1
      }
      const total = Math.round(Number(m[2]) * unitMult(m[3]))
      const loaded = Math.round((pct / 100) * total)
      const speedBps = m[4] ? Math.round(Number(m[4]) * unitMult(m[5])) : 0
      let etaSeconds = null
      if (m[6]) {
        const parts = m[6].split(':').map(Number)
        etaSeconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]
      }
      onProgress({ pct, loaded, total, speedBps, etaSeconds })
    }

    const res = await runProcess(tool.bin, args, {
      timeoutMs: 4 * 60 * 60_000,
      signal,
      onStdoutLine: parseLine,
      onStderrLine: parseLine,
    })

    if (res.code !== 0) {
      const errLine = res.stderr.trim().split('\n').pop() || `yt-dlp Fehlercode ${res.code}`
      throw new Error(errLine.slice(0, 240))
    }

    const dir = path.dirname(outputPathNoExt)
    const basePrefix = path.basename(outputPathNoExt) + '.'
    const created = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(basePrefix) && !name.endsWith('.part') && !name.endsWith('.ytdl'))
      .map((name) => path.join(dir, name))
      .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0]

    if (!created || !fs.existsSync(created)) {
      throw new Error('yt-dlp hat keine Ausgabedatei erzeugt.')
    }
    return created
  }

  async function remuxHlsWithFfmpeg({ m3u8Url, referer, outputFile, mode = 'video', audioFormat = 'mp3', signal }) {
    const bin = findFfmpeg()
    if (!bin) return false
    const headersArg = [
      `User-Agent: ${DEFAULT_USER_AGENT}`,
      ...(referer ? [`Referer: ${referer}`] : []),
    ].join('\r\n') + '\r\n'

    const args = ['-y', '-headers', headersArg, '-i', m3u8Url]
    if (mode === 'audio') {
      const fmt = audioFormat === 'original' ? 'm4a' : audioFormat
      if (fmt === 'mp3') args.push('-vn', '-c:a', 'libmp3lame', '-b:a', '192k')
      else if (fmt === 'opus') args.push('-vn', '-c:a', 'libopus', '-compression_level', '4', '-b:a', '160k')
      else if (fmt === 'flac') args.push('-vn', '-c:a', 'flac')
      else if (fmt === 'wav') args.push('-vn', '-c:a', 'pcm_s16le')
      else args.push('-vn', '-c:a', 'aac', '-b:a', '192k')
    } else {
      args.push('-c', 'copy', '-bsf:a', 'aac_adtstoasc')
    }
    args.push(outputFile)
    const res = await runProcess(bin, args, { timeoutMs: 3 * 60 * 60_000, signal })
    return res.code === 0 && fs.existsSync(outputFile) && fs.statSync(outputFile).size > 0
  }

  async function compressVideoForArchive({ inputFile, outputFile, maxHeight = 720, useGpu = true, signal }) {
    const bin = findFfmpeg()
    if (!bin) return false
    const gpu = useGpu ? detectGpuEncoder() : null
    const scaleFilter = `scale='min(1280,iw)':'min(${maxHeight},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`

    const runEncode = async (encoder) => {
      const args = [
        '-y',
        '-i',
        inputFile,
        '-vf',
        scaleFilter,
        '-c:v',
        encoder,
        ...(encoder === 'libx264' ? ['-preset', 'medium', '-crf', '26'] : ['-b:v', '1400k']),
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        outputFile,
      ]
      const res = await runProcess(bin, args, { timeoutMs: 2 * 60 * 60_000, signal })
      return res.code === 0 && fs.existsSync(outputFile) && fs.statSync(outputFile).size > 0
    }

    if (gpu) {
      const ok = await runEncode(gpu)
      if (ok) return true
    }
    return runEncode('libx264')
  }

  async function getToolsStatus() {
    const ytdlp = await locateYtdlp()
    const ffmpeg = findFfmpeg()
    const gpuEncoder = ffmpeg ? detectGpuEncoder() : null
    return {
      ytdlpAvailable: Boolean(ytdlp),
      ytdlpVersion: ytdlp?.version || null,
      ytdlpPath: ytdlp?.bin || null,
      ffmpegAvailable: Boolean(ffmpeg),
      ffmpegPath: ffmpeg || null,
      gpuEncoder,
      adapters: listNetworkAdapters(),
    }
  }

  return {
    locateYtdlp,
    ensureYtdlp,
    installYtdlp,
    findFfmpeg,
    detectGpuEncoder,
    listPlaylistEntries,
    downloadViaYtdlp,
    remuxHlsWithFfmpeg,
    compressVideoForArchive,
    getToolsStatus,
  }
}
