import fs from 'node:fs'

function buildAuthHeader(username, password) {
  if (!username && !password) return {}
  const token = Buffer.from(`${username || ''}:${password || ''}`, 'utf8').toString('base64')
  return { Authorization: `Basic ${token}` }
}

function joinWebdavUrl(baseUrl, ...segments) {
  const cleanBase = String(baseUrl || '').trim().replace(/\/+$/, '')
  const encoded = segments
    .flatMap((s) => String(s || '').split('/'))
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
  return encoded.length > 0 ? `${cleanBase}/${encoded.join('/')}` : cleanBase
}

async function ensureWebdavDir(baseUrl, dirSegments, authHeaders, signal) {
  const acc = []
  for (const seg of dirSegments) {
    acc.push(seg)
    const dirUrl = joinWebdavUrl(baseUrl, ...acc)
    const res = await fetch(dirUrl, {
      method: 'MKCOL',
      headers: authHeaders,
      signal,
    })
    if (!res.ok && res.status !== 405 && res.status !== 301 && res.status !== 409) {
      throw new Error(`WebDAV MKCOL fehlgeschlagen (${res.status}) für ${acc.join('/')}`)
    }
  }
}

export async function testWebdavConnection({ url, username = '', password = '', basePath = '/Sondra' } = {}) {
  const cleanUrl = String(url || '').trim()
  if (!cleanUrl) throw new Error('Keine WebDAV-URL angegeben.')
  const authHeaders = buildAuthHeader(username, password)
  const target = joinWebdavUrl(cleanUrl, basePath)
  const res = await fetch(target, {
    method: 'OPTIONS',
    headers: authHeaders,
  })
  if (res.status === 401 || res.status === 403) {
    throw new Error(`WebDAV-Anmeldung abgelehnt (HTTP ${res.status}).`)
  }
  if (!res.ok && res.status !== 404 && res.status !== 405) {
    throw new Error(`WebDAV nicht erreichbar (HTTP ${res.status}).`)
  }
  return { ok: true, status: res.status, url: target }
}

export async function uploadFileToWebdav({
  url,
  username = '',
  password = '',
  basePath = '/Sondra',
  segments = [],
  fileName,
  localFilePath,
  mime = 'video/mp4',
  signal,
} = {}) {
  const cleanUrl = String(url || '').trim()
  if (!cleanUrl) throw new Error('WebDAV-URL fehlt.')
  const authHeaders = buildAuthHeader(username, password)
  const baseParts = String(basePath || '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
  const dirSegments = [...baseParts, ...segments.map((s) => String(s || '').trim()).filter(Boolean)]

  await ensureWebdavDir(cleanUrl, dirSegments, authHeaders, signal)

  const targetUrl = joinWebdavUrl(cleanUrl, ...dirSegments, fileName)
  const data = fs.readFileSync(localFilePath)
  const res = await fetch(targetUrl, {
    method: 'PUT',
    headers: {
      ...authHeaders,
      'content-type': mime,
      'content-length': String(data.byteLength),
    },
    body: data,
    signal,
  })
  if (!res.ok && res.status !== 201 && res.status !== 204) {
    throw new Error(`WebDAV-Upload fehlgeschlagen (HTTP ${res.status}).`)
  }
  return {
    url: targetUrl,
    relPath: [...dirSegments, fileName].join('/'),
    size: data.byteLength,
  }
}

export async function deleteWebdavFile({ url, username = '', password = '', relPath } = {}) {
  const cleanUrl = String(url || '').trim()
  if (!cleanUrl || !relPath) return false
  const targetUrl = joinWebdavUrl(cleanUrl, relPath)
  const res = await fetch(targetUrl, {
    method: 'DELETE',
    headers: buildAuthHeader(username, password),
  })
  return res.ok || res.status === 404
}
