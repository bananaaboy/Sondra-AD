export type ThemeChoice = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'sondra:theme'

const CHROME_COLOR: Record<ResolvedTheme, string> = {
  light: '#f8faf8',
  dark: '#0a110d',
}

export function readThemeChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {}
  return 'system'
}

export function systemTheme(): ResolvedTheme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  return choice === 'system' ? systemTheme() : choice
}

export function applyThemeChoice(choice: ThemeChoice): ResolvedTheme {
  const root = document.documentElement
  if (choice === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', choice)

  const resolved = resolveTheme(choice)
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', CHROME_COLOR[resolved])

  try {
    localStorage.setItem(STORAGE_KEY, choice)
  } catch {}
  return resolved
}

export function watchSystemTheme(handler: (theme: ResolvedTheme) => void): () => void {
  if (typeof matchMedia !== 'function') return () => undefined
  const query = matchMedia('(prefers-color-scheme: dark)')
  const listener = (event: MediaQueryListEvent) => handler(event.matches ? 'dark' : 'light')
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}
