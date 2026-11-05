// SPDX-License-Identifier: FSL-1.1-ALv2
// Org moves between instances: the cell→Control lease messages (`move.heartbeat`,
// `move.status`) and the codes an instance answers its own clients while an org
// is moving (`org_moving`, websocket close `ORG_MOVING_WS_CLOSE`).
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  CELL_BILLING_ERROR_CODES,
  CELL_BILLING_MESSAGE_TYPES,
  canonicalJson,
  cellBillingMessageSchema,
  cellBillingMessageSchemas,
  cellBillingOkReplySchemas,
  cellBillingReplySchemas,
  MOVE_AGENT_PHASES,
  MOVE_LEASE_SECONDS,
  MOVE_MESSAGE_TYPES,
  MOVE_STATES,
  moneyVectors,
  ORG_MOVING_CODE,
  ORG_MOVING_RETRY_AFTER_SECONDS,
  ORG_MOVING_WS_CLOSE,
  orgMovingErrorSchema,
} from "./index"

const REPO = resolve(import.meta.dir, "../../..")

describe("move lease messages on the cell-billing channel", () => {
  test("two move types, both cell-billing message types", () => {
    expect([...MOVE_MESSAGE_TYPES]).toEqual(["move.heartbeat", "move.status"])
    for (const t of MOVE_MESSAGE_TYPES) expect(CELL_BILLING_MESSAGE_TYPES).toContain(t)
  })

  test("move states are the plan's phases, in order", () => {
    expect([...MOVE_STATES]).toEqual([
      "planned",
      "precopy",
      "draining",
      "frozen",
      "committed",
      "finalized",
      "aborted",
      "failed",
    ])
  })

  test("an agent heartbeats only from a phase before commit (commit is Control's CAS)", () => {
    expect([...MOVE_AGENT_PHASES]).toEqual(["planned", "precopy", "draining", "frozen"])
    const base = moneyVectors.cellBilling.valid["move.heartbeat"]
    for (const phase of ["committed", "finalized", "aborted", "failed"]) {
      const parsed = cellBillingMessageSchemas["move.heartbeat"].safeParse({
        ...base,
        data: { ...base.data, phase },
      })
      expect({ phase, ok: parsed.success }).toEqual({ phase, ok: false })
    }
  })

  test("the lease is 15 s, heartbeats every 2 s fit it many times", () => {
    expect(MOVE_LEASE_SECONDS).toBe(15)
  })

  test("both messages carry transferId (a uuid) besides requestId and orgId", () => {
    for (const type of MOVE_MESSAGE_TYPES) {
      const message = moneyVectors.cellBilling.valid[type]
      const { transferId: _t, ...rest } = message.data as Record<string, unknown>
      expect(cellBillingMessageSchemas[type].safeParse({ ...message, data: rest }).success).toBe(
        false,
      )
      expect(
        cellBillingMessageSchemas[type].safeParse({
          ...message,
          data: { ...message.data, transferId: "t-1" },
        }).success,
      ).toBe(false)
      expect(cellBillingMessageSchema.safeParse(message).success).toBe(true)
    }
  })

  test("replies name Control's state and the lease end; status may answer before any lease", () => {
    const hb = cellBillingOkReplySchemas["move.heartbeat"]
    expect(
      hb.safeParse({ ok: true, state: "frozen", leaseUntil: "2026-11-03T10:00:15.000Z" }).success,
    ).toBe(true)
    // A lapsed lease: Control answers the abort, the agent unfreezes.
    expect(hb.safeParse({ ok: true, state: "aborted", leaseUntil: null }).success).toBe(true)
    expect(hb.safeParse({ ok: true, state: "moving", leaseUntil: null }).success).toBe(false)
    const st = cellBillingOkReplySchemas["move.status"]
    expect(st.safeParse({ ok: true, state: "committed", leaseUntil: null }).success).toBe(true)
    expect(st.safeParse({ ok: true, state: "committed" }).success).toBe(false)
    // An unknown transfer is the uniform not_found error.
    expect(
      cellBillingReplySchemas["move.status"].safeParse({
        ok: false,
        code: CELL_BILLING_ERROR_CODES.notFound,
      }).success,
    ).toBe(true)
  })

  test("reply vectors parse and round-trip", () => {
    for (const type of MOVE_MESSAGE_TYPES) {
      for (const reply of moneyVectors.cellBilling.replies[type]) {
        const parsed = cellBillingReplySchemas[type].safeParse(reply)
        expect({ type, ok: parsed.success }).toEqual({ type, ok: true })
        expect(canonicalJson(parsed.data)).toBe(canonicalJson(reply))
      }
    }
  })
})

describe("org_moving: what an instance answers its own clients during a move", () => {
  test("the code, the retry delay and the 503 error object", () => {
    expect(ORG_MOVING_CODE).toBe("org_moving")
    expect(ORG_MOVING_RETRY_AFTER_SECONDS).toBe(2)
    expect(
      orgMovingErrorSchema.safeParse({ code: "org_moving", retryAfterSeconds: 2 }).success,
    ).toBe(true)
    expect(
      orgMovingErrorSchema.safeParse({ code: "org_moving", retryAfterSeconds: 2, message: "x" })
        .success,
    ).toBe(true)
    expect(
      orgMovingErrorSchema.safeParse({ code: "org_suspended", retryAfterSeconds: 2 }).success,
    ).toBe(false)
    expect(
      orgMovingErrorSchema.safeParse({ code: "org_moving", retryAfterSeconds: 0 }).success,
    ).toBe(false)
    expect(
      orgMovingErrorSchema.safeParse({ code: "org_moving", retryAfterSeconds: 2, extra: 1 })
        .success,
    ).toBe(false)
  })

  test("the websocket close code is a private-use code no other close uses", () => {
    expect(ORG_MOVING_WS_CLOSE).toBeGreaterThanOrEqual(4000)
    expect(ORG_MOVING_WS_CLOSE).toBeLessThan(5000)
    const sources = [
      "packages/shared/src/validation/org-kernel-settings.ts",
      "apps/api/src/lib/server.ts",
      "apps/web/src/primitives/createWebSocket.ts",
    ].map((p) => readFileSync(join(REPO, p), "utf8"))
    const used = new Set<number>()
    for (const src of sources) {
      for (const m of src.matchAll(/\b(4\d{3})\b/g)) used.add(Number(m[1]))
    }
    expect(used.has(ORG_MOVING_WS_CLOSE)).toBe(false)
  })
})
