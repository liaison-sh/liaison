// SPDX-License-Identifier: FSL-1.1-ALv2
// Kernel import kinds (P3b T1): kinds no app manifest owns (`agents.*`) are
// declared in modules/imports/kernel-kinds.ts, pass the same declaration
// rules as a manifest's kinds, write only allowlisted kernel tables, and are
// listed and resolved for every org without registering any app.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { BUILTIN_IMPORT_KINDS } from "~/modules/imports/builtin-kinds"
import { KERNEL_IMPORT_KINDS, kernelKindDeclarationErrors } from "~/modules/imports/kernel-kinds"
import type { ImportKindDecl } from "~/modules/imports/kind-schema"
import { getImportKind, listImportKinds, lookupImportKind } from "~/modules/imports/kinds"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("kernel import kinds: declarations", () => {
  it("every kernel kind passes the manifest declaration rules", () => {
    expect(Object.keys(KERNEL_IMPORT_KINDS).length).toBeGreaterThan(0)
    expect(kernelKindDeclarationErrors(KERNEL_IMPORT_KINDS)).toEqual([])
  })

  it("no kernel kind is a manifest kind (an installed app can never claim one)", () => {
    for (const name of Object.keys(KERNEL_IMPORT_KINDS)) {
      expect(BUILTIN_IMPORT_KINDS[name]).toBeUndefined()
    }
  })

  it("a kernel kind naming a table outside the allowlist is rejected", () => {
    const skill = KERNEL_IMPORT_KINDS["agents.skill"]!
    const bad: Record<string, ImportKindDecl> = {
      "agents.skill": { ...skill, tables: ["kernel.skills", "kernel.organizations"] },
    }
    expect(kernelKindDeclarationErrors(bad).join("\n")).toMatch(/kernel\.organizations/)
    const otherApp: Record<string, ImportKindDecl> = {
      "agents.skill": { ...skill, tables: ["app_tickets.tickets"] },
    }
    expect(kernelKindDeclarationErrors(otherApp).join("\n")).toMatch(/app_tickets\.tickets/)
  })

  it("a kernel kind name without an app part is rejected", () => {
    const skill = KERNEL_IMPORT_KINDS["agents.skill"]!
    expect(kernelKindDeclarationErrors({ skill }).join("\n")).toMatch(/<app>\.<kind>/)
  })
})

describe("kernel import kinds: listing and lookup", () => {
  let orgId = ""
  beforeAll(async () => {
    await acquireTestLock()
    orgId = (
      await ensureOrg({
        slug: `imp-kk-${crypto.randomUUID().slice(0, 8)}`,
        name: "Kernel Kinds Org",
      })
    ).orgId
  }, 120_000)
  afterAll(releaseTestLock)

  it("an org that registered no app still resolves a kernel kind, with or without the fallback", () => {
    const unregistered = crypto.randomUUID()
    for (const fallback of [true, false]) {
      const k = lookupImportKind(unregistered, "agents.skill", fallback)
      expect(k?.kind).toBe("agents.skill")
      expect(k?.app).toBe("agents")
      expect(k?.bundle).toBeUndefined()
    }
  })

  it("listImportKinds lists the kernel kinds for every org", async () => {
    const listed = (await listImportKinds(orgId)).map((k) => k.kind)
    for (const name of Object.keys(KERNEL_IMPORT_KINDS)) expect(listed).toContain(name)
    // Sorted and listed once.
    expect(listed).toEqual([...new Set(listed)].sort((a, b) => a.localeCompare(b)))
  }, 120_000)

  it("the CLI path (ensureApps: false) finds a kernel kind", async () => {
    const k = await getImportKind(crypto.randomUUID(), "agents.routine", { ensureApps: false })
    expect(k?.decl).toBe(KERNEL_IMPORT_KINDS["agents.routine"]!)
  })
})
