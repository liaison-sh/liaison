// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Real-DB unit test for the BYOK provisioner (Task 8).
 *
 * Critical assertions:
 * - create path writes `providerKeys.<p>.{encrypted,maskedHint,validatedAt}`;
 * - the idempotent SKIP re-run calls `encryptSecret` ZERO times (spied via the
 *   injectable deps seam) and performs no write;
 * - the masked-hint compare is case-insensitive;
 * - a different key re-encrypts and overwrites the hint;
 * - validation: a mocked 200 to `api.anthropic.com/v1/models` (with the right
 *   `x-api-key`+`anthropic-version` headers asserted) → validated:true; a 401 →
 *   validated:false but the key is STILL stored; `--no-validate-byok` → fetch is
 *   never called;
 * - the plaintext key never appears in the report or any logged line.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { orgKernelSettingsSchema } from "@liaison/shared"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { type ByokDeps, createByokProvisioner } from "~/cli/provisioners/byok"
import { buildProvisionContext, type ProvisionContext } from "~/cli/provisioners/types"
import { withPrivilegedDb } from "~/db/privileged"
import { CryptoContext, decryptSecret, encryptSecret } from "~/lib/crypto"
import { getOrgKernelSettings } from "~/lib/settings"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

// A 64-hex (32-byte) key for AES-256-GCM, distinct from the env default.
const TEST_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"

async function freshOrg(): Promise<string> {
  const { orgId } = await ensureOrg({
    slug: `cli-byok-${crypto.randomUUID().slice(0, 12)}`,
    name: "ByokTestOrg",
  })
  return orgId
}

function ctxFor(
  orgId: string,
  opts?: { validateByok?: boolean; log?: (m: string) => void },
): ProvisionContext {
  const ctx = buildProvisionContext({
    log: opts?.log ?? (() => {}),
    validateByok: opts?.validateByok ?? false,
  })
  ctx.orgId = orgId
  return ctx
}

/** A deps seam that counts encryptSecret calls and records fetch invocations. */
function spyDeps(overrides?: Partial<ByokDeps>): {
  deps: ByokDeps
  encryptCalls: number
  fetchCalls: Array<{ url: string; headers: Record<string, string> }>
} {
  const state = {
    encryptCalls: 0,
    fetchCalls: [] as Array<{ url: string; headers: Record<string, string> }>,
  }
  const deps: ByokDeps = {
    encryptionKey: overrides?.encryptionKey ?? TEST_KEY,
    encryptSecret:
      overrides?.encryptSecret ??
      ((plaintext, key, context) => {
        state.encryptCalls++
        return encryptSecret(plaintext, key, context)
      }),
    fetch:
      overrides?.fetch ??
      (async (url, init) => {
        state.fetchCalls.push({ url, headers: init.headers })
        return { ok: true }
      }),
  }
  return {
    deps,
    get encryptCalls() {
      return state.encryptCalls
    },
    get fetchCalls() {
      return state.fetchCalls
    },
  }
}

async function readProviderKeys(orgId: string) {
  return withPrivilegedDb(orgId, "t", (tx) =>
    getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
  )
}

