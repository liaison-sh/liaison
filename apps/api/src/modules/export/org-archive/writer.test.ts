// SPDX-License-Identifier: FSL-1.1-ALv2
// The whole-org archive (S3.2-S3.5, A10, A13, A17, A20, A27): every org table
// (zero-row ones included), nothing of another org, secrets null, files
// byte-equal under safe names, the documented encoding, sealed values counted,
// the size guards failing the export cleanly, and bounded memory.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { unzipSync } from "fflate"
import { sql } from "~/db"
import { withPrivilegedDb, withSchemaAdmin } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import {
  deleteObject,
  getObjectBuffer,
  headObject,
  putObject,
} from "~/infra/storage/object-storage"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { discoverExportTables } from "~/modules/export/org-archive/catalog"
import { processOrgExportJob } from "~/modules/export/org-archive/job"
import { createOrgExport, getOrgExport } from "~/modules/export/org-archive/store"
import {
  buildOrgArchive,
  type OrgArchiveManifest,
  orgExportObjectKey,
} from "~/modules/export/org-archive/writer"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const tag = () => crypto.randomUUID().slice(0, 8)
const createdKeys: string[] = []

let orgA = ""
let orgB = ""
let adminA = ""
let userB = ""

async function addFile(
  orgId: string,
  filename: string,
  body: Uint8Array,
  extra: { encVersion?: number; wrapped?: Buffer } = {},
): Promise<string> {
  const id = crypto.randomUUID()
  const key = `orgs/${orgId}/test-export/${id}`
  await putObject({ key, body, contentType: "application/octet-stream" })
  createdKeys.push(key)
  await withPrivilegedDb(orgId, "test-org-export-file", (tx) =>
    tx.execute(drizzleSql`
      INSERT INTO kernel.files (id, org_id, app, entity_type, entity_id, filename, mime_type,
        size_bytes, storage_key, enc_version, content_key_wrapped)
      VALUES (${id}, ${orgId}, 'kernel', 'thread', ${crypto.randomUUID()}, ${filename},
        'application/octet-stream', ${body.byteLength}, ${key}, ${extra.encVersion ?? 0},
        ${extra.wrapped ?? null})
    `),
  )
  return id
}

