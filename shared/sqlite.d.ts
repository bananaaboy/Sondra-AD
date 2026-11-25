export type SqlValue = null | number | string | Uint8Array

export interface SqlTableDefinition {
  name: string
  createSql: string
  columns: string[]
}

export interface SqliteAppStateEntry {
  valueJson: string
  updatedAt: number
}

export interface SqliteMerklisteSnapshot<TItem = Record<string, unknown>> {
  items: TItem[]
  removed: Record<string, number>
  appState?: Record<string, SqliteAppStateEntry>
}

export const SONDRA_TABLES: Record<string, SqlTableDefinition>
export function isSqliteBytes(input: Uint8Array | string): boolean
export function coerceToSqliteBytes(input: Uint8Array | string): Uint8Array | null
export function sqliteBytesToBase64(bytes: Uint8Array): string
export function base64ToSqliteBytes(b64: string): Uint8Array
export function serializeSondraSqlite(snapshot: SqliteMerklisteSnapshot<Record<string, unknown>>): Uint8Array
export function deserializeSondraSqlite(input: Uint8Array | string): SqliteMerklisteSnapshot<Record<string, unknown>>
