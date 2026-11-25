import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

export const GOOGLE_ENDPOINTS = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
}

const SIGN_IN_TIMEOUT = 10 * 60_000

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

function createLocalVault(dataDir, externalVault) {
  if (externalVault && typeof externalVault.canEncrypt === 'function' && externalVault.canEncrypt()) {
    return externalVault
  }
  const secretFile = path.join(dataDir, '.vault-key')
  const getKey = () => {
    try {
      if (fs.existsSync(secretFile)) {
        const raw = fs.readFileSync(secretFile)
        if (raw.length === 32) return raw
      }
    } catch {}
    const generated = crypto.randomBytes(32)
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(secretFile, generated, { mode: 0o600 })
    return generated
  }
  return {
    canEncrypt: () => true,
    encrypt: (plainText) => {
      const key = getKey()
      const iv = crypto.randomBytes(12)
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
      const enc = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return Buffer.concat([Buffer.from('sad1'), iv, tag, enc])
    },
    decrypt: (buf) => {
      const data = Buffer.from(buf)
      if (data.subarray(0, 4).toString('utf8') !== 'sad1') {
        throw new Error('Unbekanntes Schlüsselformat')
      }
      const key = getKey()
      const iv = data.subarray(4, 16)
      const tag = data.subarray(16, 32)
      const enc = data.subarray(32)
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
    },
  }
}

export function candidateSondraDirs(customDir = '') {
  const dirs = []
  if (customDir) dirs.push(path.resolve(customDir))
  if (process.env.SONDRA_SOURCE_DIR) dirs.push(path.resolve(process.env.SONDRA_SOURCE_DIR))
  const home = os.homedir()
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    dirs.push(path.join(appData, 'Sondra'))
    dirs.push(path.join(appData, 'Sondra Portabel'))
    dirs.push(path.join(localAppData, 'Sondra'))
  } else if (process.platform === 'darwin') {
    dirs.push(path.join(home, 'Library', 'Application Support', 'Sondra'))
  } else {
    dirs.push(path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Sondra'))
    dirs.push(path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'sondra'))
  }
  return [...new Set(dirs)]
}

function tryDecryptWindowsDpapiSondraToken(sondraDir) {
  const keyFile = path.join(sondraDir, 'google-drive-schluessel.bin')
  const localStateFile = path.join(sondraDir, 'Local State')
  if (!fs.existsSync(keyFile)) return null
  const rawBlob = fs.readFileSync(keyFile)

  if (rawBlob.subarray(0, 4).toString('utf8') === 'plain:') {
    return rawBlob.subarray(6).toString('utf8')
  }

  if (process.platform !== 'win32' || !fs.existsSync(localStateFile)) return null
  try {
    const localState = JSON.parse(fs.readFileSync(localStateFile, 'utf8'))
    const encKeyB64 = localState?.os_crypt?.encrypted_key
    if (!encKeyB64) return null
    const encKeyBytes = Buffer.from(encKeyB64, 'base64')
    if (encKeyBytes.subarray(0, 5).toString('ascii') !== 'DPAPI') return null
    const dpapiPayloadB64 = encKeyBytes.subarray(5).toString('base64')
    const psCmd =
      'Add-Type -AssemblyName System.Security; ' +
      `$b = [Convert]::FromBase64String('${dpapiPayloadB64}'); ` +
      '$u = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); ' +
      '[Convert]::ToBase64String($u)'
    const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
      encoding: 'utf8',
      timeout: 6000,
      windowsHide: true,
    })
    if (out.status !== 0 || !out.stdout?.trim()) return null
    const masterKey = Buffer.from(out.stdout.trim(), 'base64')
    if (masterKey.length !== 32) return null

    const prefix = rawBlob.subarray(0, 3).toString('ascii')
    if (prefix === 'v10' || prefix === 'v11') {
      const iv = rawBlob.subarray(3, 15)
      const tag = rawBlob.subarray(rawBlob.length - 16)
      const ciphertext = rawBlob.subarray(15, rawBlob.length - 16)
      const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    }
  } catch {}
  return null
}

