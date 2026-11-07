// SPDX-License-Identifier: FSL-1.1-ALv2
//
// files_importFromUrl, `credentials: "first-hop-only"`: the app's credential goes to the first
// host only; a redirect (a presigned storage URL) is followed with no request header at all; every
// hop's host must be an exact allow-list entry (a wildcard entry never reaches a hop in this
// mode); a private address is refused; the 25 MB cap holds whether or not the upstream declares
// its length; one audit line names the hosts, size and fingerprint, never a header or a URL query.
// And the target: a provider-contract op may store onto its CALLER's parent, nothing else may.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { manifestFileParentRegistry } from "~/modules/apps/app-registries"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { createFilesMethods } from "~/modules/apps/sandbox/bridge/files"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"

const ORG = randomUUID()
const FIRST = "example.com"
const SECOND = "www.example.com"
const TOKEN = "first-host-bearer-token"
const BYTES = new Uint8Array(Array.from({ length: 3000 }, (_, i) => (i * 13) % 256))
const SHA = createHash("sha256").update(BYTES).digest("hex")
const SIGNED = `https://${SECOND}/bucket/object.xml?X-Signature=abcdef0123456789`

// The parents live in a fixture schema with real RLS: the provider's own record is visible to
// its job context, the caller's records are not (only the bound one, through the kernel's
// privileged check).
const FIXTURE_SCHEMA = `iu_${ORG.slice(0, 8)}`
const PARENT = {
  tableName: "provider_docs",
  schemaRef: FIXTURE_SCHEMA,
  joinOn: "id",
  readScope: "provider:docs:read",
  writeScope: "provider:docs:write",
}
const CALLER_PARENT = { ...PARENT, tableName: "caller_docs" }

type Bound = { app: string; entityType: string; entityId: string }

function files(
  opts: {
    allowedDomains?: string[]
    contractCallerApp?: string
    contractFileTarget?: Bound
    allowPrivate?: boolean
  } = {},
  txDb: unknown,
) {
  return createFilesMethods({
    orgId: ORG,
    userId: "system",
    appName: "provider",
    allowedDomains: opts.allowedDomains ?? [FIRST, SECOND],
    manifest: {
      name: "provider",
      network: { allowPrivateHostsInTest: opts.allowPrivate ?? false },
    },
    bridgeOptions: {
      ...(opts.contractCallerApp ? { contractCallerApp: opts.contractCallerApp } : {}),
      ...(opts.contractFileTarget ? { contractFileTarget: opts.contractFileTarget } : {}),
    },
    schemaName: "app_provider",
    txDb,
    assertMailboxNotResetMidRun: async () => {},
  } as unknown as BridgeContext) as Record<string, (json: string) => Promise<string>>
}

type Seen = { url: string; authorization: string | null }

/** First host answers 302 to `location`; any other URL answers the bytes. */
function upstream(
  location = SIGNED,
  final: () => Response = () =>
    new Response(BYTES, { status: 200, headers: { "content-type": "application/xml" } }),
): Seen[] {
  const seen: Seen[] = []
  SandboxBridgeTestAccess.setFetch((async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    seen.push({ url, authorization: new Headers(init?.headers as never).get("authorization") })
    if (new URL(url).hostname === FIRST)
      return new Response(null, { status: 302, headers: { location } })
    return final()
  }) as unknown as typeof fetch)
  return seen
}

const importArgs = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    targetApp: "provider",
    targetEntityType: "doc",
    targetEntityId: ORG,
    url: `https://${FIRST}/files/123/original`,
    filename: "original.xml",
    headers: { Authorization: `Bearer ${TOKEN}` },
    credentials: "first-hop-only",
    ...extra,
  })

