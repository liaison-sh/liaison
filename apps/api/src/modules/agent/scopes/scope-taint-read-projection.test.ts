// SPDX-License-Identifier: FSL-1.1-ALv2
//
// TAINT IS A DATA CLASSIFICATION: IT HOLDS NO WRITE OR ACTION SCOPE (scope-taint.ts, rule 5).
//
// Found on a long-lived coworker DM: one abnormal turn stamped its reply with the requester's
// whole effective scope, write and action scopes included (tickets:tickets:close,
// kernel:skills:write, kernel:agent:memory:write). History injection re-recorded that stamp
// every turn, every reply re-stamped the union and compaction summaries inherited it, so the
// taint could only grow and every later write was refused. These cases pin that every scope
// entering a taint or a stamp is projected onto the read scopes it implies, at each place one
// enters: the turn-end stamp (an abnormal end stamps what the turn read, 2026-11-03; the ceiling
// only when the accumulator was lost), history injection, compaction summaries, and the refusal
// the model reads.

import { describe, expect, test } from "bun:test"
import { summaryRequiredScopes } from "~/modules/agent/context/compaction"
import { turnEndRequiredScopes } from "~/modules/agent/runtime/agent-service"
import { failureContextRequiredScopes } from "~/modules/agent/runtime/reinvoke"
import { SCOPE_TAINT_BLOCKED_MESSAGE, UNKNOWN_TURN_TAINT } from "~/modules/agent/scopes/scope-taint"
import {
  expandWildcardStamp,
  isWildcardScope,
  taintReadCatalog,
  WRITE_ACTION_VERBS,
} from "~/modules/agent/scopes/taint-read-scopes"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import {
  REQUESTER_EFFECTIVE_SCOPE,
  REQUESTER_TAINT_PROJECTION,
} from "~/tests/helpers/requester-effective-scope"

/** The scopes whose action is a write or action verb: none may survive into a taint. */
const writeOrAction = (scopes: readonly string[]) =>
  scopes.filter((s) => WRITE_ACTION_VERBS.has(s.split(":").at(-1) ?? ""))

