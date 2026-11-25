const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const ID_LENGTH = 20
const ID_PATTERN = new RegExp(`^[${ALPHABET}]{${ID_LENGTH}}$`)
const NAME_MAX = 40
export const MESSAGE_MAX_AGE = 15 * 60_000
const CAPS_MAX = 16
const CAP_PATTERN = /^[a-z][a-z-]{0,23}$/

const subtle = () => globalThis.crypto.subtle
const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' }
const SIGNING = { name: 'ECDSA', hash: 'SHA-256' }

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}

function base32(bytes) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

function toBase64Url(bytes) {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text) {
  const plain = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4))
  const bytes = new Uint8Array(plain.length)
  for (let i = 0; i < plain.length; i += 1) bytes[i] = plain.charCodeAt(i)
  return bytes
}

const utf8 = (text) => new TextEncoder().encode(text)

function publicPart(jwk) {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }
}

export async function makeExportableKeys() {
  const pair = await subtle().generateKey(ALGORITHM, true, ['sign', 'verify'])
  const publicJwk = publicPart(await subtle().exportKey('jwk', pair.publicKey))
  const privateJwk = await subtle().exportKey('jwk', pair.privateKey)
  return { privateKey: pair.privateKey, publicJwk, privateJwk }
}

export async function importStoredKeys(privateJwk, publicJwk) {
  const privateKey = await subtle().importKey('jwk', privateJwk, ALGORITHM, false, ['sign'])
  return { privateKey, publicJwk: publicPart(publicJwk) }
}

export async function deviceIdOf(jwk) {
  const digest = new Uint8Array(await subtle().digest('SHA-256', utf8(canonical(publicPart(jwk)))))
  return base32(digest).slice(0, ID_LENGTH)
}

export const shortId = (id) => String(id || '').slice(0, 4)

export const isDeviceId = (value) => typeof value === 'string' && ID_PATTERN.test(value)

async function signValue(privateKey, value) {
  const { sig: _sig, ...rest } = value
  const signature = await subtle().sign(SIGNING, privateKey, utf8(canonical(rest)))
  return toBase64Url(new Uint8Array(signature))
}

async function verifyValue(jwk, value) {
  if (typeof value.sig !== 'string') return false
  try {
    const key = await subtle().importKey('jwk', publicPart(jwk), ALGORITHM, false, ['verify'])
    const { sig, ...rest } = value
    return await subtle().verify(SIGNING, key, fromBase64Url(sig), utf8(canonical(rest)))
  } catch {
    return false
  }
}

export function cleanName(name) {
  return String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
}

export function uniqueName(wanted, others) {
  const base = cleanName(wanted) || 'Sondra AD'
  const taken = new Set(others.map((name) => cleanName(name).toLocaleLowerCase('de')))
  if (!taken.has(base.toLocaleLowerCase('de'))) return base
  const stem = base.replace(/\s+\d+$/, '')
  for (let n = 2; ; n += 1) {
    const candidate = cleanName(`${stem.slice(0, NAME_MAX - 4)} ${n}`)
    if (!taken.has(candidate.toLocaleLowerCase('de'))) return candidate
  }
}

export async function signRecord(keys, fields) {
  const id = await deviceIdOf(keys.publicJwk)
  const unsigned = {
    v: 1,
    id,
    name: cleanName(fields.name) || 'Sondra AD',
    kind: fields.kind,
    platform: cleanName(fields.platform),
    key: keys.publicJwk,
    created: fields.created,
    seen: fields.seen,
    ...(fields.caps?.length ? { caps: [...fields.caps].sort() } : {}),
  }
  return { ...unsigned, sig: await signValue(keys.privateKey, unsigned) }
}

export async function checkRecord(raw) {
  if (!raw || typeof raw !== 'object') return null
  const record = raw
  if (record.v !== 1 || !isDeviceId(record.id) || !record.key || typeof record.key !== 'object') return null
  if (typeof record.name !== 'string' || cleanName(record.name) !== record.name || !record.name) return null
  if (record.kind !== 'windows' && record.kind !== 'android' && record.kind !== 'browser') return null
  if (typeof record.platform !== 'string' || !Number.isFinite(record.created) || !Number.isFinite(record.seen)) return null
  if (
    record.caps !== undefined &&
    (!Array.isArray(record.caps) ||
      record.caps.length > CAPS_MAX ||
      !record.caps.every((cap) => typeof cap === 'string' && CAP_PATTERN.test(cap)))
  ) {
    return null
  }
  if ((await deviceIdOf(record.key)) !== record.id) return null
  if (!(await verifyValue(record.key, record))) return null
  return record
}

export async function pickDevices(raws) {
  const best = new Map()
  for (const raw of raws) {
    const record = await checkRecord(raw)
    if (!record) continue
    const known = best.get(record.id)
    if (!known || record.seen > known.seen) best.set(record.id, record)
  }
  return [...best.values()].sort((a, b) => b.seen - a.seen)
}