describe("byok provisioner (Task 8)", () => {
  test("create: writes encrypted+maskedHint+validatedAt; hint == last 6 of the key", async () => {
    const orgId = await freshOrg()
    const apiKey = `sk-ant-${crypto.randomUUID()}END66`
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      byok: { anthropic: { apiKey } },
    }
    const spy = spyDeps()
    const prov = createByokProvisioner(spy.deps)
    const plan = await prov.plan(ctxFor(orgId), config)
    const result = await prov.apply(ctxFor(orgId), plan, config)

    const settings = await readProviderKeys(orgId)
    const entry = settings.providerKeys?.anthropic
    expect(entry?.encrypted).toBeTruthy()
    expect(entry?.maskedHint).toBe(apiKey.slice(-6))
    expect(entry?.validatedAt).toBeTruthy()
    // Ciphertext decrypts back to the plaintext with the right context.
    expect(decryptSecret(entry?.encrypted ?? "", TEST_KEY, CryptoContext.byokApiKey)).toBe(apiKey)

    const section = result.section as { providers: Array<{ provider: string; set: boolean }> }
    expect(section.providers[0]).toMatchObject({ provider: "anthropic", set: true })
    expect(result.changed).toContain("byok.anthropic")
  })

  test("IDEMPOTENT SKIP: re-run with the SAME key calls encryptSecret 0 times, no write", async () => {
    const orgId = await freshOrg()
    const apiKey = `sk-ant-${crypto.randomUUID()}STABLE`
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      byok: { anthropic: { apiKey } },
    }
    // First run encrypts once.
    const spy1 = spyDeps()
    await createByokProvisioner(spy1.deps).apply(ctxFor(orgId), { actions: [] }, config)
    expect(spy1.encryptCalls).toBe(1)
    const before = await readProviderKeys(orgId)

    // Second run — same key → skip, ZERO encrypt calls, settings byte-identical.
    const spy2 = spyDeps()
    const prov2 = createByokProvisioner(spy2.deps)
    const result = await prov2.apply(ctxFor(orgId), { actions: [] }, config)
    expect(spy2.encryptCalls).toBe(0)
    const after = await readProviderKeys(orgId)
    expect(after.providerKeys?.anthropic?.encrypted).toBe(before.providerKeys?.anthropic?.encrypted)
    expect(after.providerKeys?.anthropic?.validatedAt).toBe(
      before.providerKeys?.anthropic?.validatedAt,
    )
    expect(result.unchanged).toContain("byok.anthropic")
    const section = result.section as { providers: Array<{ set: boolean }> }
    expect(section.providers[0].set).toBe(false)
  })

  test("case-insensitive hint compare: a last-6 differing only in case is treated unchanged", async () => {
    const orgId = await freshOrg()
    const apiKey = `sk-ant-${crypto.randomUUID().slice(0, 6)}abCDef`
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      byok: { anthropic: { apiKey } },
    }
    const spy1 = spyDeps()
    await createByokProvisioner(spy1.deps).apply(ctxFor(orgId), { actions: [] }, config)

    // Same key but the last-6 written in different case — should still skip.
    const variantKey = `${apiKey.slice(0, -6)}ABCDEF`
    const spy2 = spyDeps()
    const result = await createByokProvisioner(spy2.deps).apply(
      ctxFor(orgId),
      { actions: [] },
      { org: { slug: "x", name: "X" }, byok: { anthropic: { apiKey: variantKey } } },
    )
    expect(spy2.encryptCalls).toBe(0)
    expect(result.unchanged).toContain("byok.anthropic")
  })

  test("change path: a different key re-encrypts and overwrites the masked hint", async () => {
    const orgId = await freshOrg()
    const config1: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      byok: { anthropic: { apiKey: `sk-ant-${crypto.randomUUID()}AAAAAA` } },
    }
    await createByokProvisioner(spyDeps().deps).apply(ctxFor(orgId), { actions: [] }, config1)

    const newKey = `sk-ant-${crypto.randomUUID()}ZZZZZZ`
    const spy = spyDeps()
    const result = await createByokProvisioner(spy.deps).apply(
      ctxFor(orgId),
      { actions: [] },
      { org: { slug: "x", name: "X" }, byok: { anthropic: { apiKey: newKey } } },
    )
    expect(spy.encryptCalls).toBe(1)
    const after = await readProviderKeys(orgId)
    expect(after.providerKeys?.anthropic?.maskedHint).toBe("ZZZZZZ")
    expect(result.changed).toContain("byok.anthropic")
  })

  test("validation: mocked 200 with correct anthropic headers → validated:true", async () => {
    const orgId = await freshOrg()
    const apiKey = `sk-ant-${crypto.randomUUID()}V200OK`
    const spy = spyDeps()
    const result = await createByokProvisioner(spy.deps).apply(
      ctxFor(orgId, { validateByok: true }),
      { actions: [] },
      { org: { slug: "x", name: "X" }, byok: { anthropic: { apiKey } } },
    )
    expect(spy.fetchCalls.length).toBe(1)
    expect(spy.fetchCalls[0].url).toBe("https://api.anthropic.com/v1/models")
    expect(spy.fetchCalls[0].headers["x-api-key"]).toBe(apiKey)
    expect(spy.fetchCalls[0].headers["anthropic-version"]).toBe("2023-06-01")
    const section = result.section as { providers: Array<{ validated: boolean; set: boolean }> }
    expect(section.providers[0].validated).toBe(true)
    expect(section.providers[0].set).toBe(true)
  })

  test("validation: mocked 401 → validated:false but the key is STILL stored", async () => {
    const orgId = await freshOrg()
    const apiKey = `sk-ant-${crypto.randomUUID()}V401NO`
    const spy = spyDeps({
      fetch: async () => ({ ok: false }),
    })
    const result = await createByokProvisioner(spy.deps).apply(
      ctxFor(orgId, { validateByok: true }),
      { actions: [] },
      { org: { slug: "x", name: "X" }, byok: { anthropic: { apiKey } } },
    )
    const section = result.section as { providers: Array<{ validated: boolean; set: boolean }> }
    expect(section.providers[0].validated).toBe(false)
    expect(section.providers[0].set).toBe(true)
    // Key still stored despite the failed validation.
    const after = await readProviderKeys(orgId)
    expect(after.providerKeys?.anthropic?.encrypted).toBeTruthy()
  })

  test("skip path reports the STORED validation outcome: failed-validation store → re-run skip reports validated:false", async () => {
    const orgId = await freshOrg()
    const apiKey = `sk-ant-${crypto.randomUUID()}STORED`
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      byok: { anthropic: { apiKey } },
    }

    // Run 1: validation ON but the provider returns non-OK → stored with
    // validated:false (the key is kept; validation merely flagged a warning).
    const spy1 = spyDeps({ fetch: async () => ({ ok: false }) })
    const r1 = await createByokProvisioner(spy1.deps).apply(
      ctxFor(orgId, { validateByok: true }),
      { actions: [] },
      config,
    )
    const section1 = r1.section as { providers: Array<{ validated: boolean; set: boolean }> }
    expect(section1.providers[0].validated).toBe(false)
    expect(section1.providers[0].set).toBe(true)
    // The stored entry persists the false outcome.
    const stored = await readProviderKeys(orgId)
    expect(stored.providerKeys?.anthropic?.validated).toBe(false)

    // Run 2: same key → idempotent SKIP. It must report the STORED validated:false,
    // NOT an optimistic true (the bug). No re-encrypt, no network call.
    const spy2 = spyDeps()
    const r2 = await createByokProvisioner(spy2.deps).apply(
      ctxFor(orgId, { validateByok: true }),
      { actions: [] },
      config,
    )
    expect(spy2.encryptCalls).toBe(0)
    expect(spy2.fetchCalls.length).toBe(0)
    const section2 = r2.section as { providers: Array<{ validated: boolean; set: boolean }> }
    expect(section2.providers[0].set).toBe(false)
    expect(section2.providers[0].validated).toBe(false)
    expect(r2.unchanged).toContain("byok.anthropic")
  })

  test("skip path reports validated:true when the stored entry was validated", async () => {
    const orgId = await freshOrg()
    const apiKey = `sk-ant-${crypto.randomUUID()}VALOK1`
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      byok: { anthropic: { apiKey } },
    }
    // Run 1: validation passes (mocked 200) → stored validated:true.
    await createByokProvisioner(spyDeps().deps).apply(
      ctxFor(orgId, { validateByok: true }),
      { actions: [] },
      config,
    )
    // Run 2: skip → reports the stored true.
    const r2 = await createByokProvisioner(spyDeps().deps).apply(
      ctxFor(orgId, { validateByok: true }),
      { actions: [] },
      config,
    )
    const section2 = r2.section as { providers: Array<{ validated: boolean; set: boolean }> }
    expect(section2.providers[0].set).toBe(false)
    expect(section2.providers[0].validated).toBe(true)
  })

  test("--no-validate-byok (validateByok=false): fetch is never called", async () => {
    const orgId = await freshOrg()
    const apiKey = `sk-ant-${crypto.randomUUID()}NOVAL1`
    const spy = spyDeps()
    await createByokProvisioner(spy.deps).apply(
      ctxFor(orgId, { validateByok: false }),
      { actions: [] },
      { org: { slug: "x", name: "X" }, byok: { anthropic: { apiKey } } },
    )
    expect(spy.fetchCalls.length).toBe(0)
  })

  test("per-provider validate:false skips the network call even when global validate is on", async () => {
    const orgId = await freshOrg()
    const apiKey = `sk-ant-${crypto.randomUUID()}PROVNO`
    const spy = spyDeps()
    await createByokProvisioner(spy.deps).apply(
      ctxFor(orgId, { validateByok: true }),
      { actions: [] },
      { org: { slug: "x", name: "X" }, byok: { anthropic: { apiKey, validate: false } } },
    )
    expect(spy.fetchCalls.length).toBe(0)
  })

  test("no-secret: the plaintext key appears in NEITHER the report NOR any logged line", async () => {
    const orgId = await freshOrg()
    const apiKey = `sk-ant-${crypto.randomUUID()}SECRET-DO-NOT-LEAK`
    const logs: string[] = []
    const spy = spyDeps()
    const result = await createByokProvisioner(spy.deps).apply(
      ctxFor(orgId, { validateByok: true, log: (m) => logs.push(m) }),
      { actions: [] },
      { org: { slug: "x", name: "X" }, byok: { anthropic: { apiKey } } },
    )
    const reportJson = JSON.stringify(result)
    expect(reportJson.includes(apiKey)).toBe(false)
    for (const line of logs) expect(line.includes(apiKey)).toBe(false)
  })

  test("writing an 'exa' BYOK key live-registers the kernel web_search tool for that org (no restart)", async () => {
    const orgId = await freshOrg()
    const origKey = process.env.EXA_API_KEY
    const origOrKey = process.env.OPENROUTER_API_KEY
    delete process.env.EXA_API_KEY
    // OpenRouter is the fallback search backend: "no search key" means neither.
    delete process.env.OPENROUTER_API_KEY
    try {
      const { toolRegistry } = await import("~/modules/apps/app-registries")
      const { registerKernelAgentTools } = await import("~/modules/agent/tools/kernel-tools")
      await registerKernelAgentTools(orgId)
      // No Exa key anywhere yet — web_search must be absent right after registration.
      expect(toolRegistry.get([orgId, "kernel", "web_search"])).toBeUndefined()

      const apiKey = `exa-${crypto.randomUUID()}`
      await createByokProvisioner(spyDeps().deps).apply(
        ctxFor(orgId, { validateByok: false }),
        { actions: [] },
        { org: { slug: "x", name: "X" }, byok: { exa: { apiKey } } },
      )

      // The provisioner's own write path re-evaluates web_search registration —
      // it must now be visible without any re-registration call on our part.
      expect(toolRegistry.get([orgId, "kernel", "web_search"])).toBeDefined()
    } finally {
      if (origKey) process.env.EXA_API_KEY = origKey
      if (origOrKey) process.env.OPENROUTER_API_KEY = origOrKey
      const { toolRegistry } = await import("~/modules/apps/app-registries")
      toolRegistry.deleteByPrefix([orgId])
    }
  })

  test("writing an 'openrouter' BYOK key live-registers web_search too (its fallback backend)", async () => {
    const orgId = await freshOrg()
    const origKey = process.env.EXA_API_KEY
    const origOrKey = process.env.OPENROUTER_API_KEY
    delete process.env.EXA_API_KEY
    // OpenRouter is the fallback search backend: "no search key" means neither.
    delete process.env.OPENROUTER_API_KEY
    try {
      const { toolRegistry } = await import("~/modules/apps/app-registries")
      const { registerKernelAgentTools } = await import("~/modules/agent/tools/kernel-tools")
      await registerKernelAgentTools(orgId)
      // No search key anywhere yet — web_search must be absent right after registration.
      expect(toolRegistry.get([orgId, "kernel", "web_search"])).toBeUndefined()

      const apiKey = `sk-or-${crypto.randomUUID()}`
      await createByokProvisioner(spyDeps().deps).apply(
        ctxFor(orgId, { validateByok: false }),
        { actions: [] },
        { org: { slug: "x", name: "X" }, byok: { openrouter: { apiKey } } },
      )

      // The provisioner's own write path re-evaluates web_search registration —
      // it must now be visible without any re-registration call on our part.
      expect(toolRegistry.get([orgId, "kernel", "web_search"])).toBeDefined()
    } finally {
      if (origKey) process.env.EXA_API_KEY = origKey
      if (origOrKey) process.env.OPENROUTER_API_KEY = origOrKey
      const { toolRegistry } = await import("~/modules/apps/app-registries")
      toolRegistry.deleteByPrefix([orgId])
    }
  })
})
