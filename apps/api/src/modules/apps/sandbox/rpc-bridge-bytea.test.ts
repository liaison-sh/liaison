// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 1 Task 1.3: the sandbox db bridge must carry `bytea` columns as base64
// strings in both directions. A sandboxed handler writes base64, the bridge
// stores real bytes, and the read path hands base64 back. It must NEVER hand
// back a Buffer-shaped JSON object, because a handler that echoes a row would
// then push a bloated ciphertext blob into logs and events.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { generateTableDdl } from "../ddl"
import { createRpcBridge } from "./rpc-bridge"

const APP_NAME = "byteaprobe"
const SCHEMA = schemaRef(`app_${APP_NAME}`)

const manifest = {
  name: APP_NAME,
  capabilities: [],
  schema: {
    sealed: {
      fields: {
        label: "string",
        cipher: "bytea?",
      },
    },
  },
} as never

async function ensureTable(orgId: string) {
  await withPrivilegedDb(orgId, "bytea-bridge-test-schema", async (tx) => {
    await tx.execute(drizzleSql.raw(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`))
    const ddl = generateTableDdl(SCHEMA, "sealed", {
      label: "string",
      cipher: "bytea?",
    })
    for (const stmt of ddl.split(";\n")) {
      await tx.execute(drizzleSql.raw(stmt))
    }
  })
}

describe("rpc-bridge bytea marshalling", () => {
  beforeAll(async () => {
    await acquireTestLock()
  })
  afterAll(async () => {
    // The probe schema is a fixture, not part of any app. Drop it so it cannot
    // confuse a later schema-drift check.
    await withSystemDb("bytea-bridge-test-cleanup", async (tx) => {
      await tx.execute(drizzleSql.raw(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`))
    })
    await releaseTestLock()
  })

  test("round-trips a base64 payload through db_insert and db_findOne as base64, never as a Buffer", async () => {
    const org = await createTestOrg()
    const admin = await minimal.person(org.id, { role: "admin" })
    await ensureTable(org.id)

    // Deliberately includes bytes that are not valid UTF-8, so a lossy
    // text round-trip cannot pass.
    const plaintext = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 65, 66, 67])
    const base64 = Buffer.from(plaintext).toString("base64")
    expect(base64.length).toBeGreaterThan(0)

    const { insertedJson, foundJson, storedLength } = await withPrivilegedDb(
      org.id,
      "bytea-bridge-test",
      async (tx) => {
        const bridge = createRpcBridge(
          APP_NAME,
          admin.id,
          org.id,
          tx as unknown as RlsClient,
          manifest,
        )
        const insertedJson = await bridge.db_insert(
          "sealed",
          JSON.stringify({ label: "probe", cipher: base64 }),
        )
        const id = (JSON.parse(insertedJson) as { id: string }).id
        expect(id).toMatch(/^[0-9a-f-]{36}$/)
        const foundJson = await bridge.db_findOne("sealed", id)
        const rows = await tx.execute(
          drizzleSql.raw(
            `SELECT octet_length(cipher) AS len FROM "${SCHEMA}".sealed WHERE id = '${id}'`,
          ),
        )
        const list = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows) ?? []
        const storedLength = Number((list[0] as { len: number }).len)
        return { insertedJson, foundJson, storedLength }
      },
    )

    // The column holds real bytes, not the base64 text.
    expect(storedLength).toBe(plaintext.length)

    for (const json of [insertedJson, foundJson]) {
      expect(json).not.toContain('"type":"Buffer"')
      const row = JSON.parse(json) as { cipher: string }
      expect(typeof row.cipher).toBe("string")
      expect(Array.from(Buffer.from(row.cipher, "base64"))).toEqual(Array.from(plaintext))
    }
  })

  test("rejects a non-base64 string written to a bytea field", async () => {
    const org = await createTestOrg()
    const admin = await minimal.person(org.id, { role: "admin" })
    await ensureTable(org.id)

    await withPrivilegedDb(org.id, "bytea-bridge-test-reject", async (tx) => {
      const bridge = createRpcBridge(
        APP_NAME,
        admin.id,
        org.id,
        tx as unknown as RlsClient,
        manifest,
      )
      await expect(
        bridge.db_insert("sealed", JSON.stringify({ label: "probe", cipher: "not base64!!" })),
      ).rejects.toThrow(/invalid type: expected bytea/)
      await expect(
        bridge.db_insert("sealed", JSON.stringify({ label: "probe", cipher: 42 })),
      ).rejects.toThrow(/invalid type: expected bytea/)
    })
  })
})
