// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pause } from "./pause"
import { settingsFor } from "./test-connections.testutil"
import { createMockDb } from "./test-db"

// ─── makeCtx helper ───────────────────────────────────────────────────────────

interface FetchCall {
  url: string
  method: string
  body?: string
}

interface MockResponse {
  status: number
  body: string
}

function makeCtx(fetchResponses: MockResponse[], db = createMockDb()) {
  const calls: FetchCall[] = []
  let idx = 0
  const fetch = async (url: string, opts?: Record<string, unknown>) => {
    calls.push({
      url,
      method: String(opts?.method ?? "GET"),
      body: typeof opts?.body === "string" ? opts.body : undefined,
    })
    const resp = fetchResponses[idx++]
    if (!resp) throw new Error(`No mock response for call ${idx} to ${url}`)
    return { status: resp.status, headers: {}, body: resp.body }
  }
  const connections = {
    meta: {
      getSettings: async () =>
        settingsFor("meta", {
          accessToken: "test_token",
          adAccountId: "act_123456",
        }),
    },
  }
  return { ctx: { fetch, connections, db, actorId: "user_1" }, calls, db }
}

// ─── pause — three-call contract (behavior unchanged; the gate lives in the kernel) ─

describe("pause", () => {
  // Three-call contract: GET pre-pause status → POST PAUSED → GET confirm.
  // The pre-pause GET returns status:ACTIVE; the post-pause GET returns PAUSED.
  function prePauseGet(id: string) {
    return {
      status: 200,
      body: JSON.stringify({ id, status: "ACTIVE", effective_status: "ACTIVE" }),
    }
  }
  function postPauseWrite() {
    return { status: 200, body: JSON.stringify({ success: true }) }
  }
  function confirmGet(id: string, eff = "PAUSED") {
    return { status: 200, body: JSON.stringify({ id, status: "PAUSED", effective_status: eff }) }
  }

  it("calls.length===3: GET pre-pause status → POST pause → GET confirm (never trust write echo)", async () => {
    const { ctx, calls } = makeCtx([prePauseGet("camp_1"), postPauseWrite(), confirmGet("camp_1")])
    await pause({ object_id: "camp_1" }, ctx)
    // CRITICAL: exactly 3 calls — the pre-pause GET captures the TRUE prior_status.
    expect(calls.length).toBe(3)
  })

  it("calls[0] is the GET pre-pause status read (BEFORE the POST)", async () => {
    const { ctx, calls } = makeCtx([prePauseGet("camp_1"), postPauseWrite(), confirmGet("camp_1")])
    await pause({ object_id: "camp_1" }, ctx)
    expect(calls[0]?.method).toBe("GET")
    expect(calls[0]?.url).toContain("/camp_1")
    expect(calls[0]?.url).toContain("effective_status")
  })

  it("calls[1] is the POST status=PAUSED write", async () => {
    const { ctx, calls } = makeCtx([prePauseGet("camp_1"), postPauseWrite(), confirmGet("camp_1")])
    await pause({ object_id: "camp_1" }, ctx)
    expect(calls[1]?.method).toBe("POST")
    expect(calls[1]?.body).toContain("PAUSED")
    expect(calls[1]?.url).toContain("/camp_1")
  })

  it("calls[2] is the GET confirm with fields=...effective_status", async () => {
    const { ctx, calls } = makeCtx([prePauseGet("camp_1"), postPauseWrite(), confirmGet("camp_1")])
    await pause({ object_id: "camp_1" }, ctx)
    expect(calls[2]?.method).toBe("GET")
    expect(calls[2]?.url).toContain("/camp_1")
    expect(calls[2]?.url).toContain("effective_status")
  })

  it("result carries effective_status from the confirm GET, not the write echo", async () => {
    const { ctx } = makeCtx([
      prePauseGet("adset_1"),
      postPauseWrite(),
      confirmGet("adset_1", "ADSET_PAUSED"),
    ])
    const result = (await pause({ object_id: "adset_1" }, ctx)) as { effective_status: string }
    expect(result.effective_status).toBe("ADSET_PAUSED")
  })

  it("ledger prior_status is the PRE-pause status (ACTIVE), captured before the POST", async () => {
    const db = createMockDb()
    const { ctx } = makeCtx([prePauseGet("adset_9"), postPauseWrite(), confirmGet("adset_9")], db)
    const result = (await pause({ object_id: "adset_9" }, ctx)) as { prior_status: string }
    // The ledger + result must record ACTIVE (the pre-pause read), never PAUSED.
    expect(result.prior_status).toBe("ACTIVE")
    const row = db.__all("pause_ledger")[0] as Record<string, unknown>
    expect(row.prior_status).toBe("ACTIVE")
  })

  it("writes a pause_ledger row with paused_by_us:true", async () => {
    const db = createMockDb()
    const { ctx } = makeCtx(
      [prePauseGet("adset_2"), postPauseWrite(), confirmGet("adset_2", "ADSET_PAUSED")],
      db,
    )
    await pause({ object_id: "adset_2", reason: "low-roas" }, ctx)
    const rows = db.__all("pause_ledger")
    expect(rows.length).toBe(1)
    expect((rows[0] as Record<string, unknown>).paused_by_us).toBe(true)
    expect((rows[0] as Record<string, unknown>).meta_object_id).toBe("adset_2")
    expect((rows[0] as Record<string, unknown>).reason).toBe("low-roas")
  })

  it("bulk: pausing object_ids[] makes 3 calls per object (pre-GET+write+confirm-GET each)", async () => {
    const { ctx, calls } = makeCtx([
      prePauseGet("camp_A"),
      postPauseWrite(),
      confirmGet("camp_A"),
      prePauseGet("camp_B"),
      postPauseWrite(),
      confirmGet("camp_B"),
    ])
    const result = (await pause({ object_ids: ["camp_A", "camp_B"] }, ctx)) as { paused: unknown[] }
    expect(calls.length).toBe(6) // 3 per object
    expect(result.paused).toHaveLength(2)
  })

  it("pause IS gated (gated:true + summarizer in manifest) — all pauses are approval-gated", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8"),
    ) as { tools: Record<string, { gated?: boolean; summarizer?: string; trustBoundary?: string }> }
    const pauseTool = manifest.tools.pause
    expect(pauseTool).toBeDefined()
    expect(pauseTool?.gated).toBe(true)
    expect(pauseTool?.summarizer).toBe("summarizePause")
    expect(pauseTool?.trustBoundary).toBe("user")
  })
})