function ndjson(files: Record<string, Uint8Array>, name: string): Record<string, unknown>[] {
  const raw = files[name]
  if (!raw) throw new Error(`no ${name} in the archive`)
  return new TextDecoder()
    .decode(raw)
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

async function exportOf(orgId: string) {
  const exportId = crypto.randomUUID()
  const res = await buildOrgArchive({ orgId, exportId })
  createdKeys.push(res.objectKey)
  const files = unzipSync(new Uint8Array(await getObjectBuffer(res.objectKey)))
  return { ...res, files }
}

beforeAll(async () => {
  await acquireTestLock()
  orgA = (await ensureOrg({ slug: `oexp-a-${tag()}`, name: "Export Org A" })).orgId
  orgB = (await ensureOrg({ slug: `oexp-b-${tag()}`, name: "Export Org B" })).orgId
  adminA = (
    await ensureUser({
      orgId: orgA,
      email: `admin-${tag()}@fabrikam.example`,
      name: "Admin A",
      password: "pw-export-1!",
      role: "admin",
    })
  ).userId
  userB = (
    await ensureUser({
      orgId: orgB,
      email: `user-${tag()}@contoso.example`,
      name: "User B",
      password: "pw-export-2!",
      role: "member",
    })
  ).userId
  await sql`UPDATE kernel.users SET totp_secret = 'TOTPSECRET' WHERE id = ${adminA}`
  await sql`INSERT INTO kernel.user_preferences (user_id) VALUES (${adminA}) ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.user_preferences (user_id) VALUES (${userB}) ON CONFLICT DO NOTHING`
  await sql`
    UPDATE kernel.organizations
    SET settings = settings || ${JSON.stringify({
      providerKeys: { anthropic: { encrypted: "ENC-SECRET", preview: "sk-...abcd" } },
      integrations: { google: { oauthClient: { clientId: "x", clientSecretEncrypted: "ENC" } } },
    })}::jsonb
    WHERE id = ${orgA}`
}, 60_000)

afterAll(async () => {
  for (const k of createdKeys) await deleteObject(k).catch(() => undefined)
  await releaseTestLock()
})

describe("whole-org archive", () => {
  it("lists every org table of the catalog, zero-row tables included", async () => {
    const { manifest, files } = await exportOf(orgA)
    const catalog = await discoverExportTables()
    expect(manifest.tables.length).toBe(catalog.length)
    for (const t of manifest.tables) expect(files[t.file]).toBeDefined()
    const names = manifest.tables.map((t) => `${t.schema}.${t.table}`)
    // Direct org tables, the org row, and user-keyed tables (A27).
    for (const n of [
      "kernel.users",
      "kernel.organizations",
      "kernel.user_preferences",
      "kernel.role_scope_grants",
    ]) {
      expect(names).toContain(n)
    }
    expect(manifest.tables.some((t) => t.rows === 0)).toBe(true)
    expect(manifest.formatVersion).toBe(1)
    expect(manifest.org.id).toBe(orgA)
    expect(Object.keys(files)).toContain("manifest.json")
    expect(manifest.consistency).toContain("Not a point-in-time snapshot")
  })

  it("holds none of another org's rows", async () => {
    const { files } = await exportOf(orgA)
    const usersA = ndjson(files, "data/kernel.users.ndjson")
    expect(usersA.map((u) => u.id)).toContain(adminA)
    expect(usersA.some((u) => u.id === userB || u.org_id === orgB)).toBe(false)
    const prefs = ndjson(files, "data/kernel.user_preferences.ndjson")
    expect(prefs.map((p) => p.user_id)).toContain(adminA)
    expect(prefs.some((p) => p.user_id === userB)).toBe(false)
    const orgs = ndjson(files, "data/kernel.organizations.ndjson")
    expect(orgs.map((o) => o.id)).toEqual([orgA])
    const raw = new TextDecoder().decode(
      Buffer.concat(Object.values(files).map((f) => Buffer.from(f))),
    )
    expect(raw).not.toContain(orgB)
  })

  it("writes redacted columns and jsonb paths as null, and lists them", async () => {
    const { files, manifest } = await exportOf(orgA)
    const admin = ndjson(files, "data/kernel.users.ndjson").find((u) => u.id === adminA)
    expect(admin).toBeDefined()
    expect(admin?.password_hash).toBeNull()
    expect(admin?.totp_secret).toBeNull()
    expect(admin?.name).toBe("Admin A")
    const org = ndjson(files, "data/kernel.organizations.ndjson")[0] as {
      settings: Record<string, unknown>
    }
    expect(org.settings.providerKeys).toBeNull()
    expect(
      (org.settings.integrations as { google: Record<string, unknown> }).google.oauthClient,
    ).toBeNull()
    const raw = new TextDecoder().decode(
      Buffer.concat(Object.values(files).map((f) => Buffer.from(f))),
    )
    expect(raw).not.toContain("ENC-SECRET")
    expect(raw).not.toContain("TOTPSECRET")
    const redacted = manifest.redacted.columns.map((c) => c.column)
    expect(redacted).toContain("kernel.users.password_hash")
    expect(redacted).toContain("kernel.connected_accounts.access_token_encrypted")
    expect(manifest.redacted.jsonPaths.map((p) => p.path)).toContain("providerKeys")
  })

  it("includes every file byte-equal under a safe entry name, raw names in files.ndjson", async () => {
    const body = crypto.randomBytes(200_000)
    const fileId = await addFile(orgA, "../../x", body)
    const sealedId = await addFile(orgA, "sealed.bin", crypto.randomBytes(1000), {
      encVersion: 1,
      wrapped: Buffer.from([1, 2, 3, 250]),
    })
    const { files, manifest } = await exportOf(orgA)
    const entry = files[`files/${fileId}/x`]
    expect(entry).toBeDefined()
    expect(Buffer.from(entry as Uint8Array).equals(body)).toBe(true)
    expect(Object.keys(files).some((n) => n.includes(".."))).toBe(false)
    const index = ndjson(files, "files.ndjson")
    const line = index.find((l) => l.id === fileId)
    expect(line?.filename).toBe("../../x")
    expect(line?.entry).toBe(`files/${fileId}/x`)
    expect(manifest.files.count).toBeGreaterThanOrEqual(2)
    // Encoding (A13): bigint as a string, bytea base64, timestamps ISO UTC.
    const row = ndjson(files, "data/kernel.files.ndjson").find((r) => r.id === sealedId)
    expect(row?.size_bytes).toBe("1000")
    expect(row?.content_key_wrapped).toBe(Buffer.from([1, 2, 3, 250]).toString("base64"))
    expect(String(row?.created_at)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/)
    // Sealed content is exported as stored and counted (D12).
    expect(manifest.sealed.count).toBeGreaterThanOrEqual(1)
  })

  it("an archive past the entry limit fails EXPORT_TOO_LARGE and leaves no object", async () => {
    const row = await createOrgExport(orgB, { userId: null, via: "cli" })
    await processOrgExportJob({ orgId: orgB, exportId: row.id }, undefined, {
      zip: { maxEntries: 3 },
    })
    const after = await getOrgExport(orgB, row.id)
    expect(after?.status).toBe("failed")
    expect(after?.error).toContain("EXPORT_TOO_LARGE")
    expect(after?.error).toContain("3 entries")
    const runId = String(
      (await sql`SELECT run_id FROM kernel.org_exports WHERE id = ${row.id}`)[0]?.run_id,
    )
    expect(await headObject(orgExportObjectKey(orgB, row.id, runId)).catch(() => null)).toBeNull()
  })

  it("a completed job records size, manifest and a 7-day expiry", async () => {
    const row = await createOrgExport(orgB, { userId: null, via: "cli" })
    await processOrgExportJob({ orgId: orgB, exportId: row.id })
    const after = await getOrgExport(orgB, row.id)
    expect(after?.status).toBe("completed")
    expect(after?.objectKey).toBe(orgExportObjectKey(orgB, row.id, String(after?.runId)))
    if (after?.objectKey) createdKeys.push(after.objectKey)
    expect(after?.bytes).toBeGreaterThan(0)
    expect((after?.manifest as unknown as OrgArchiveManifest | undefined)?.org.id).toBe(orgB)
    const ttl = (after?.expiresAt?.getTime() ?? 0) - (after?.completedAt?.getTime() ?? 0)
    expect(Math.round(ttl / 3_600_000)).toBe(7 * 24)
  })
})

describe("server-key ciphertext and unreviewed columns", () => {
  it("nulls ciphertext inside the JSON columns keys-rotate knows (K1)", async () => {
    const enc = (v: string, ctx: string) => encryptSecret(v, env.ENCRYPTION_KEY, ctx)
    const secrets = {
      app: enc("app-config-secret", CryptoContext.appConfigConnectionSecret),
      meta: enc("account-metadata-secret", CryptoContext.appConfigConnectionSecret),
      org: enc("org-app-setting-secret", CryptoContext.orgSettingsSecret),
      user: enc("user-app-setting-secret", CryptoContext.orgSettingsSecret),
    }
    const appName = `oexp-app-${tag()}`
    await sql`INSERT INTO kernel.apps (org_id, name, version, config)
      VALUES (${orgA}, ${appName}, '0.0.1', ${JSON.stringify({
        webhook: { secret: secrets.app },
        mode: "live",
      })}::jsonb)`
    await sql`INSERT INTO kernel.connected_accounts
      (org_id, app_name, connection_name, owner_type, provider_type, identifier, created_by, metadata)
      VALUES (${orgA}, ${appName}, 'main', 'org', 'oauth2', ${`acct-${tag()}`}, ${adminA},
        ${JSON.stringify({ webhooks: [{ secret: secrets.meta }], label: "Main" })}::jsonb)`
    await sql`UPDATE kernel.organizations
      SET settings = settings || ${JSON.stringify({ [appName]: { apiKey: secrets.org } })}::jsonb
      WHERE id = ${orgA}`
    await sql`UPDATE kernel.users
      SET settings = settings || ${JSON.stringify({ [appName]: { token: secrets.user } })}::jsonb
      WHERE id = ${adminA}`
    const { files, manifest } = await exportOf(orgA)
    const raw = new TextDecoder().decode(
      Buffer.concat(Object.values(files).map((f) => Buffer.from(f))),
    )
    for (const [name, v] of Object.entries(secrets)) expect(raw.includes(v), name).toBe(false)
    const app = ndjson(files, "data/kernel.apps.ndjson").find((a) => a.name === appName) as {
      config: { webhook: { secret: unknown }; mode: string }
    }
    expect(app.config.webhook.secret).toBeNull()
    expect(app.config.mode).toBe("live")
    const admin = ndjson(files, "data/kernel.users.ndjson").find((u) => u.id === adminA) as {
      settings: Record<string, { token: unknown }>
    }
    expect(admin.settings[appName]?.token).toBeNull()
    const paths = manifest.redacted.jsonPaths.map((p) => `${p.column}:${p.path}`)
    for (const c of [
      "kernel.apps.config",
      "kernel.connected_accounts.metadata",
      "kernel.organizations.settings",
      "kernel.users.settings",
    ])
      expect(paths).toContain(`${c}:*`)
  }, 60_000)

  it("redacts a sensitive-looking column nobody reviewed in a real archive and names it (K10)", async () => {
    // A new app table with a column no list has decided on yet.
    const schema = schemaRef("app_oexp_probe")
    const ddl = (q: string) =>
      withSchemaAdmin(orgA, "test-org-export-probe", (tx) => tx.execute(drizzleSql.raw(q)))
    await ddl(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
    await ddl(`CREATE TABLE IF NOT EXISTS ${schema}.things (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, label text, api_token text)`)
    try {
      await ddl(
        `INSERT INTO ${schema}.things (org_id, label, api_token) VALUES ('${orgA}', 'kept', 'PROBE-VALUE-123')`,
      )
      const { files, manifest } = await exportOf(orgA)
      const [thing] = ndjson(files, "data/app_oexp_probe.things.ndjson")
      expect(thing?.label).toBe("kept")
      expect(thing && "api_token" in thing).toBe(true)
      expect(thing?.api_token).toBeNull()
      const named = manifest.redacted.columns.find(
        (c) => c.column === "app_oexp_probe.things.api_token",
      )
      expect(named?.why).toContain("not reviewed")
    } finally {
      await ddl(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    }
  }, 60_000)
})

/** A file stream that hands out `chunks` chunks, `delayMs` apart, calling `onChunk` first. */
function slowStream(
  chunks: number,
  delayMs: number,
  onChunk: (i: number) => Promise<void>,
): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (i >= chunks) {
        ctrl.close()
        return
      }
      await onChunk(i)
      await new Promise((r) => setTimeout(r, delayMs))
      ctrl.enqueue(new Uint8Array(1024).fill(i))
      i++
    },
  })
}

