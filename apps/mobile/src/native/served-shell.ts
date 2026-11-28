// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The page's side of the served shell (ios/LiaisonShell, MainViewController).
//
// The native host chooses, at every launch, whether the page runs the web
// build compiled into the app or the connected server's own build, verified
// against Liaison's signature on the device. This boot code is ALWAYS the
// binary's own (the host adds it to a served build), and it publishes three
// members on the native bridge for apps/web (lib/native-bridge.ts):
//
//  - `shellInfo()`: the host's NATIVE_BRIDGE_VERSION and which shell runs,
//    `served:<buildId>` or `bundled:<reason>`;
//  - `shellReady(buildId)`: the page painted; a served build that says so
//    within 20 s becomes this server's last good build, one that never does
//    is quarantined after its second try;
//  - `refreshShell()`: choose again for the current server (a newer build may
//    be staged); true when a reload would load another build.
//
// Without the plugin (Android, a test page) every member answers as the
// bundled shell does and nothing throws.

export interface ShellInfo {
  bridgeVersion: number
  /** `served:<buildId>` or `bundled:<reason>`. */
  shell: string
  served: boolean
  buildId?: string
  reason?: string
}

export interface ServedShellPlugin {
  shellInfo: () => Promise<ShellInfo>
  shellReady: (options: { buildId: string | null }) => Promise<void>
  shellReselect: () => Promise<{ changed: boolean }>
}

export interface ServedShell {
  info: () => Promise<ShellInfo | null>
  ready: (buildId: string | null) => void
  /** Chooses again; true when the page must reload to run the chosen build. */
  reselect: () => Promise<boolean>
}

/** How long a server switch waits for the host before reloading anyway. */
export const RESELECT_TIMEOUT_MS = 2000

function isShellInfo(raw: unknown): raw is ShellInfo {
  if (typeof raw !== "object" || raw === null) return false
  const info = raw as Record<string, unknown>
  return (
    typeof info.bridgeVersion === "number" &&
    Number.isSafeInteger(info.bridgeVersion) &&
    typeof info.shell === "string" &&
    typeof info.served === "boolean"
  )
}

export function createServedShell(deps: {
  available: () => boolean
  plugin: ServedShellPlugin
  timeoutMs?: number
}): ServedShell {
  let readySent = false
  return {
    info: async () => {
      if (!deps.available()) return null
      try {
        const info = await deps.plugin.shellInfo()
        return isShellInfo(info) ? info : null
      } catch {
        return null
      }
    },
    ready: (buildId) => {
      if (!deps.available() || readySent) return
      readySent = true
      void deps.plugin.shellReady({ buildId }).catch(() => undefined)
    },
    reselect: async () => {
      if (!deps.available()) return false
      const timeout = new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), deps.timeoutMs ?? RESELECT_TIMEOUT_MS),
      )
      const asked = deps.plugin
        .shellReselect()
        .then((r) => r?.changed === true)
        .catch(() => false)
      return Promise.race([asked, timeout])
    },
  }
}

/**
 * A reload that first lets the host choose the build for the server now
 * current: a server switch restarts the page on that server's build.
 */
export function reselectThenReload(
  shell: Pick<ServedShell, "reselect">,
  reload: (path?: string) => void,
): (path?: string) => void {
  return (path) => {
    void shell.reselect().finally(() => reload(path))
  }
}