describe("scope taint holds no write or action scope", () => {
  test("the fixture is the 34-scope stamp, write and action scopes included", () => {
    expect(REQUESTER_EFFECTIVE_SCOPE).toHaveLength(34)
    expect(REQUESTER_EFFECTIVE_SCOPE).toContain("tickets:tickets:close")
    expect(REQUESTER_EFFECTIVE_SCOPE).toContain("kernel:skills:write")
    expect(REQUESTER_EFFECTIVE_SCOPE).toContain("kernel:agent:memory:write")
  })

  test("an abnormal end after a tool call stamps what the turn read, never the ceiling", () => {
    const accumulator = createTurnScopeAccumulator()
    accumulator.record({ requiredScopes: ["boxtal:shipments:write"] })
    const stamp = turnEndRequiredScopes({
      accumulator,
      fullEffectiveScope: REQUESTER_EFFECTIVE_SCOPE,
      requesterScopes: REQUESTER_EFFECTIVE_SCOPE,
    })
    // The tool's write scope lands on its read sibling; nothing of the ceiling is added.
    expect(stamp).toEqual(["boxtal:shipments:read"])
    expect(writeOrAction(stamp)).toEqual([])
    expect(writeOrAction(accumulator.snapshot())).toEqual([])
  })

  test("a lost accumulator falls back to the ceiling, projected onto read scopes", () => {
    const stamp = turnEndRequiredScopes({
      accumulator: undefined,
      fullEffectiveScope: REQUESTER_EFFECTIVE_SCOPE,
      requesterScopes: ["boxtal:shipments:read"],
    })
    expect(stamp).toEqual(REQUESTER_TAINT_PROJECTION)
    expect(writeOrAction(stamp)).toEqual([])
  })

  test("a lost accumulator with no ceiling projects the requester fallback", () => {
    const stamp = turnEndRequiredScopes({
      accumulator: undefined,
      fullEffectiveScope: undefined,
      requesterScopes: REQUESTER_EFFECTIVE_SCOPE,
    })
    expect(stamp).toEqual(REQUESTER_TAINT_PROJECTION)
  })

  test("the next turn's taint via history holds none either, even from an older unprojected stamp", () => {
    const nextTurn = createTurnScopeAccumulator()
    // What context assembly does with each earlier message read as history.
    nextTurn.recordInjected(REQUESTER_EFFECTIVE_SCOPE)
    expect(nextTurn.snapshot()).toEqual(REQUESTER_TAINT_PROJECTION)
  })

  test("a write or action scope lands on its catalogued read sibling, or is dropped without one", () => {
    const acc = createTurnScopeAccumulator()
    acc.recordInjected(["kernel:agent:memory:write", "tickets:tickets:close", "tickets:approve"])
    // tickets:approve's sibling, tickets:read, is no catalogued scope: dropped.
    expect(acc.snapshot()).toEqual(["kernel:agent:memory:read", "tickets:tickets:read"])
  })

  test("a scope whose action is not a write verb is kept as it is, fail closed, and so is the unknown sentinel", () => {
    const acc = createTurnScopeAccumulator()
    acc.recordInjected(["kernel:users:admin", "x4s:spawner:run", ...UNKNOWN_TURN_TAINT])
    expect(acc.snapshot()).toEqual(
      ["kernel:users:admin", "x4s:spawner:run", ...UNKNOWN_TURN_TAINT].sort(),
    )
  })

  // 2026-11-03: a `*` ceiling's abnormal-end widening, re-read as history, put `*` into every
  // later stamp of a long-lived chat, and a teammate holding `clevel` but not `*` could not see
  // the reply addressed to them (0249: a required `*` is covered only by the grant `*`).
  test("a grant wildcard never enters a taint: it lands on the catalogued read scopes it covers", () => {
    const acc = createTurnScopeAccumulator()
    acc.recordInjected(["*", "clevel", "*:approve", "kernel:threads:read"])
    const taint = acc.snapshot()
    expect(taint.filter(isWildcardScope)).toEqual([])
    expect(taint).toContain("clevel")
    // `*` covers every catalogued read scope, so the widening is as wide as before in what it
    // classifies: it never fails open.
    for (const read of taintReadCatalog()) expect(taint).toContain(read)
    const scoped = createTurnScopeAccumulator()
    scoped.recordInjected(["tickets:*", "*:read"])
    // `p:*` covers the read scopes under `p:`; a `*` anywhere but last covers nothing.
    expect(scoped.snapshot()).toEqual(
      taintReadCatalog()
        .filter((s) => s.startsWith("tickets:"))
        .sort(),
    )
    expect(scoped.snapshot().length).toBeGreaterThan(0)
  })

  test("an abnormal end on a `*` ceiling stamps no `*`, and neither does any message stamp", () => {
    const ceiling = ["*", "clevel", "kernel:agent:memory", "kernel:routines:run"]
    const acc = createTurnScopeAccumulator()
    acc.recordInjected(["boxtal:shipments:read"])
    // The turn's record survived: exactly what it read, none of the `*` ceiling.
    expect(
      turnEndRequiredScopes({
        accumulator: acc,
        fullEffectiveScope: ceiling,
        requesterScopes: ["*"],
      }),
    ).toEqual(["boxtal:shipments:read"])
    // The record was lost: the ceiling, its `*` expanded onto every catalogued read scope.
    const lost = turnEndRequiredScopes({ fullEffectiveScope: ceiling, requesterScopes: ["*"] })
    expect(lost.filter(isWildcardScope)).toEqual([])
    expect(lost).toContain("clevel")
    for (const read of taintReadCatalog()) expect(lost).toContain(read)
    const failure = turnEndRequiredScopes({ requesterScopes: ["*", "clevel"] })
    expect(failure.filter(isWildcardScope)).toEqual([])
    expect(failure).toContain("clevel")
    // What sendMessage stores whatever it is handed (a requester's own grant set).
    const stored = expandWildcardStamp(["*", "clevel", "mail:*"])
    expect(stored.filter(isWildcardScope)).toEqual([])
    expect(stored).toContain("clevel")
    expect(expandWildcardStamp(["clevel", "tickets:tickets:read"])).toEqual([
      "clevel",
      "tickets:tickets:read",
    ])
  })

  test("a compaction summary of such history holds no write or action scope", () => {
    const summary = summaryRequiredScopes([
      { requiredScopes: REQUESTER_EFFECTIVE_SCOPE },
      { requiredScopes: ["boxtal:shipments:read"] },
    ])
    expect(summary).toEqual(REQUESTER_TAINT_PROJECTION)
  })
})

describe("a failure notice's stamp holds no grant wildcard (rule 10b)", () => {
  test("the requester's `*` is expanded onto the read scopes it covers, never stamped as is", () => {
    const stamp = failureContextRequiredScopes(["*", "kernel:threads:read"])
    expect(stamp.filter(isWildcardScope)).toEqual([])
    for (const read of taintReadCatalog()) expect(stamp).toContain(read)
    expect(stamp).toEqual([...stamp].sort())
    expect(failureContextRequiredScopes(["b:c:read", "a:b:read", "b:c:read"])).toEqual([
      "a:b:read",
      "b:c:read",
    ])
  })
})

describe("the refusal names what is missing and the only real remedies", () => {
  const message = SCOPE_TAINT_BLOCKED_MESSAGE(
    "app_boxtal.app_config",
    ["boxtal:shipments:read", "tickets:tickets:read"],
    "readers",
    "boxtal:internal:read",
    { missingScopes: ["tickets:tickets:read"], lacking: 2 },
  )

  test("it says a new conversation is not possible and must not be suggested", () => {
    expect(message).toContain("Starting a new conversation is NOT possible")
    expect(message).toContain("never suggest a new, fresh or separate conversation")
  })

  test("it names the missing scope and how many readers lack it, never who", () => {
    expect(message).toContain("Missing scope(s): tickets:tickets:read; 2 readers")
  })

  test("it names the real remedies and keeps the not-executed instructions", () => {
    expect(message).toContain(
      "a person who holds the missing scope(s) performs the action themselves in the app",
    )
    expect(message).toContain("an admin adjusts scopes")
    expect(message).toContain("NOT EXECUTED")
    expect(message).toContain("never as done")
    expect(message).toContain("do not retry it this turn")
  })
})
