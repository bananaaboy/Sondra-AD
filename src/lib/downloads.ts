export const WINDOWS_SETUP = 'https://github.com/bananaaboy/Sondra-AD/releases/latest/download/Sondra-AD-Setup.exe'
export const WINDOWS_SETUP_ARM64 = 'https://github.com/bananaaboy/Sondra-AD/releases/latest/download/Sondra-AD-Setup-arm64.exe'
export const WINDOWS_PORTABLE = 'https://github.com/bananaaboy/Sondra-AD/releases/latest/download/Sondra-AD-Portable.exe'
export const WINDOWS_PORTABLE_ARM64 = 'https://github.com/bananaaboy/Sondra-AD/releases/latest/download/Sondra-AD-Portable-arm64.exe'
export const RELEASES_URL = 'https://github.com/bananaaboy/Sondra-AD/releases'
export const REPO_URL = 'https://github.com/bananaaboy/Sondra-AD'
export const SONDRA_STUDIO_URL = 'https://www.sondra.lizge.ch'

const configuredStoreUrl = (import.meta.env.VITE_MICROSOFT_STORE_URL as string | undefined)?.trim()
export const MICROSOFT_STORE: string | null = configuredStoreUrl ? configuredStoreUrl : null

type ArchNavigator = Navigator & {
  userAgentData?: {
    platform?: string
    getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>
  }
}

export async function onWindowsArm(): Promise<boolean> {
  if (typeof navigator === 'undefined') return false
  const data = (navigator as ArchNavigator).userAgentData
  if (!data?.getHighEntropyValues || data.platform !== 'Windows') return false
  try {
    const { architecture } = await data.getHighEntropyValues(['architecture'])
    return architecture === 'arm'
  } catch {
    return false
  }
}

export const IN_ELECTRON_APP =
  typeof window !== 'undefined' &&
  (Boolean(window.sondraAd?.isDesktopApp) || /\bElectron\//.test(navigator.userAgent))
