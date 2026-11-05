// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 B7 — sandbox envelope translation at the `executeTool` boundary.
//
// We mock `~/modules/apps/execute-tool` so we can drive the three discriminant
// branches (`data` / `blocked` / `error`) deterministically without standing
// up a real registered tool. The bridge translation is the only seam under
// test here — `executeToolCore`'s own semantics are covered elsewhere.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import type { RlsClient } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
// HERMETICITY (mock.module global-leak class): the unit suite runs as ONE flat
// `bun test` process, and `mock.module()` replaces a module GLOBALLY for every
// later file — Bun's `mock.restore()` does NOT undo it. The previous PARTIAL
// stub (only `executeToolCore`) left later importers of
// `~/modules/apps/execute-tool` (e.g. the projects `tasks_byProject` tests,
// which call `executeTool`) with a module missing every other export → spurious
// failures only in the full suite. We defend BOTH ends: (1) spread the REAL
// module so the stub is COMPLETE (only `executeToolCore` is overridden — every
// other export, incl. `executeTool`, stays real), and (2) re-install the real
// module in `afterAll` so even that override does not leak past this file. See
// `mock-module-hygiene.test.ts` for the guard.
import * as realExecuteTool from "~/modules/apps/execute-tool"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const rlsDb = db as unknown as RlsClient

let nextEnvelope:
  | { data: unknown }
  | { blocked: { reason: string; approvalRequestId?: string; requesterCanApprove: boolean } }
  | { error: { code: string; message: string; retryable: boolean } } = {
  data: null,
}

// Eager snapshot: `realExecuteTool` is a LIVE namespace view, so mock.module
// patches it in place — spreading it inside the restore factory would re-install
// the mock. Snapshot the real exports BEFORE the mock so afterAll truly restores.
const realExecuteToolModule = { ...realExecuteTool }

mock.module("~/modules/apps/execute-tool", () => ({
  ...realExecuteToolModule,
  executeToolCore: async () => nextEnvelope,
}))

const { createRpcBridge } = await import("./rpc-bridge")

describe("rpc-bridge — K4 envelope translation (B7)", () => {
  beforeAll(async () => {
    await acquireTestLock()
  })
  afterAll(async () => {
    await releaseTestLock()
    // Re-install the real module so the override does not leak to later files.
    mock.module("~/modules/apps/execute-tool", () => realExecuteToolModule)
  })

  test("translates { data } → { status: 'completed', result } for apps with cross_app_calls", async () => {
    const org = await createTestOrg()
    const user = await minimal.person(org.id, { role: "admin" })
    nextEnvelope = { data: { ok: true, echoed: { hi: 1 } } }
    const bridge = createRpcBridge("invoicing", user.id, org.id, rlsDb, {
      name: "invoicing",
      capabilities: [],
      cross_app_calls: [{ target: "mail:compose", reason: "x" }],
    } as never)
    const raw = await bridge.executeTool("mail:compose", JSON.stringify({ hi: 1 }))
    expect(JSON.parse(raw)).toEqual({
      status: "completed",
      result: { ok: true, echoed: { hi: 1 } },
    })
  })

  test("translates { blocked } → { status: 'pending_approval', approval_id }", async () => {
    const org = await createTestOrg()
    const user = await minimal.person(org.id, { role: "admin" })
    const approvalId = "11111111-2222-3333-4444-555555555555"
    nextEnvelope = {
      blocked: {
        reason: "needs approval",
        approvalRequestId: approvalId,
        requesterCanApprove: false,
      },
    }
    const bridge = createRpcBridge("invoicing", user.id, org.id, rlsDb, {
      name: "invoicing",
      capabilities: [],
      cross_app_calls: [{ target: "mail:compose", reason: "x" }],
    } as never)
    const raw = await bridge.executeTool("mail:compose", JSON.stringify({}))
    expect(JSON.parse(raw)).toEqual({
      status: "pending_approval",
      approval_id: approvalId,
    })
  })

  test("translates { error } → { status: 'error', error: { code, message, retryable } } (K4 nested shape, BL-208)", async () => {
    const org = await createTestOrg()
    const user = await minimal.person(org.id, { role: "admin" })
    nextEnvelope = {
      error: { code: "internal_error", message: "kaboom", retryable: false },
    }
    const bridge = createRpcBridge("invoicing", user.id, org.id, rlsDb, {
      name: "invoicing",
      capabilities: [],
      cross_app_calls: [{ target: "mail:compose", reason: "x" }],
    } as never)
    const raw = await bridge.executeTool("mail:compose", JSON.stringify({}))
    const parsed = JSON.parse(raw)
    // The K4 `CrossAppEnvelope` error variant nests under `error` — consumers
    // read `env.error.{code,message}`. Pre-fix this was emitted FLAT, so the
    // real reason was dropped and surfaced as a bare "unknown error" (BL-208).
    expect(parsed).toEqual({
      status: "error",
      error: { code: "internal_error", message: "kaboom", retryable: false },
    })
    // Guard the exact property a consumer reads (boxtal shipment.ts, invoicing
    // deferred-dispatch) — it must be defined, not undefined.
    expect(parsed.error.message).toBe("kaboom")
    expect(parsed.error.code).toBe("internal_error")
  })

  test("legacy apps (no cross_app_calls declared) still observe { data | blocked | error }", async () => {
    const org = await createTestOrg()
    const user = await minimal.person(org.id, { role: "admin" })
    nextEnvelope = { data: { legacy: true } }
    const bridge = createRpcBridge("mail", user.id, org.id, rlsDb, {
      name: "mail",
      capabilities: [],
    } as never)
    const raw = await bridge.executeTool("tickets:createFromMail", JSON.stringify({}))
    expect(JSON.parse(raw)).toEqual({ data: { legacy: true } })
  })
})
