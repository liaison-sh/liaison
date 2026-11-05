// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The config lease: one change per org and write group, renewed while the
// apply runs. A lease that expired or was taken by someone else is noticed
// (a failed renewal is recorded, the token is checked before each section's
// apply) and the run stops instead of writing without it.
import { describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import type { ProvisioningConfig } from "~/cli/config/schema"
import type { Provisioner } from "~/cli/provisioners/types"
import { redis } from "~/lib/redis"
import { ConfigLeaseLostError, withConfigLease } from "~/modules/provisioning/config-lease"
import { applySections, buildActorProvisionContext } from "~/modules/provisioning/config-sections"

const key = (orgId: string, group: string) => `config-lease:${orgId}:${group}`

describe("config lease", () => {
  test("a lease deleted under the holder is reported lost", async () => {
    const orgId = crypto.randomUUID()
    await expect(
      withConfigLease(orgId, "roles", async (lease) => {
        await redis.del(key(orgId, "roles"))
        await lease.assertHeld()
      }),
    ).rejects.toBeInstanceOf(ConfigLeaseLostError)
  })

  test("a failed renewal is recorded, even if another holder took the key since", async () => {
    const orgId = crypto.randomUUID()
    await expect(
      withConfigLease(
        orgId,
        "roles",
        async (lease) => {
          await redis.del(key(orgId, "roles"))
          await new Promise((r) => setTimeout(r, 120))
          // Someone else holds it now; the late holder must not carry on.
          await redis.set(key(orgId, "roles"), "someone-else", "PX", 60_000)
          await lease.assertHeld()
        },
        { renewMs: 30 },
      ),
    ).rejects.toBeInstanceOf(ConfigLeaseLostError)
    expect(await redis.get(key(orgId, "roles"))).toBe("someone-else")
    await redis.del(key(orgId, "roles"))
  })

  test("the runner checks the lease before each section's apply and stops when it is lost", async () => {
    const applied: string[] = []
    const stub = (k: string): Provisioner<ProvisioningConfig> => ({
      key: k,
      plan: async () => ({ actions: [] }),
      apply: async () => {
        applied.push(k)
        return {}
      },
    })
    const ctx = buildActorProvisionContext({
      orgId: crypto.randomUUID(),
      actor: { userId: crypto.randomUUID(), scopes: ["*"], dimensionGrants: {} },
    })
    let checks = 0
    await expect(
      applySections(ctx, { org: { slug: "x", name: "X" } }, ["roles", "email"], {
        registry: { roles: stub("roles"), email: stub("email") },
        beforeApply: async () => {
          checks++
          if (checks === 2) throw new ConfigLeaseLostError("email")
        },
      }),
    ).rejects.toBeInstanceOf(ConfigLeaseLostError)
    expect(applied).toEqual(["roles"])
  })
})
