// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Real-DB unit test for the email-identity provisioner (Task 7).
 *
 * Assertions:
 * - create path writes `settings.email.{from,replyTo}`; report `set:true`;
 * - idempotent re-run with the SAME values → `set:false`, `unchanged`, and the
 *   stored `settings.email` is byte-identical (no write);
 * - a changed value re-merges and overwrites only the changed key;
 * - a display name with a SPACE round-trips through the setting.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { orgKernelSettingsSchema } from "@liaison/shared"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { emailProvisioner } from "~/cli/provisioners/email"
import { buildProvisionContext, type ProvisionContext } from "~/cli/provisioners/types"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { getOrgKernelSettings } from "~/lib/settings"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

async function freshOrg(): Promise<string> {
  const { orgId } = await ensureOrg({
    slug: `cli-email-${crypto.randomUUID().slice(0, 12)}`,
    name: "EmailProvOrg",
  })
  return orgId
}

function ctxFor(orgId: string, log?: (m: string) => void): ProvisionContext {
  const ctx = buildProvisionContext({ log: log ?? (() => {}), validateByok: false })
  ctx.orgId = orgId
  return ctx
}

async function readEmailRaw(orgId: string): Promise<string> {
  const [row] =
    await sql`SELECT settings->'email' AS email FROM kernel.organizations WHERE id = ${orgId}::uuid`
  return JSON.stringify(row?.email ?? null)
}

async function readEmail(orgId: string): Promise<{ from?: string; replyTo?: string } | undefined> {
  const settings = await withPrivilegedDb(orgId, "t", (tx) =>
    getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
  )
  return settings.email
}

describe("email provisioner (Task 7)", () => {
  test("create: writes settings.email.{from,replyTo}; reports set:true", async () => {
    const orgId = await freshOrg()
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      email: { from: "Fabrikam <hello@fabrikam.example>", replyTo: "support@fabrikam.example" },
    }
    const plan = await emailProvisioner.plan(ctxFor(orgId), config)
    const result = await emailProvisioner.apply(ctxFor(orgId), plan, config)

    const email = await readEmail(orgId)
    expect(email?.from).toBe("Fabrikam <hello@fabrikam.example>")
    expect(email?.replyTo).toBe("support@fabrikam.example")
    const section = result.section as { from?: string; set: boolean }
    expect(section.set).toBe(true)
    expect(section.from).toBe("Fabrikam <hello@fabrikam.example>")
    expect(result.changed).toContain("email")
  })

  test("IDEMPOTENT: re-run with the same values → set:false, no write (byte-identical)", async () => {
    const orgId = await freshOrg()
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      email: { from: "Stable <stable@fabrikam.example>" },
    }
    await emailProvisioner.apply(ctxFor(orgId), { actions: [] }, config)
    const before = await readEmailRaw(orgId)

    const result = await emailProvisioner.apply(ctxFor(orgId), { actions: [] }, config)
    const after = await readEmailRaw(orgId)
    expect(after).toBe(before)
    expect(result.unchanged).toContain("email")
    const section = result.section as { set: boolean }
    expect(section.set).toBe(false)
  })

  test("change path: a different from re-merges and overwrites", async () => {
    const orgId = await freshOrg()
    await emailProvisioner.apply(
      ctxFor(orgId),
      { actions: [] },
      { org: { slug: "x", name: "X" }, email: { from: "Old <old@fabrikam.example>" } },
    )
    const result = await emailProvisioner.apply(
      ctxFor(orgId),
      { actions: [] },
      { org: { slug: "x", name: "X" }, email: { from: "New <new@fabrikam.example>" } },
    )
    const email = await readEmail(orgId)
    expect(email?.from).toBe("New <new@fabrikam.example>")
    expect(result.changed).toContain("email")
  })

  test("no email section → no-op (no section, no write)", async () => {
    const orgId = await freshOrg()
    const result = await emailProvisioner.apply(
      ctxFor(orgId),
      { actions: [] },
      { org: { slug: "x", name: "X" } },
    )
    expect(result.section).toBeUndefined()
    expect(await readEmail(orgId)).toBeUndefined()
  })

  test("display name with a SPACE round-trips", async () => {
    const orgId = await freshOrg()
    const from = "Acme Widgets Co <noreply@acme.example>"
    await emailProvisioner.apply(
      ctxFor(orgId),
      { actions: [] },
      { org: { slug: "x", name: "X" }, email: { from } },
    )
    expect((await readEmail(orgId))?.from).toBe(from)
  })
})
