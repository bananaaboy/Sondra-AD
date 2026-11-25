import { useCallback, useEffect, useState } from 'react'
import { flushSync } from 'react-dom'

import {
  applyThemeChoice,
  readThemeChoice,
  resolveTheme,
  watchSystemTheme,
  type ResolvedTheme,
  type ThemeChoice,
} from '../lib/theme'

export interface ThemeState {
  choice: ThemeChoice
  resolved: ResolvedTheme
  setChoice: (choice: ThemeChoice) => void
}

export function useTheme(): ThemeState {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => readThemeChoice())
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(readThemeChoice()))

  useEffect(() => {
    setResolved(applyThemeChoice(choice))
  }, [choice])

  useEffect(() => {
    if (choice !== 'system') return undefined
    return watchSystemTheme(setResolved)
  }, [choice])

  const setChoice = useCallback((next: ThemeChoice) => {
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown }
    if (calm || typeof doc.startViewTransition !== 'function') {
      setChoiceState(next)
      return
    }
    doc.startViewTransition(() => {
      applyThemeChoice(next)
      flushSync(() => setChoiceState(next))
    })
  }, [])

  return { choice, resolved, setChoice }
}
