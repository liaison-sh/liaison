// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ── WHICH OPENROUTER HOSTS AN ORG'S REQUESTS NEVER REACH ───────────────────
// The instance default is LIAISON_OPENROUTER_IGNORE_HOSTS (openRouterDeniedHosts).
// An org may set its own list on the AI models page
// (`settings.ai.models.blockedHosts`): set, even empty, it REPLACES the default;
// absent, the default applies. Every OpenRouter chat request of the org reads
// the effective list here (openrouter-provider-pin.ts applies it), once per
// request, from a short in-process cache, never per streamed chunk. A failed
// read falls back to the instance default (logged): routing never fails a call.
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "openrouter-blocked-hosts" })

/** Parse a comma-separated host deny-list (blank entries dropped). */
export function parseHostDenyList(raw: string): string[] {
  return raw
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean)
}

/** The instance default: hosts no OpenRouter chat request may reach (LIAISON_OPENROUTER_IGNORE_HOSTS). */
export function openRouterDeniedHosts(): string[] {
  return parseHostDenyList(env.LIAISON_OPENROUTER_IGNORE_HOSTS)
}

/** How long an org's list is reused before it is read again. */
export const BLOCKED_HOSTS_CACHE_MS = 30_000

/** A read slower than this falls back to the instance default. */
const READ_TIMEOUT_MS = 1_000

/** The effective list: the org's own when set (even empty), else the instance default. */
export function effectiveBlockedHosts(
  orgList: readonly string[] | undefined | null,
  instanceDefault: readonly string[],
): string[] {
  return Array.isArray(orgList) ? [...orgList] : [...instanceDefault]
}

/** Reads an org's `settings.ai.models.blockedHosts` (undefined when absent). */
export type OrgBlockedHostsReader = (orgId: string) => Promise<string[] | undefined>

const readFromDb: OrgBlockedHostsReader = async (orgId) => {
  const [{ withPrivilegedDb }, { getOrgKernelSettings }, { orgKernelSettingsSchema }] =
    await Promise.all([
      import("~/db/privileged"),
      import("~/lib/settings"),
      import("@liaison/shared"),
    ])
  const settings = await withPrivilegedDb(orgId, "openrouter-blocked-hosts", (tx) =>
    getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
  )
  return settings.ai?.models?.blockedHosts
}

/** A cached source of an org's effective list (reader and clock injectable for tests). */
export function createBlockedHostsSource(
  deps: { read?: OrgBlockedHostsReader; now?: () => number } = {},
) {
  const read = deps.read ?? readFromDb
  const now = deps.now ?? Date.now
  const cache = new Map<string, { orgList: string[] | undefined; at: number }>()
  return {
    /** The org's effective list; no org: the instance default. */
    async get(orgId: string | null | undefined): Promise<string[]> {
      const instanceDefault = openRouterDeniedHosts()
      if (!orgId) return instanceDefault
      const hit = cache.get(orgId)
      if (hit && now() - hit.at < BLOCKED_HOSTS_CACHE_MS) {
        return effectiveBlockedHosts(hit.orgList, instanceDefault)
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const orgList = await Promise.race([
          read(orgId),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("blocked hosts read timed out")),
              READ_TIMEOUT_MS,
            )
          }),
        ])
        cache.set(orgId, { orgList, at: now() })
        return effectiveBlockedHosts(orgList, instanceDefault)
      } catch (err) {
        log.warn(
          { err, orgId },
          "OpenRouter blocked hosts read failed; the instance default applies",
        )
        return instanceDefault
      } finally {
        clearTimeout(timer)
      }
    },
    /** Forget an org's cached list (its admin just changed it). */
    invalidate(orgId: string): void {
      cache.delete(orgId)
    },
  }
}

export type BlockedHostsSource = ReturnType<typeof createBlockedHostsSource>

export const blockedHostsSource: BlockedHostsSource = createBlockedHostsSource()