async function run(
  fn: (m: Record<string, (json: string) => Promise<string>>) => Promise<string>,
  opts?: Parameters<typeof files>[0],
) {
  // A production bridge runs on the run's RLS session (the provider's own scopes), never on a
  // privileged slot: the bound caller target's privileged read is then the only one.
  return withRlsContext(
    { actorType: "system", orgId: ORG, purpose: "job", scopes: ["provider:*"] },
    (tx) => fn(files(opts, tx)),
  )
}

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const child = rootLogger.child.bind(rootLogger)
  ;(rootLogger as { child: unknown }).child = (bindings: Record<string, unknown>) => {
    const c = child(bindings)
    const info = c.info.bind(c)
    ;(c as { info: unknown }).info = (obj: unknown, msg?: string) => {
      lines.push(JSON.stringify({ bindings, obj, msg }))
      return info(obj as never, msg as never)
    }
    return c
  }
  return { lines, restore: () => ((rootLogger as { child: unknown }).child = child) }
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Import Url Org', ${`iu-${ORG.slice(0, 8)}`})`
  const fs = `"${schemaRef(FIXTURE_SCHEMA)}"`
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${fs}`)
  await sql.unsafe(`GRANT USAGE ON SCHEMA ${fs} TO liaison_rls, liaison_admin`)
  for (const t of ["provider_docs", "caller_docs"]) {
    await sql.unsafe(`CREATE TABLE ${fs}.${t} (id uuid PRIMARY KEY, org_id uuid NOT NULL)`)
    await sql.unsafe(`ALTER TABLE ${fs}.${t} ENABLE ROW LEVEL SECURITY`)
    await sql.unsafe(`GRANT SELECT ON ${fs}.${t} TO liaison_rls, liaison_admin`)
    await sql.unsafe(`INSERT INTO ${fs}.${t} (id, org_id) VALUES ('${ORG}', '${ORG}')`)
  }
  await sql.unsafe(
    `CREATE POLICY provider_docs_org ON ${fs}.provider_docs FOR SELECT TO liaison_rls USING (org_id = NULLIF(rls_ctx.org_id(), '')::uuid)`,
  )
  manifestFileParentRegistry.set([ORG, "provider", "doc"], PARENT)
  manifestFileParentRegistry.set([ORG, "caller", "received"], {
    ...CALLER_PARENT,
    readScope: "caller:docs:read",
    writeScope: "caller:docs:write",
  })
  // Another parent type of the caller (a legal original): never reachable from a contract op.
  manifestFileParentRegistry.set([ORG, "caller", "legal_original"], {
    ...CALLER_PARENT,
    readScope: "caller:docs:read",
    writeScope: "caller:docs:write",
  })
})

afterEach(() => SandboxBridgeTestAccess.setFetch(null))

afterAll(async () => {
  await sql`DELETE FROM kernel.files WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaRef(FIXTURE_SCHEMA)}" CASCADE`)
})

describe("files_importFromUrl credentials: first-hop-only", () => {
  it("sends the bearer to the first host only, follows the redirect without it, stores the exact bytes", async () => {
    const seen = upstream()
    const cap = captureLogs()
    let out: { id: string; sizeBytes: number }
    try {
      out = JSON.parse(await run((m) => m.files_importFromUrl!(importArgs())))
    } finally {
      cap.restore()
    }
    expect(seen).toEqual([
      { url: `https://${FIRST}/files/123/original`, authorization: `Bearer ${TOKEN}` },
      { url: SIGNED, authorization: null },
    ])
    expect(out.sizeBytes).toBe(BYTES.byteLength)
    expect((out as { sha256?: string }).sha256).toBe(SHA)
    const [row] = await sql<
      Array<{ app: string; size_bytes: string }>
    >`SELECT app, size_bytes FROM kernel.files WHERE id = ${out.id}`
    expect(row).toMatchObject({ app: "provider" })
    const audit = cap.lines.filter((l) => l.includes("first-hop-only download"))
    expect(audit).toHaveLength(1)
    expect(audit[0]).toContain(SHA)
    expect(audit[0]).toContain(FIRST)
    expect(audit[0]).toContain(SECOND)
    expect(audit[0]).not.toContain(TOKEN)
    expect(audit[0]).not.toContain("X-Signature")
  })

  it("a redirect to a host that is not listed is refused, nothing is fetched from it", async () => {
    const seen = upstream("https://example.org/elsewhere")
    const err = await run((m) => m.files_importFromUrl!(importArgs())).catch((e: Error) => e)
    expect(String((err as Error).message)).toMatch(/allowlist/)
    expect(seen.map((s) => new URL(s.url).hostname)).toEqual([FIRST])
  })

  it("a wildcard entry never reaches a hop in this mode (it does without the mode)", async () => {
    upstream()
    const err = await run((m) => m.files_importFromUrl!(importArgs()), {
      allowedDomains: [FIRST, "*.example.com"],
    }).catch((e: Error) => e)
    expect(String((err as Error).message)).toMatch(/exact host required/)
    // Uncredentialed and without the mode, the wildcard reaches the second host as before.
    const seen = upstream()
    const ok = JSON.parse(
      await run(
        (m) => m.files_importFromUrl!(importArgs({ credentials: undefined, headers: {} })),
        { allowedDomains: [FIRST, "*.example.com"] },
      ),
    )
    expect(ok.sizeBytes).toBe(BYTES.byteLength)
    expect(seen).toHaveLength(2)
  })

  it("a redirect to a private address is refused (literal IP and a name resolving to one)", async () => {
    for (const [location, domains] of [
      ["https://10.0.0.7/object", [FIRST, "10.0.0.7"]],
      ["https://localhost/object", [FIRST, "localhost"]],
    ] as const) {
      const seen = upstream(location)
      const err = await run((m) => m.files_importFromUrl!(importArgs()), {
        allowedDomains: [...domains],
      }).catch((e: Error) => e)
      expect(String((err as Error).message)).toMatch(/private/i)
      expect(seen).toHaveLength(1)
    }
  })

  it("without the mode, a credentialed request still never follows a redirect", async () => {
    const seen = upstream()
    const err = await run((m) =>
      m.files_importFromUrl!(importArgs({ credentials: undefined })),
    ).catch((e: Error) => e)
    expect(String((err as Error).message)).toMatch(/redirect/i)
    expect(seen).toHaveLength(1)
  })

  it("over 25 MB is refused, declared or streamed", async () => {
    const big = 25 * 1024 * 1024 + 1
    upstream(
      SIGNED,
      () =>
        new Response(new Uint8Array(16), {
          status: 200,
          headers: { "content-length": String(big) },
        }),
    )
    const declared = await run((m) => m.files_importFromUrl!(importArgs())).catch((e: Error) => e)
    expect(String((declared as Error).message)).toBe("file_too_large")
    upstream(SIGNED, () => {
      let sent = 0
      const chunk = new Uint8Array(1024 * 1024)
      return new Response(
        new ReadableStream({
          pull(c) {
            if (sent > 26) return c.close()
            sent += 1
            c.enqueue(chunk)
          },
        }),
        { status: 200 },
      )
    })
    const streamed = await run((m) => m.files_importFromUrl!(importArgs())).catch((e: Error) => e)
    expect(String((streamed as Error).message)).toBe("file_too_large")
  })

  it("an unknown credentials mode is refused", async () => {
    const seen = upstream()
    const err = await run((m) =>
      m.files_importFromUrl!(importArgs({ credentials: "all-hops" })),
    ).catch((e: Error) => e)
    expect(String((err as Error).message)).toBe("invalid_credentials_mode")
    expect(seen).toHaveLength(0)
  })
})