describe("the job's heartbeat and run token", () => {
  it("heartbeats while one slow file streams (K4)", async () => {
    const org = (await ensureOrg({ slug: `oexp-hb-${tag()}`, name: "Export HB" })).orgId
    await addFile(org, "slow.bin", new Uint8Array(16))
    const row = await createOrgExport(org, { userId: null, via: "cli" })
    let beatMs = 0
    await processOrgExportJob({ orgId: org, exportId: row.id }, undefined, {
      heartbeatMs: 100,
      openObject: async () =>
        slowStream(10, 120, async (i) => {
          if (i !== 9) return
          const [r] = await sql`
            SELECT extract(epoch FROM updated_at - started_at) * 1000 AS ms
            FROM kernel.org_exports WHERE id = ${row.id}`
          beatMs = Number(r?.ms ?? 0)
        }),
    })
    // About 1 s into one file, the row's heartbeat has moved on from the claim.
    expect(beatMs).toBeGreaterThan(500)
    const after = await getOrgExport(org, row.id)
    expect(after?.status).toBe("completed")
    if (after?.objectKey) createdKeys.push(after.objectKey)
  }, 60_000)

  it("a run whose row is taken over stops at its next check and leaves the row alone (K3)", async () => {
    const org = (await ensureOrg({ slug: `oexp-to-${tag()}`, name: "Export Takeover" })).orgId
    await addFile(org, "slow.bin", new Uint8Array(16))
    const row = await createOrgExport(org, { userId: null, via: "cli" })
    let oldRun = ""
    let newRun = ""
    let chunksAfterTakeover = 0
    const started = Date.now()
    await processOrgExportJob({ orgId: org, exportId: row.id }, undefined, {
      heartbeatMs: 100,
      openObject: async () =>
        slowStream(40, 100, async (i) => {
          if (i === 0) {
            const [r] = await sql`SELECT run_id FROM kernel.org_exports WHERE id = ${row.id}`
            oldRun = String(r?.run_id)
          } else if (i === 2) {
            // A redelivered job took the row over: a new run token.
            const [r] = await sql`
              UPDATE kernel.org_exports SET run_id = gen_random_uuid(), updated_at = now()
              WHERE id = ${row.id} RETURNING run_id`
            newRun = String(r?.run_id)
          } else if (i > 2) chunksAfterTakeover++
        }),
    })
    // It stopped long before its 40 chunks (4 s) were through.
    expect(Date.now() - started).toBeLessThan(3000)
    expect(chunksAfterTakeover).toBeLessThan(10)
    const after = await getOrgExport(org, row.id)
    // Neither completed nor failed by the old run: the new holder owns the row.
    expect(after?.status).toBe("running")
    expect(after?.runId).toBe(newRun)
    expect(after?.error).toBeNull()
    expect(after?.objectKey).toBeNull()
    expect(oldRun).not.toBe(newRun)
    expect(await headObject(orgExportObjectKey(org, row.id, oldRun)).catch(() => null)).toBeNull()
  }, 60_000)

  it("a failed run stores an error code, the internal message only in the audit (K8)", async () => {
    const org = (await ensureOrg({ slug: `oexp-err-${tag()}`, name: "Export Err" })).orgId
    await addFile(org, "f.bin", new Uint8Array(16))
    const row = await createOrgExport(org, { userId: null, via: "cli" })
    await processOrgExportJob({ orgId: org, exportId: row.id }, undefined, {
      openObject: async () => {
        throw new Error("connect ECONNREFUSED objectstore.internal:9000")
      },
    })
    const after = await getOrgExport(org, row.id)
    expect(after?.status).toBe("failed")
    expect(after?.error).toBe("INTERNAL")
    const [audit] = await sql`
      SELECT metadata FROM kernel.audit_log
      WHERE entity_id = ${row.id} AND action = 'org.export.failed'`
    expect(JSON.stringify(audit?.metadata)).toContain("objectstore.internal")
  }, 60_000)
})

