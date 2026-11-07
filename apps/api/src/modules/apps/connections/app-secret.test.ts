// SPDX-License-Identifier: FSL-1.1-ALv2
//
// App-held secret capability: a provider-minted secret (e.g. a webhook signing secret returned
// once by the provider's subscription API) is stored by the app through `ctx.config.setSecret`
// under a key its manifest declares, encrypted at rest in kernel.apps.config, and read back in
// plaintext only through the app's own `config_get` bridges (its handlers and, with the same
// decryption, its webhook verifier). An undeclared key is refused; the value never reaches a log.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { rootLogger } from "~/lib/logger"
import { decryptConnectionConfigValue } from "~/modules/apps/connections/service"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"

const ORG = randomUUID()
const APP = "secretapp"
const SECRET = "provider-minted-signing-secret-7f3a"
const connections = {
  provider: {
    type: "credentials",
    allowedDomains: ["x.example"],
    appSecretConfigKeys: ["hookSecret"],
  },
}
const manifest = { name: APP, schema: {}, events: {}, connections, network: {} }

// A system bridge's privileged transaction lives on the jobs pool (event and
// job handlers), so the secret store's own short privileged write is no nested
// acquisition on the privileged pool.
function onJobsPool<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
  return withPrivilegedDb(ORG, "test", fn, { pool: "jobs" })
}

function bridge(tx: unknown) {
  return createRpcBridge(APP, "system", ORG, tx as never, manifest as never, [`${APP}:*`], "system")
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Secret Org', ${`sec-${ORG.slice(0, 8)}`})`
  await sql`INSERT INTO kernel.apps (id, org_id, name, version, status, config)
    VALUES (gen_random_uuid(), ${ORG}, ${APP}, '1.0.0', 'active', '{"plain":"kept"}'::jsonb)`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.apps WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

describe("app-held secrets", () => {
  it("refuses a key the manifest does not declare", async () => {
    const err = await onJobsPool((tx) => bridge(tx).config_setSecret("otherKey", SECRET)).catch(
      (e: Error & { code?: string }) => e,
    )
    expect((err as Error & { code?: string }).code).toBe("forbidden")
    const [row] = await sql<
      Array<{ config: Record<string, unknown> }>
    >`SELECT config FROM kernel.apps WHERE org_id = ${ORG} AND name = ${APP}`
    expect(row!.config.otherKey).toBeUndefined()
  })

  it("stores a declared secret encrypted, keeps other keys, and gives the plaintext back to the app's own readers only", async () => {
    const lines: string[] = []
    const stream = (rootLogger as unknown as Record<symbol, { write: (s: string) => void }>)[
      Symbol.for("pino.stream")
    ]
    const origWrite = stream?.write?.bind(stream)
    if (stream && origWrite) stream.write = (s: string) => (lines.push(s), origWrite(s))
    try {
      await onJobsPool((tx) => bridge(tx).config_setSecret("hookSecret", SECRET))
      const [row] = await sql<
        Array<{ config: Record<string, unknown> }>
      >`SELECT config FROM kernel.apps WHERE org_id = ${ORG} AND name = ${APP}`
      const stored = String(row!.config.hookSecret)
      expect(stored).not.toContain(SECRET)
      expect(row!.config.plain).toBe("kept")
      // Handler read path (ctx.config.get).
      const viaHandler = await onJobsPool((tx) => bridge(tx).config_get("hookSecret"))
      expect(viaHandler).toBe(SECRET)
      // Verifier read path (webhooks/routes.ts config_get decrypts with the registration's manifest).
      expect(
        decryptConnectionConfigValue(ORG, APP, "hookSecret", stored, undefined, connections),
      ).toBe(SECRET)
      // Another app's declarations do not decrypt it.
      expect(
        decryptConnectionConfigValue(ORG, "other", "hookSecret", stored, undefined, {
          p: { appSecretConfigKeys: [] },
        }),
      ).toBe(stored)
    } finally {
      if (stream && origWrite) stream.write = origWrite
    }
    expect(lines.join("\n")).not.toContain(SECRET)
  })

  it("refuses an empty value", async () => {
    const err = await onJobsPool((tx) => bridge(tx).config_setSecret("hookSecret", "")).catch(
      (e: Error & { code?: string }) => e,
    )
    expect((err as Error & { code?: string }).code).toBe("invalid_input")
  })
})
