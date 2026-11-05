// SPDX-License-Identifier: FSL-1.1-ALv2
//
// config_apps writes the org's app rows (enabled apps, the mail provider
// switches on the mail app row) while the server may be registering the same
// org's apps (boot registers orgs in the background; an install re-registers).
// Twenty rounds, each starting a full re-registration at the moment the apply
// enables its first app: both always complete and Postgres never reports a
// deadlock (40P01).
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { registerConfigTools } from "~/modules/agent/tools/config-tools"
import { initializedOrgRuntimes, registeredApps, toolRegistry } from "~/modules/apps/app-registries"
import * as enabledApps from "~/modules/apps/enabled-apps"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { listMailProviders } from "~/modules/mail/provider-settings"
import { bootstrapAdminCtx } from "~/tests/helpers/agent-ctx"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ROUNDS = 20

let orgId: string
let adminId: string

beforeAll(async () => {
  await acquireTestLock()
  const a = await bootstrapAdminCtx()
  orgId = a.orgId
  adminId = a.userId
  await ensureAppsForOrg(orgId)
  registerConfigTools(orgId)
})
afterAll(releaseTestLock)

function deadlock(err: unknown): boolean {
  const code = (e: unknown) =>
    typeof e === "object" && e !== null ? Reflect.get(e, "code") : undefined
  const cause = typeof err === "object" && err !== null ? Reflect.get(err, "cause") : undefined
  return code(err) === "40P01" || code(cause) === "40P01" || /deadlock/i.test(String(err))
}

describe("config_apps against a concurrent app registration", () => {
  it(`${ROUNDS} interleaved rounds: no deadlock, both complete`, async () => {
    const def = toolRegistry.get([orgId, "kernel", "config_apps"])
    if (!def || typeof def.handler !== "function" || typeof def.preflight !== "function") {
      throw new Error("config_apps not registered")
    }
    const original = enabledApps.enableApp
    let registration: Promise<void> | null = null
    let registrations = 0
    const spy = spyOn(enabledApps, "enableApp").mockImplementation(async (o, name) => {
      // Start a full re-registration of the same org INSIDE the apply, then
      // let the apply carry on while it runs.
      if (registration === null) {
        // Forget the org's registration entirely, as a fresh server process
        // has it, so every app re-registers in full (schema reconcile, rows).
        initializedOrgRuntimes.delete(orgId)
        for (const key of [...registeredApps]) {
          if (key.startsWith(`${orgId}:`)) registeredApps.delete(key)
        }
        registrations++
        registration = ensureAppsForOrg(orgId)
      }
      return original(o, name)
    })
    const failures: string[] = []
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const data = [
          { name: "mail", enable: true, providers: { gmail: { enabled: round % 2 === 0 } } },
          { name: "projects", enable: true },
        ]
        const ctx = { orgId, userId: adminId }
        const pre = (await def.preflight({ apps: data }, ctx)) as {
          pinnedParams?: Record<string, unknown>
          error?: string
        }
        if (!pre.pinnedParams) throw new Error(`preflight refused: ${pre.error}`)
        registration = null
        const [applied, registered] = await Promise.allSettled([
          def.handler({ apps: data, ...pre.pinnedParams }, { ...ctx, approverUserId: adminId }),
          // Resolves once the apply has started the registration.
          (async () => {
            while (registration === null) await new Promise((r) => setTimeout(r, 5))
            await registration
          })(),
        ])
        if (applied.status === "rejected") failures.push(`apply threw: ${String(applied.reason)}`)
        else {
          const value = applied.value as { error?: string }
          if (value.error) failures.push(`apply error: ${value.error}`)
        }
        if (registered.status === "rejected") {
          failures.push(`registration threw: ${String(registered.reason)}`)
        }
        for (const r of [applied, registered]) {
          if (r.status === "rejected" && deadlock(r.reason)) failures.push("40P01")
        }
        const gmail = (await listMailProviders(orgId)).find((p) => p.id === "gmail")
        expect(gmail?.enabled).toBe(round % 2 === 0)
      }
    } finally {
      spy.mockRestore()
    }
    expect(failures).toEqual([])
    expect(registrations).toBe(ROUNDS)
    expect(await enabledApps.getEnabledApps(orgId)).toContain("projects")
  }, 900_000)
})
