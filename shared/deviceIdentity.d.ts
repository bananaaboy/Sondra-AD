export type DeviceKind = 'windows' | 'android' | 'browser'

export interface DeviceRecord {
  v: 1
  id: string
  name: string
  kind: DeviceKind
  platform: string
  key: JsonWebKey
  created: number
  seen: number
  caps?: string[]
  sig: string
}

export interface DeviceKeys {
  privateKey: CryptoKey
  publicJwk: JsonWebKey
  privateJwk?: JsonWebKey
}

export function shortId(id: string): string
export function cleanName(name: string): string
export function uniqueName(wanted: string, others: string[]): string
export function makeExportableKeys(): Promise<DeviceKeys>
export function importStoredKeys(privateJwk: JsonWebKey, publicJwk: JsonWebKey): Promise<DeviceKeys>
export function deviceIdOf(jwk: JsonWebKey): Promise<string>
export function signRecord(keys: DeviceKeys, fields: Omit<DeviceRecord, 'v' | 'id' | 'key' | 'sig'>): Promise<DeviceRecord>
export function checkRecord(raw: unknown): Promise<DeviceRecord | null>
export function pickDevices(raws: unknown[]): Promise<DeviceRecord[]>