// ─── Manifest schema pins — pause_ledger (product_ad_map removed with auto-pause) ─

describe("manifest schema — pause_ledger", () => {
  const MANIFEST_PATH = join(import.meta.dir, "..", "app.manifest.json")
  type SchemaTable = { rlsScope: string; fields: Record<string, unknown> }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
    schema: { pause_ledger: SchemaTable } & Record<string, SchemaTable>
  }

  it("product_ad_map table is gone (the stock-aware auto-pause feature was removed)", () => {
    expect(manifest.schema.product_ad_map).toBeUndefined()
  })

  it("pause_ledger table is declared with rlsScope:'internal' (reachable via the declared ads:internal scope, NOT a phantom :config scope)", () => {
    expect(manifest.schema.pause_ledger).toBeDefined()
    expect(manifest.schema.pause_ledger.rlsScope).toBe("internal")
  })

  it("pause_ledger has required fields: meta_object_id, prior_status, paused_by_us, reason", () => {
    const fields = manifest.schema.pause_ledger.fields
    expect(fields.meta_object_id).toBeTruthy()
    expect(fields.prior_status).toBeTruthy()
    expect(fields.paused_by_us).toBeTruthy()
    expect(fields.reason).toBeTruthy()
    // created_at is AUTO-INJECTED by the app DDL — declaring it in manifest fields
    // collides with the auto-injected column and breaks CREATE TABLE / app
    // registration. It must NOT be manifest-declared (the column still exists).
    expect(fields.created_at).toBeUndefined()
  })

  it("pause_ledger has optional resolved_at? field", () => {
    const fields = manifest.schema.pause_ledger.fields
    expect(fields.resolved_at).toBeTruthy()
    expect(String(fields.resolved_at)).toContain("?")
  })

  // ─── RLS-scope reachability pin (BL-278 regression) ───────────────────────────
  //
  // Every governed table's effective scope-entity (its `rlsScope` alias, else the
  // physical table name) MUST be reachable by at least ONE declared grantable scope
  // — otherwise no least-privilege role can satisfy the table's RLS and a tool that
  // touches it fails closed (500). This mirrors the api-side guard
  // `tablesUnreachableByGrantableScopes` (bundled-rls-scope-reachability.test.ts /
  // b4eadd80) self-containedly, because bundled apps must not import apps/api code.
  describe("RLS-scope reachability (BL-278)", () => {
    const APP = "ads"
    const fullManifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
      scopes: string[]
      schema: Record<string, { rlsScope?: string }>
    }

    // Mirrors rls-generator.scopeEntityReachableByGrant exactly.
    const scopeEntityReachableByGrant = (scopeEntity: string, grant: string): boolean =>
      grant === "*" ||
      grant === APP ||
      grant === `${APP}:*` ||
      grant === `${APP}:${scopeEntity}` ||
      grant === `${APP}:${scopeEntity}:read` ||
      grant === `${APP}:${scopeEntity}:write`

    const scopeEntityFor = (tableName: string, table: { rlsScope?: string }): string =>
      typeof table.rlsScope === "string" && table.rlsScope.length > 0 ? table.rlsScope : tableName

    const reachable = (tableName: string): boolean => {
      const entity = scopeEntityFor(tableName, fullManifest.schema[tableName] ?? {})
      return fullManifest.scopes.some((g) => scopeEntityReachableByGrant(entity, g))
    }

    it("pause_ledger is reachable by a declared grantable scope", () => {
      expect(reachable("pause_ledger")).toBe(true)
    })

    it("EVERY governed table in the manifest is reachable (no unreachable table is reintroduced)", () => {
      const unreachable = Object.keys(fullManifest.schema).filter((t) => !reachable(t))
      expect(unreachable).toEqual([])
    })

    it("the reachability check actually has teeth: a phantom :config scope-entity is unreachable", () => {
      // Guards the guard — proves an unreachable scope-entity is detected (so the
      // green above is not green-by-vacuity). 'config' has no matching declared scope.
      expect(fullManifest.scopes.some((g) => scopeEntityReachableByGrant("config", g))).toBe(false)
    })

    it("the declared ads:internal scope is what makes the internal tables reachable", () => {
      expect(fullManifest.scopes).toContain("ads:internal")
      expect(fullManifest.scopes.some((g) => scopeEntityReachableByGrant("internal", g))).toBe(true)
    })
  })
})