describe("files_importFromUrl target: the one caller record bound to the contract dispatch", () => {
  const toCaller = importArgs({ targetApp: "caller", targetEntityType: "received" })
  const bound: Bound = { app: "caller", entityType: "received", entityId: ORG }
  const inDispatch = { contractCallerApp: "caller", contractFileTarget: bound }

  it("is refused outside a contract dispatch", async () => {
    const seen = upstream()
    const err = await run((m) => m.files_importFromUrl!(toCaller)).catch((e: Error) => e)
    expect(String((err as Error).message)).toContain("cross-app")
    expect(seen).toHaveLength(0)
  })

  it("is refused in a contract op that binds no file target (any op but the file fetch)", async () => {
    const seen = upstream()
    const err = await run((m) => m.files_importFromUrl!(toCaller), {
      contractCallerApp: "caller",
    }).catch((e: Error) => e)
    expect(String((err as Error).message)).toContain("cross-app")
    expect(seen).toHaveLength(0)
  })

  it("is stored onto the bound record; files_importAttachment itself still refuses it", async () => {
    upstream()
    const out = JSON.parse(await run((m) => m.files_importFromUrl!(toCaller), inDispatch))
    const [row] = await sql<
      Array<{ app: string; entity_type: string; entity_id: string }>
    >`SELECT app, entity_type, entity_id::text AS entity_id FROM kernel.files WHERE id = ${out.id}`
    expect(row).toEqual({ app: "caller", entity_type: "received", entity_id: ORG })
    const direct = await run(
      (m) =>
        m.files_importAttachment!(
          JSON.stringify({
            targetApp: "caller",
            targetEntityType: "received",
            targetEntityId: ORG,
            filename: "x.xml",
            mimeType: "application/xml",
            bytesBase64: Buffer.from("<x/>").toString("base64"),
            callerTargetPass: "forged",
          }),
        ),
      inDispatch,
    ).catch((e: Error) => e)
    expect(String((direct as Error).message)).toContain("cross-app")
  })

  it("another parent type of the caller (a legal original) is refused even inside the dispatch", async () => {
    const seen = upstream()
    const err = await run(
      (m) =>
        m.files_importFromUrl!(
          importArgs({ targetApp: "caller", targetEntityType: "legal_original" }),
        ),
      inDispatch,
    ).catch((e: Error) => e)
    expect(String((err as Error).message)).toContain("cross-app")
    expect(seen).toHaveLength(0)
  })

  it("another record of the bound type is refused even inside the dispatch", async () => {
    const seen = upstream()
    const err = await run(
      (m) =>
        m.files_importFromUrl!(
          importArgs({
            targetApp: "caller",
            targetEntityType: "received",
            targetEntityId: randomUUID(),
          }),
        ),
      inDispatch,
    ).catch((e: Error) => e)
    expect(String((err as Error).message)).toContain("cross-app")
    expect(seen).toHaveLength(0)
  })
})