export function detectLocalSondra(customDir = '') {
  for (const dir of candidateSondraDirs(customDir)) {
    if (!fs.existsSync(dir)) continue
    const dlSettingsFile = path.join(dir, 'herunterladen.json')
    const keyFile = path.join(dir, 'google-drive-schluessel.bin')
    const ytdlpBin = path.join(dir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
    const hasDlSettings = fs.existsSync(dlSettingsFile)
    const hasDriveKey = fs.existsSync(keyFile)
    const hasYtdlp = fs.existsSync(ytdlpBin)
    if (hasDlSettings || hasDriveKey || hasYtdlp || fs.existsSync(path.join(dir, 'sondra.log'))) {
      let dlSettings = {}
      if (hasDlSettings) {
        try {
          dlSettings = JSON.parse(fs.readFileSync(dlSettingsFile, 'utf8'))
        } catch {}
      }
      return {
        found: true,
        dataDir: dir,
        hasDriveKey,
        hasDlSettings,
        hasYtdlp,
        ytdlpPath: hasYtdlp ? ytdlpBin : null,
        cookies: dlSettings.cookies || null,
        bindAddress: dlSettings.bindAddress || null,
        downloadDir: dlSettings.downloadDir || null,
      }
    }
  }
  return { found: false, dataDir: null, hasDriveKey: false, hasDlSettings: false, hasYtdlp: false }
}

function answerHtml(ok, message) {
  return `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sondra AD · Google Drive</title><style>body{font:16px/1.55 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f8faf8;color:#0b4a22}p{max-width:34em;margin:24px}@media(prefers-color-scheme:dark){body{background:#0a110d;color:#a6ecb9}}</style><p>${message || (ok ? 'Sondra AD ist mit Google Drive verbunden. Sie können dieses Fenster schließen.' : 'Die Anmeldung bei Google hat nicht geklappt.')}</p></html>`
}

export function encryptPairingBundle(payloadObj, passphrase) {
  const secret = String(passphrase || '').trim()
  if (secret.length < 4) throw new Error('Bitte einen Kopplungscode mit mindestens 4 Zeichen angeben.')
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = crypto.pbkdf2Sync(secret, salt, 120_000, 32, 'sha256')
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(JSON.stringify(payloadObj), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `SONDRA-AD-PAIR-1.${Buffer.concat([salt, iv, tag, enc]).toString('base64url')}`
}

export function decryptPairingBundle(bundleStr, passphrase) {
  const trimmed = String(bundleStr || '').trim()
  if (!trimmed.startsWith('SONDRA-AD-PAIR-1.')) {
    throw new Error('Ungültiges Kopplungspaket.')
  }
  const secret = String(passphrase || '').trim()
  const raw = Buffer.from(trimmed.slice('SONDRA-AD-PAIR-1.'.length), 'base64url')
  if (raw.length < 45) throw new Error('Kopplungspaket ist unvollständig.')
  const salt = raw.subarray(0, 16)
  const iv = raw.subarray(16, 28)
  const tag = raw.subarray(28, 44)
  const enc = raw.subarray(44)
  const key = crypto.pbkdf2Sync(secret, salt, 120_000, 32, 'sha256')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  try {
    const json = Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
    return JSON.parse(json)
  } catch {
    throw new Error('Falscher Kopplungscode oder beschädigtes Paket.')
  }
}

export function createDriveAuth({
  dataDir,
  store,
  vault: externalVault,
  openExternal = null,
  onConnected = null,
  builtClientId = '',
  builtClientSecret = '',
  endpoints = GOOGLE_ENDPOINTS,
  fetchImpl = fetch,
}) {
  const vault = createLocalVault(dataDir, externalVault)
  const tokenFile = path.join(dataDir, 'google-drive-auth.bin')

  let authData = null
  let pendingSession = null

  const loadSaved = () => {
    try {
      if (fs.existsSync(tokenFile)) {
        const plain = vault.decrypt(fs.readFileSync(tokenFile))
        authData = JSON.parse(plain)
      }
    } catch {
      authData = null
    }
  }
  loadSaved()

  const persistAuth = () => {
    if (!authData) {
      fs.rmSync(tokenFile, { force: true })
      return
    }
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(tokenFile, vault.encrypt(JSON.stringify(authData)), { mode: 0o600 })
  }

  const resolveCredentials = () => {
    const cfg = store.getConfig()
    const clientId =
      cfg.googleClientId?.trim() ||
      process.env.SONDRA_GOOGLE_CLIENT_ID?.trim() ||
      process.env.GOOGLE_CLIENT_ID?.trim() ||
      builtClientId?.trim() ||
      authData?.clientId ||
      ''
    const clientSecret =
      cfg.googleClientSecret?.trim() ||
      process.env.SONDRA_GOOGLE_CLIENT_SECRET?.trim() ||
      process.env.GOOGLE_CLIENT_SECRET?.trim() ||
      builtClientSecret?.trim() ||
      authData?.clientSecret ||
      ''
    return { clientId, clientSecret }
  }

  const isConnected = () => {
    if (!authData) return false
    if (authData.refreshToken) return true
    if (authData.accessToken && authData.expiresAt && authData.expiresAt - 30_000 > Date.now()) return true
    return false
  }

  async function exchangeToken(fields, creds = resolveCredentials()) {
    const params = { client_id: creds.clientId, ...fields }
    if (creds.clientSecret) params.client_secret = creds.clientSecret
    const response = await fetchImpl(endpoints.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(20_000),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      const err = new Error(body.error_description || body.error || `HTTP ${response.status}`)
      err.code = body.error === 'invalid_grant' ? 'revoked' : 'failed'
      throw err
    }
    return body
  }

  async function fetchAccountProfile(accessToken) {
    try {
      const base = process.env.SONDRA_DRIVE_API_BASE || 'https://www.googleapis.com/drive/v3'
      const res = await fetchImpl(`${base}/about?fields=${encodeURIComponent('user(displayName,emailAddress)')}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) return null
      const data = await res.json()
      return {
        name: data?.user?.displayName || '',
        email: data?.user?.emailAddress || '',
      }
    } catch {
      return null
    }
  }

  async function getAccessToken(forceRefresh = false) {
    if (!authData) {
      const err = new Error('Google Drive ist nicht verbunden.')
      err.code = 'unauthorized'
      throw err
    }
    if (!forceRefresh && authData.accessToken && authData.expiresAt && authData.expiresAt - 60_000 > Date.now()) {
      return authData.accessToken
    }
    if (!authData.refreshToken) {
      const err = new Error('Die Sitzung bei Google Drive ist abgelaufen. Bitte erneut verbinden.')
      err.code = 'expired'
      throw err
    }
    try {
      const creds = {
        clientId: authData.clientId || resolveCredentials().clientId,
        clientSecret: authData.clientSecret ?? resolveCredentials().clientSecret,
      }
      const refreshed = await exchangeToken(
        {
          grant_type: 'refresh_token',
          refresh_token: authData.refreshToken,
        },
        creds,
      )
      authData = {
        ...authData,
        accessToken: refreshed.access_token,
        expiresAt: Date.now() + (Number(refreshed.expires_in) || 3600) * 1000,
      }
      persistAuth()
      return authData.accessToken
    } catch (error) {
      if (error.code === 'revoked') {
        authData = null
        persistAuth()
        store.events.emit('change', { type: 'drive-auth' })
      }
      throw error
    }
  }

  function closePending() {
    if (!pendingSession) return
    clearTimeout(pendingSession.timer)
    try {
      pendingSession.server?.close()
    } catch {}
    pendingSession = null
  }

  async function finalizeAnswer(answer, sessionInfo) {
    if (answer.error) {
      throw new Error(answer.error === 'access_denied' ? 'Zugriff bei Google abgelehnt.' : String(answer.error))
    }
    const creds = sessionInfo?.creds || resolveCredentials()
    if (answer.code) {
      const body = await exchangeToken(
        {
          grant_type: 'authorization_code',
          code: answer.code,
          redirect_uri: sessionInfo.redirectUri,
          ...(sessionInfo.verifier ? { code_verifier: sessionInfo.verifier } : {}),
        },
        creds,
      )
      const profile = await fetchAccountProfile(body.access_token)
      authData = {
        refreshToken: body.refresh_token || authData?.refreshToken || '',
        accessToken: body.access_token,
        expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        account: profile || authData?.account || null,
        connectedAt: Date.now(),
      }
      persistAuth()
      store.addLog({
        category: 'sync',
        title: 'Google Drive verbunden',
        message: profile?.email ? `Angemeldet als ${profile.email}` : 'Dauerhafte Anmeldung gespeichert.',
      })
      store.events.emit('change', { type: 'drive-auth' })
      return getStatus()
    }
    if (answer.access_token) {
      const profile = await fetchAccountProfile(answer.access_token)
      authData = {
        refreshToken: authData?.refreshToken || '',
        accessToken: answer.access_token,
        expiresAt: Date.now() + (Number(answer.expires_in) || 3600) * 1000,
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        account: profile || authData?.account || null,
        connectedAt: Date.now(),
      }
      persistAuth()
      store.addLog({
        category: 'sync',
        title: 'Google Drive verbunden',
        message: profile?.email ? `Angemeldet als ${profile.email}` : 'Zugangstoken übernommen.',
      })
      store.events.emit('change', { type: 'drive-auth' })
      return getStatus()
    }
    throw new Error('Keine gültige Google-Anmeldung empfangen.')
  }

  async function startAuthFlow({ openBrowser = false } = {}) {
    closePending()
    const creds = resolveCredentials()
    if (!creds.clientId || !creds.clientSecret) {
      throw new Error(
        'Google-Drive-Client (Typ „Desktop-App“) ist noch nicht hinterlegt. Bitte Client-ID und Client-Secret unten in den Einstellungen eintragen (oder in GitHub Actions als GOOGLE_CLIENT_ID und GOOGLE_CLIENT_SECRET hinterlegen).',
      )
    }

    const verifier = base64url(crypto.randomBytes(48))
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
    const state = base64url(crypto.randomBytes(16))

    const loopback = await new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        const u = new URL(req.url || '/', 'http://127.0.0.1')
        if (!u.searchParams.has('state') && !u.searchParams.has('code') && !u.searchParams.has('error')) {
          res.statusCode = 404
          res.end()
          return
        }
        const incomingState = u.searchParams.get('state')
        const error = u.searchParams.get('error')
        const code = u.searchParams.get('code')
        if (incomingState !== state || error || !code) {
          res.setHeader('content-type', 'text/html; charset=utf-8')
          res.end(answerHtml(false))
          closePending()
          return
        }
        try {
          await finalizeAnswer({ code, state: incomingState }, pendingSession)
          res.setHeader('content-type', 'text/html; charset=utf-8')
          res.end(answerHtml(true))
          try {
            onConnected?.()
          } catch {}
        } catch (err) {
          res.setHeader('content-type', 'text/html; charset=utf-8')
          res.end(answerHtml(false, err?.message))
        } finally {
          closePending()
        }
      })
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, port: server.address().port })
      })
    })

    const redirectUri = `http://127.0.0.1:${loopback.port}/`
    const authUrl = new URL(endpoints.auth)
    authUrl.search = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: DRIVE_SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: 'consent',
    }).toString()

    const timer = setTimeout(closePending, SIGN_IN_TIMEOUT)
    timer.unref?.()
    pendingSession = {
      state,
      verifier,
      redirectUri,
      creds,
      server: loopback.server,
      timer,
      authUrl: authUrl.toString(),
    }

    if (openBrowser && openExternal) {
      await openExternal(authUrl.toString())
    }
    return {
      authUrl: authUrl.toString(),
      redirectUri,
      mode: 'code_pkce',
      state,
    }
  }

  async function completeCallback(input) {
    let answer = input
    if (typeof input === 'string') {
      const trimmed = input.trim()
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        const u = new URL(trimmed)
        const frag = new URLSearchParams(u.hash.replace(/^#/, ''))
        const query = u.searchParams
        answer = {
          state: frag.get('state') || query.get('state'),
          code: query.get('code') || frag.get('code'),
          access_token: frag.get('access_token') || query.get('access_token'),
          expires_in: frag.get('expires_in') || query.get('expires_in'),
          scope: frag.get('scope') || query.get('scope'),
          error: frag.get('error') || query.get('error'),
        }
      } else if (trimmed.startsWith('ya29.')) {
        answer = { access_token: trimmed, expires_in: '3600' }
      } else {
        answer = { code: trimmed }
      }
    }
    if (pendingSession?.state && answer?.state && answer.state !== pendingSession.state) {
      throw new Error('Sicherheitsstatus (state) stimmt nicht mit der offenen Sitzung überein.')
    }
    const result = await finalizeAnswer(answer, pendingSession)
    closePending()
    return result
  }

  async function setDirectRefreshToken({ refreshToken, accessToken = '', expiresIn = 3600, clientId = '', clientSecret = '' }) {
    const creds = {
      clientId: clientId || resolveCredentials().clientId,
      clientSecret: clientSecret || resolveCredentials().clientSecret,
    }
    authData = {
      refreshToken: refreshToken || '',
      accessToken: accessToken || '',
      expiresAt: accessToken ? Date.now() + Number(expiresIn) * 1000 : 0,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      account: null,
      connectedAt: Date.now(),
    }
    if (refreshToken && !accessToken) {
      await getAccessToken(true)
    }
    const token = authData.accessToken
    if (token) {
      authData.account = await fetchAccountProfile(token)
    }
    persistAuth()
    store.events.emit('change', { type: 'drive-auth' })
    return getStatus()
  }

  async function importFromLocalSondra(customDir = '') {
    const detected = detectLocalSondra(customDir)
    if (!detected.found) {
      throw new Error('Keine lokale Sondra-Installation gefunden.')
    }
    const imported = {
      dataDir: detected.dataDir,
      settingsImported: false,
      driveTokenImported: false,
      ytdlpFound: detected.hasYtdlp,
    }
    const patch = {}
    if (detected.cookies) {
      patch.browserCookies = String(detected.cookies)
      imported.settingsImported = true
    }
    if (detected.bindAddress) {
      patch.bindAddress = String(detected.bindAddress)
      imported.settingsImported = true
    }
    if (Object.keys(patch).length > 0) {
      store.saveConfig(patch)
    }

    if (detected.hasDriveKey) {
      const decryptedRefresh = tryDecryptWindowsDpapiSondraToken(detected.dataDir)
      if (decryptedRefresh) {
        const creds = resolveCredentials()
        authData = {
          refreshToken: decryptedRefresh,
          accessToken: '',
          expiresAt: 0,
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          account: authData?.account || null,
          connectedAt: Date.now(),
        }
        try {
          const access = await getAccessToken(true)
          authData.account = await fetchAccountProfile(access)
          imported.driveTokenImported = true
        } catch {
          persistAuth()
          imported.driveTokenImported = Boolean(decryptedRefresh)
        }
        persistAuth()
        store.events.emit('change', { type: 'drive-auth' })
      }
    }

    const merkJsonPath = path.join(detected.dataDir, 'Sondra-Merkliste.sqlite')
    if (fs.existsSync(merkJsonPath)) {
      try {
        const { readSharedMerkliste, mergeShared } = await import('../shared/merklisteMerge.mjs')
        const parsed = readSharedMerkliste(new Uint8Array(fs.readFileSync(merkJsonPath)))
        if (parsed) {
          const merged = mergeShared(store.getMerkItems(), store.getMerkRemoved(), parsed)
          store.saveMerkliste(merged.items, merged.removed, parsed.appState)
          imported.merklisteImported = true
        }
      } catch {}
    }

    store.addLog({
      category: 'system',
      title: 'Mit lokaler Sondra-Installation verbunden',
      message: `Übernommen aus ${detected.dataDir}${imported.driveTokenImported ? ' (inkl. Google-Drive-Anmeldung)' : ''}.`,
    })
    return imported
  }

  function exportPairing(passphrase) {
    const cfg = store.getConfig()
    const payload = {
      v: 1,
      createdAt: Date.now(),
      auth: authData,
      config: {
        language: cfg.language,
        waitForPreferredLanguage: cfg.waitForPreferredLanguage,
        mode: cfg.mode,
        videoPref: cfg.videoPref,
        audioPref: cfg.audioPref,
        audioFormat: cfg.audioFormat,
        hosterPriority: cfg.hosterPriority,
        browserCookies: cfg.browserCookies,
        googleClientId: cfg.googleClientId,
        googleClientSecret: cfg.googleClientSecret,
      },
      cookiesTxt:
        cfg.cookiesFile && fs.existsSync(cfg.cookiesFile)
          ? fs.readFileSync(cfg.cookiesFile, 'utf8').slice(0, 200_000)
          : '',
    }
    return encryptPairingBundle(payload, passphrase)
  }

  async function importPairing(bundleStr, passphrase) {
    const payload = decryptPairingBundle(bundleStr, passphrase)
    if (payload.config && typeof payload.config === 'object') {
      store.saveConfig(payload.config)
    }
    if (payload.cookiesTxt) {
      const cookiesTarget = path.join(dataDir, 'cookies.txt')
      fs.writeFileSync(cookiesTarget, String(payload.cookiesTxt), { mode: 0o600 })
      store.saveConfig({ cookiesFile: cookiesTarget })
    }
    if (payload.auth && (payload.auth.refreshToken || payload.auth.accessToken)) {
      authData = {
        ...payload.auth,
        connectedAt: Date.now(),
      }
      persistAuth()
      try {
        const token = await getAccessToken(false)
        const profile = await fetchAccountProfile(token)
        if (profile) {
          authData.account = profile
          persistAuth()
        }
      } catch {}
      store.events.emit('change', { type: 'drive-auth' })
    }
    store.addLog({
      category: 'system',
      title: 'Sondra-Kopplungspaket importiert',
      message: authData?.account?.email
        ? `Verbunden mit Konto ${authData.account.email}.`
        : 'Einstellungen und Anmeldedaten übernommen.',
    })
    return getStatus()
  }

  async function disconnect() {
    closePending()
    const revokeTarget = authData?.refreshToken || authData?.accessToken
    authData = null
    persistAuth()
    if (revokeTarget) {
      await fetchImpl(endpoints.revoke, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: revokeTarget }).toString(),
        signal: AbortSignal.timeout(8_000),
      }).catch(() => {})
    }
    store.addLog({
      category: 'sync',
      title: 'Google Drive getrennt',
      message: 'Gespeicherte Anmeldung wurde entfernt.',
    })
    store.events.emit('change', { type: 'drive-auth' })
    return getStatus()
  }

  function getStatus() {
    const creds = resolveCredentials()
    return {
      configured: Boolean(creds.clientId && creds.clientSecret),
      hasClientSecret: Boolean(creds.clientSecret),
      connected: isConnected(),
      lasting: Boolean(authData?.refreshToken),
      expiresAt: authData?.expiresAt || null,
      account: authData?.account || null,
      pendingAuthUrl: pendingSession?.authUrl || null,
      localSondra: detectLocalSondra(),
    }
  }

  return {
    getStatus,
    isConnected,
    getAccessToken,
    startAuthFlow,
    completeCallback,
    setDirectRefreshToken,
    importFromLocalSondra,
    exportPairing,
    importPairing,
    disconnect,
  }
}