describe("bounded memory", () => {
  it("peak RSS growth stays under 100 MB while exporting 2000 rows of 200 KB (K5)", async () => {
    const org = (await ensureOrg({ slug: `oexp-rows-${tag()}`, name: "Export Rows" })).orgId
    // 200 KB of JSON per row; compressible, so the test database stays small.
    await withPrivilegedDb(org, "test-org-export-big-rows", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO kernel.audit_log (org_id, actor_type, action, changes)
        SELECT ${org}::uuid, 'system', 'test.big_row',
          jsonb_build_object('blob', repeat(md5(g::text), 6250))
        FROM generate_series(1, 2000) g
      `),
    )
    Bun.gc(true)
    const baseline = process.memoryUsage().rss
    let peak = baseline
    const sampler = setInterval(() => {
      Bun.gc(true)
      peak = Math.max(peak, process.memoryUsage().rss)
    }, 100)
    try {
      const res = await buildOrgArchive({ orgId: org, exportId: crypto.randomUUID() })
      createdKeys.push(res.objectKey)
      const audit = res.manifest.tables.find((t) => t.table === "audit_log")
      expect(audit?.rows).toBeGreaterThanOrEqual(2000)
    } finally {
      clearInterval(sampler)
    }
    const growthMb = (peak - baseline) / (1024 * 1024)
    console.log(`org export RSS growth (large rows): ${growthMb.toFixed(1)} MB`)
    expect(growthMb).toBeLessThan(100)
  }, 600_000)

  it("peak RSS growth stays under 100 MB while exporting 300 MB of files", async () => {
    const org = (await ensureOrg({ slug: `oexp-rss-${tag()}`, name: "Export RSS" })).orgId
    const chunk = crypto.randomBytes(10 * 1024 * 1024)
    for (let i = 0; i < 30; i++) {
      chunk[0] = i
      await addFile(org, `big-${i}.bin`, chunk)
    }
    Bun.gc(true)
    const baseline = process.memoryUsage().rss
    let peak = baseline
    // Live memory, not garbage the collector has not reached yet: a full
    // collection before each sample (A30).
    const sampler = setInterval(() => {
      Bun.gc(true)
      peak = Math.max(peak, process.memoryUsage().rss)
    }, 100)
    try {
      const res = await buildOrgArchive({ orgId: org, exportId: crypto.randomUUID() })
      createdKeys.push(res.objectKey)
      expect(res.manifest.files.bytes).toBe(30 * 10 * 1024 * 1024)
      expect(res.bytes).toBeGreaterThan(300 * 1024 * 1024)
    } finally {
      clearInterval(sampler)
    }
    const growthMb = (peak - baseline) / (1024 * 1024)
    console.log(`org export RSS growth: ${growthMb.toFixed(1)} MB`)
    expect(growthMb).toBeLessThan(100)
  }, 600_000)
})
