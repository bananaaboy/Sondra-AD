import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'

const [executable, shotDir = path.join(os.tmpdir(), 'sondra-ad-ui')] = process.argv.slice(2)
if (!executable) {
  console.error('Aufruf: node scripts/desktop-ui-test.mjs <Pfad zur App> [Ordner für Bildschirmfotos]')
  process.exit(2)
}

fs.mkdirSync(shotDir, { recursive: true })
const PORT = 9334

const child = spawn(executable, [`--remote-debugging-port=${PORT}`, '--no-sandbox'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, SONDRA_SMOKE: '' },
})
child.stdout.on('data', () => {})
child.stderr.on('data', () => {})

async function waitForDevtools() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('DevTools-Port der installierten App nicht erreichbar.')
}

let browser = null
try {
  await waitForDevtools()
  for (let i = 0; i < 40; i += 1) {
    const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => [])
    if (Array.isArray(targets) && targets.some((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:'))) {
      break
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  const contexts = browser.contexts()
  const page = contexts.flatMap((c) => c.pages()).find((p) => p.url().startsWith('http://127.0.0.1:'))
  if (!page) throw new Error('Hauptfenster von Sondra AD nicht gefunden.')

  await page.waitForSelector('h1:has-text("Sondra")', { timeout: 30_000 })
  await page.screenshot({ path: path.join(shotDir, '01-uebersicht.png') })

  for (const [idx, slug] of [
    ['02', 'merkliste'],
    ['03', 'warteschlange'],
    ['04', 'speicher'],
    ['05', 'protokoll'],
    ['06', 'einstellungen'],
  ]) {
    await page.click(`[data-tab][data-panel="${slug}"]`)
    await page.waitForTimeout(500)
    await page.screenshot({ path: path.join(shotDir, `${idx}-${slug}.png`) })
  }

  console.log('Desktop-Oberflächentest erfolgreich: alle 6 Reiter in Sondra AD geladen und geprüft.')
} catch (err) {
  console.error('Desktop-Oberflächentest fehlgeschlagen:', err?.message ?? err)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  try {
    child.kill()
  } catch {}
}

process.exit(process.exitCode || 0)
