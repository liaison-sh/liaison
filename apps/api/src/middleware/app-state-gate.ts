// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Route gate for the per-workspace app state (S19, S20, A6, A7, A24-3).
 *
 * Runs after `authMw` on `/api/apps/*` and on the kernel-mounted app prefixes
 * (`/api/mail`, `/api/projects`, ...). For an app turned Off or removed for the
 * org it answers 410 `{error:{code:"app_disabled"}}`; for a restricted app the
 * person is restricted away from, 403. Admins (`kernel:apps:admin`) keep the
 * app's read-only management surface while it is Off (its config, connections
 * and settings reads, and the instance install actions: upgrade, UI approval,
 * OAuth client, uninstall), so the app page can show and turn it back On.
 *
 * Data export (`/api/apps/export/:app`) is not under an app segment and stays
 * available for an Off app: its data is kept (D28).
 *
 * Fail-closed: an unreadable state answers 503 instead of letting the request
 * through.
 */
import { APP_DISABLED_CODE, APP_DISABLED_MESSAGE, APP_RESTRICTED_MESSAGE } from "@liaison/shared"
import { createMiddleware } from "hono/factory"
import type { AppEnv } from "~/app"
import { rootLogger } from "~/lib/logger"
import {
  APP_STATE_UNAVAILABLE_CODE,
  isAppRestrictedAway,
  isOffStatus,
  peekOrgAppState,
  primeOrgApps,
} from "~/modules/apps/org-apps"
import { hasScope } from "~/modules/permissions/permissions"

const log = rootLogger.child({ module: "middleware/app-state-gate" })

/**
 * Kernel-mounted route prefixes that belong to one app (A6). Longest prefix
 * first is not needed: none is a prefix of another at a segment boundary.
 */
export const KERNEL_MOUNTED_APP_PREFIXES: Readonly<Record<string, string>> = {
  "/api/mail": "mail",
  "/api/mailbox": "mail",
  "/api/mailbox-keys": "mail",
  "/api/projects": "projects",
  "/api/contacts": "contacts",
  "/api/api-connector": "api-connector",
  "/api/database": "database",
  "/api/knowledge": "knowledge",
}

/** What an admin may still do on an Off app's own `/api/apps/:app/...` routes. */
function adminMayReachOffApp(method: string, rest: string): boolean {
  if (method === "GET" && /^(config|connections|settings)(\/|$)/.test(rest)) return true
  if (/^(upgrade|ui-approval|oauth-client)(\/|$)/.test(rest)) return true
  return method === "DELETE" && rest === ""
}

async function gate(
  c: Parameters<Parameters<typeof createMiddleware<AppEnv>>[0]>[0],
  app: string,
  rest: string,
): Promise<Response | null> {
  const orgId = c.get("orgId")
  if (!orgId || app === "kernel") return null
  try {
    await primeOrgApps(orgId)
  } catch (err) {
    log.error({ err, orgId, app, path: c.req.path }, "app state unreadable; refusing the request")
    return c.json(
      {
        error: {
          message: "The workspace's app state could not be read; try again.",
          code: APP_STATE_UNAVAILABLE_CODE,
        },
      },
      503,
    )
  }
  const state = peekOrgAppState(orgId, app)
  if (!state) return null // not an app of this workspace (or a reserved path segment)
  const scopes = (c.get("scopes") as string[] | undefined) ?? []
  if (isOffStatus(state.status)) {
    if (hasScope("kernel:apps:admin", scopes) && adminMayReachOffApp(c.req.method, rest))
      return null
    return c.json({ error: { message: APP_DISABLED_MESSAGE, code: APP_DISABLED_CODE } }, 410)
  }
  if (isAppRestrictedAway(state, c.get("userId"))) {
    return c.json({ error: { message: APP_RESTRICTED_MESSAGE, code: "app_restricted" } }, 403)
  }
  return null
}

/** `/api/apps/:app/*`: the first segment names the app when the org has a row for it. */
export const appRouteStateGate = createMiddleware<AppEnv>(async (c, next) => {
  const m = /^\/api\/apps\/([^/]+)(?:\/(.*))?$/.exec(c.req.path)
  if (m?.[1]) {
    const refused = await gate(c, decodeURIComponent(m[1]), m[2] ?? "")
    if (refused) return refused
  }
  await next()
})

/** A kernel-mounted prefix of one app (see `KERNEL_MOUNTED_APP_PREFIXES`). */
export function kernelPrefixStateGate(app: string) {
  return createMiddleware<AppEnv>(async (c, next) => {
    // The path as `rest` matches no admin carve-out: kernel prefixes have none.
    const refused = await gate(c, app, c.req.path)
    if (refused) return refused
    await next()
  })
}
