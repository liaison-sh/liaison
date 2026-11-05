// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHICH PHONE APP THIS IS, as it names itself to its server (apps/web
// lib/client-version.ts): the platform and `1.0.<build>`. The marketing version
// stays "1.0" from one store upload to the next, and the build number is what
// every upload raises, so the build is the part a server's minimum can name.
// Android uses the same form with its version code.

export interface AppInfoPlugin {
  getInfo: () => Promise<{ version: string; build: string }>
}

export interface ClientVersion {
  platform: "ios" | "android"
  version: string
}

export function createClientVersion(deps: {
  app: AppInfoPlugin
  platform: () => string
}): () => Promise<ClientVersion | null> {
  return async () => {
    const platform = deps.platform()
    if (platform !== "ios" && platform !== "android") return null
    try {
      const { build } = await deps.app.getInfo()
      const number = String(build).trim()
      if (!/^\d+$/.test(number)) return null
      return { platform, version: `1.0.${Number(number)}` }
    } catch {
      return null
    }
  }
}
