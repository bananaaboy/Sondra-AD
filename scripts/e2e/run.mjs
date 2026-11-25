import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'

process.env.SONDRA_TEST_ALLOW_LOCAL = '1'

import { createEngineServer } from '../../engine/httpServer.mjs'

function startE2EMockServer() {
  const driveFiles = new Map()
  let nextId = 1
  const payload = crypto.randomBytes(512 * 1024)

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url || '/', `http://${req.headers.host}`)
    const origin = `http://${req.headers.host}`

    if (u.pathname === '/drive/v3/about') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          user: { displayName: 'E2E Konto', emailAddress: 'e2e@sondra.local' },
          storageQuota: {
            limit: String(15 * 1024 ** 3),
            usage: String(2 * 1024 ** 3),
            usageInDrive: String(2 * 1024 ** 3),
            usageInDriveTrash: '0',
          },
        }),
      )
      return
    }

    if (u.pathname === '/drive/v3/files' && req.method === 'GET') {
      const q = u.searchParams.get('q') || ''
      const wantTrashed = q.includes('trashed = true')
      const parentMatch = q.match(/'([^']+)' in parents/)
      const nameMatch = q.match(/name = '([^']+)'/)
      const wantFolder = q.includes("mimeType = 'application/vnd.google-apps.folder'")
      const wantNotFolder = q.includes("mimeType != 'application/vnd.google-apps.folder'")

      const matched = [...driveFiles.values()].filter((f) => {
        if (Boolean(f.trashed) !== wantTrashed) return false
        if (parentMatch && !f.parents.includes(parentMatch[1])) return false
        if (nameMatch && f.name !== nameMatch[1]) return false
        if (wantFolder && f.mimeType !== 'application/vnd.google-apps.folder') return false
        if (wantNotFolder && f.mimeType === 'application/vnd.google-apps.folder') return false
        return true
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          files: matched.map((f) => ({
            id: f.id,
            name: f.name,
            size: String(f.data.byteLength),
            modifiedTime: f.modifiedTime,
            mimeType: f.mimeType,
            parents: f.parents,
            appProperties: f.appProperties,
          })),
        }),
      )
      return
    }

    if (u.pathname === '/drive/v3/files' && req.method === 'POST') {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const id = `f-${nextId++}`
      const rec = {
        id,
        name: body.name,
        mimeType: body.mimeType,
        parents: body.parents || ['root'],
        appProperties: body.appProperties || {},
        trashed: false,
        modifiedTime: new Date().toISOString(),
        data: Buffer.alloc(0),
      }
      driveFiles.set(id, rec)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id, name: rec.name, mimeType: rec.mimeType, parents: rec.parents }))
      return
    }

    const fidMatch = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/)
    if (fidMatch) {
      const f = driveFiles.get(decodeURIComponent(fidMatch[1]))
      if (!f) {
        res.writeHead(404)
        res.end('{}')
        return
      }
      if (req.method === 'GET' && u.searchParams.get('alt') === 'media') {
        res.writeHead(200, { 'content-type': f.mimeType })
        res.end(f.data)
        return
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: f.id, name: f.name, trashed: f.trashed, mimeType: f.mimeType, parents: f.parents }))
        return
      }
      if (req.method === 'DELETE') {
        driveFiles.delete(f.id)
        res.writeHead(204)
        res.end()
        return
      }
    }

    if (u.pathname.startsWith('/upload/drive/v3/files')) {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const raw = Buffer.concat(chunks)
      const existingMatch = u.pathname.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/)
      if (existingMatch) {
        const f = driveFiles.get(decodeURIComponent(existingMatch[1]))
        f.data = raw
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: f.id, name: f.name, size: String(raw.byteLength), mimeType: f.mimeType, parents: f.parents, appProperties: f.appProperties }))
        return
      }
      const ct = String(req.headers['content-type'] || '')
      const boundary = ct.match(/boundary=(.+)$/)?.[1]?.trim() || ''
      const sep = Buffer.from(`--${boundary}`)
      const firstIdx = raw.indexOf('\r\n\r\n')
      const metaEnd = raw.indexOf(sep, firstIdx)
      const meta = JSON.parse(raw.subarray(firstIdx + 4, metaEnd - 2).toString('utf8'))
      const secEnd = raw.indexOf('\r\n\r\n', metaEnd)
      const endBound = raw.lastIndexOf(Buffer.from(`\r\n--${boundary}--`))
      const data = Buffer.from(raw.subarray(secEnd + 4, endBound))
      const id = `f-${nextId++}`
      const rec = {
        id,
        name: meta.name,
        mimeType: meta.mimeType || 'video/mp4',
        parents: meta.parents || ['root'],
        appProperties: meta.appProperties || {},
        trashed: false,
        modifiedTime: new Date().toISOString(),
        data,
      }
      driveFiles.set(id, rec)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id, name: rec.name, size: String(data.byteLength), mimeType: rec.mimeType, parents: rec.parents, appProperties: rec.appProperties }))
      return
    }

    if (u.pathname === '/anime/stream/dandadan') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`
        <div class="series-title"><h1><span>Dandadan</span></h1></div>
        <a href="/anime/stream/dandadan/staffel-1">S1</a>
        <a href="/anime/stream/dandadan/staffel-1/episode-1">E1</a>
      `)
      return
    }

    if (u.pathname === '/anime/stream/dandadan/staffel-1/episode-1') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`
        <div class="series-title"><h1><span>Dandadan</span></h1></div>
        <ul><li class="episodeLink" data-lang-key="3" data-link-target="/redirect/1"><h4>Filemoon</h4></li></ul>
      `)
      return
    }

    if (u.pathname === '/redirect/1') {
      res.writeHead(302, { Location: `${origin}/filemoon/ep1` })
      res.end()
      return
    }

    if (u.pathname === '/filemoon/ep1') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<script>file: "${origin}/media/ep1.mp4"</script>`)
      return
    }

    if (u.pathname === '/media/ep1.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(payload.byteLength) })
      res.end(payload)
      return
    }

    res.writeHead(404)
    res.end()
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

async function runE2E() {
  if (!fs.existsSync('dist/index.html')) {
    throw new Error('dist/index.html fehlt. Zuerst `npm run build` ausführen.')
  }

  const mock = await startE2EMockServer()
  process.env.SONDRA_DRIVE_API_BASE = `${mock.baseUrl}/drive/v3`
  process.env.SONDRA_DRIVE_UPLOAD_BASE = `${mock.baseUrl}/upload/drive/v3`

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sondra-ad-e2e-'))
  const engine = await createEngineServer({
    rootDir: path.resolve('dist'),
    dataDir: workDir,
    port: 0,
    runtimeMode: 'server',
  })

  await engine.driveAuth.setDirectRefreshToken({
    refreshToken: 'e2e-refresh',
    accessToken: 'e2e-access',
    expiresIn: 3600,
  })

  let browser = null
  try {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } })
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    page.on('console', (msg) => {
      if (msg.type() === 'error') pageErrors.push(msg.text())
    })

    await page.goto(engine.url, { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Sondra")')

    const tabCount = await page.locator('[data-tab]').count()
    assert.equal(tabCount, 6)

    const driveBtnDots = await page.locator('header button:has-text("Drive") span.rounded-pill').count()
    assert.equal(driveBtnDots, 0)
    const headerStatusPills = await page.locator('header button:has-text("Aktiv"), header button:has-text("Pausiert")').count()
    assert.equal(headerStatusPills, 0)

    await page.click('[data-tab][data-panel="merkliste"]')
    await page.waitForSelector('h2:has-text("Merkliste")')

    await page.click('button:has-text("Serie hinzufügen")')
    await page.fill('dialog input[placeholder*="aniworld"]', `${mock.baseUrl}/anime/stream/dandadan`)
    await page.fill('dialog input[placeholder*="Frieren"]', 'Dandadan')
    await page.click('dialog button:has-text("Speichern & prüfen")')

    await page.waitForFunction(
      () => document.body.innerText.includes('Dandadan') && document.body.innerText.includes('1 in Drive'),
      null,
      { timeout: 15_000 },
    )

    await page.click('[data-tab][data-panel="warteschlange"]')
    await page.waitForSelector('h2:has-text("Warteschlange")')
    await page.waitForFunction(() => document.body.innerText.includes('Fertig'), null, { timeout: 10_000 })

    await page.click('[data-tab][data-panel="speicher"]')
    await page.waitForSelector('h2:has-text("Speicher & Archiv")')
    await page.click('button:has-text("Vorschau berechnen")')
    await page.waitForFunction(() => document.body.innerText.includes('Bereinigungs-Plan'), null, { timeout: 10_000 })

    await page.click('[data-tab][data-panel="protokoll"]')
    await page.waitForSelector('h2:has-text("Protokoll")')
    await page.waitForFunction(() => document.body.innerText.includes('Geladen: Dandadan'), null, { timeout: 10_000 })

    await page.click('[data-tab][data-panel="einstellungen"]')
    await page.waitForSelector('h2:has-text("Einstellungen")')

    await page.click('header button[aria-label^="Erscheinungsbild"]')
    await page.waitForTimeout(200)

    const webPage = await browser.newPage({ viewport: { width: 1366, height: 860 } })
    webPage.on('pageerror', (err) => pageErrors.push(err.message))
    webPage.on('console', (msg) => {
      if (msg.type() === 'error') pageErrors.push(msg.text())
    })

    await webPage.goto(`${engine.url}?web=1`, { waitUntil: 'networkidle' })
    await webPage.waitForSelector('h2:has-text("Sondra AD für Windows")')
    assert.equal(await webPage.locator('[data-site-tab]').count(), 4)
    await webPage.waitForSelector('text=Microsoft Store')
    await webPage.waitForSelector('text=Setup für Windows (.exe)')

    await webPage.click('a:has-text("Setup herunterladen")')
    await webPage.waitForSelector('dialog h3:has-text("Warum Windows warnt")')
    await webPage.click('dialog button:has-text("Abbrechen")')

    await webPage.click('[data-site-tab][data-panel="datenschutz"]')
    await webPage.waitForSelector('h2:has-text("Datenschutz")')

    await webPage.click('[data-site-tab][data-panel="lizenzen"]')
    await webPage.waitForSelector('h2:has-text("Lizenzen & Quellcode")')

    await webPage.click('[data-site-tab][data-panel="einrichtung"]')
    await webPage.waitForSelector('h2:has-text("Einrichtung & Hilfe")')
    await webPage.close()

    assert.deepEqual(pageErrors, [])
    console.log('Browser-E2E erfolgreich abgeschlossen (App-Modus ohne Drive-Indikator + Website mit Downloads, Store, Datenschutz & Lizenzen).')
  } finally {
    await browser?.close()
    await engine.close()
    await mock.close()
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}

await runE2E()
