// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  SINK_APP_KNOWLEDGE_DOCUMENTS,
  SINK_KERNEL_AGENT_MEMORY,
  SINK_KERNEL_MESSAGES,
  TAINT_ENFORCING_SINKS,
  toScopeTaintBlockedError,
  UNDECLARED_WRITE_TARGET,
} from "~/modules/agent/scopes/scope-taint"
import {
  assertNoScopeTaintedWrite,
  countHiddenRuns,
  filterByVisibility,
  isMessageVisible,
  isScopeTaintBlockedWriteError,
} from "~/services/security/visibility"

const ALICE = "11111111-1111-4111-8111-111111111111"
const BOB = "22222222-2222-4222-8222-222222222222"

describe("isMessageVisible", () => {
  it("returns true when the viewer holds every required scope", () => {
    expect(
      isMessageVisible(
        { requiredScopes: ["pennylane:payouts:read", "crm:contacts:read"], disclosureList: null },
        { userId: ALICE, grants: ["crm:contacts:read", "pennylane:payouts:read", "x:y:z"] },
      ),
    ).toBe(true)
  })

  it("returns false when the viewer is missing a required scope and is not disclosed", () => {
    expect(
      isMessageVisible(
        { requiredScopes: ["pennylane:payouts:read", "crm:contacts:read"], disclosureList: [BOB] },
        { userId: ALICE, grants: ["crm:contacts:read"] },
      ),
    ).toBe(false)
    expect(
      isMessageVisible(
        { requiredScopes: ["pennylane:payouts:read"], disclosureList: null },
        { userId: ALICE, grants: ["crm:contacts:read"] },
      ),
    ).toBe(false)
  })

  it("returns true when the viewer lacks the scope but is in the disclosure list", () => {
    expect(
      isMessageVisible(
        { requiredScopes: ["pennylane:payouts:read"], disclosureList: [BOB, ALICE] },
        { userId: ALICE, grants: ["crm:contacts:read"] },
      ),
    ).toBe(true)
  })

  it("returns true for a message with an empty requiredScopes array regardless of viewer grants", () => {
    const message = { requiredScopes: [], disclosureList: null }
    expect(isMessageVisible(message, { userId: ALICE, grants: [] })).toBe(true)
    expect(isMessageVisible(message, { userId: ALICE, grants: ["crm:contacts:read"] })).toBe(true)
    expect(isMessageVisible(message, { userId: ALICE, grants: ["*"] })).toBe(true)
  })

  it("returns true for a disclosed viewer who holds no grants at all, like the RLS clause", () => {
    expect(
      isMessageVisible(
        { requiredScopes: ["pennylane:payouts:read"], disclosureList: [ALICE] },
        { userId: ALICE, grants: [] },
      ),
    ).toBe(true)
  })

  it("returns false for a viewer with no grants on a scoped message they are not disclosed on", () => {
    expect(
      isMessageVisible(
        { requiredScopes: ["pennylane:payouts:read"], disclosureList: [] },
        { userId: ALICE, grants: [] },
      ),
    ).toBe(false)
  })

  it("honours wildcard and parent grants with the hasScope semantics", () => {
    const message = { requiredScopes: ["pennylane:payouts:read"], disclosureList: null }
    expect(isMessageVisible(message, { userId: ALICE, grants: ["*"] })).toBe(true)
    expect(isMessageVisible(message, { userId: ALICE, grants: ["pennylane:*"] })).toBe(true)
    expect(isMessageVisible(message, { userId: ALICE, grants: ["pennylane:payouts:*"] })).toBe(true)
    expect(isMessageVisible(message, { userId: ALICE, grants: ["pennylane:payouts"] })).toBe(true)
    expect(isMessageVisible(message, { userId: ALICE, grants: ["pennylane"] })).toBe(true)
  })

  it("does not honour a mid-segment wildcard or a sibling grant", () => {
    const message = { requiredScopes: ["pennylane:payouts:read"], disclosureList: null }
    expect(isMessageVisible(message, { userId: ALICE, grants: ["pennylane:*:read"] })).toBe(false)
    expect(isMessageVisible(message, { userId: ALICE, grants: ["pennylane:invoices"] })).toBe(false)
    expect(isMessageVisible(message, { userId: ALICE, grants: ["pennylane:payouts:write"] })).toBe(
      false,
    )
  })

  it("requires every required scope, a wildcard covering only one of them is not enough", () => {
    expect(
      isMessageVisible(
        { requiredScopes: ["pennylane:payouts:read", "crm:contacts:read"], disclosureList: null },
        { userId: ALICE, grants: ["pennylane:*"] },
      ),
    ).toBe(false)
  })

  it("fails closed on an empty required scope string or an empty viewer id", () => {
    expect(
      isMessageVisible(
        { requiredScopes: [""], disclosureList: null },
        { userId: ALICE, grants: ["crm"] },
      ),
    ).toBe(false)
    expect(
      isMessageVisible(
        { requiredScopes: ["pennylane:payouts:read"], disclosureList: [""] },
        { userId: "", grants: [] },
      ),
    ).toBe(false)
  })

  it("fails closed on a missing requiredScopes array but still honours the disclosure list", () => {
    const missing = { requiredScopes: null as unknown as string[], disclosureList: null }
    expect(isMessageVisible(missing, { userId: ALICE, grants: ["*"] })).toBe(false)
    expect(
      isMessageVisible({ ...missing, disclosureList: [ALICE] }, { userId: ALICE, grants: [] }),
    ).toBe(true)
  })
})

describe("countHiddenRuns", () => {
  const CRM = "crm:contacts:read"
  const FINANCE = "pennylane:payouts:read"
  const HR = "people:salaries:read"

  // Alice holds CRM only, so a CRM message is visible to her and a FINANCE or HR
  // message is hidden unless she is on its disclosure list.
  const ALICE_VIEWER = { userId: ALICE, grants: [CRM] }
  const visible = (id: string) => ({ id, requiredScopes: [CRM], disclosureList: null })
  const hidden = (id: string) => ({ id, requiredScopes: [FINANCE], disclosureList: null })

  it("returns an empty array when every message is visible", () => {
    expect(countHiddenRuns([visible("m1"), visible("m2"), visible("m3")], ALICE_VIEWER)).toEqual([])
  })

  it("counts a single run of 3 consecutive hidden messages as one entry with count 3", () => {
    expect(
      countHiddenRuns(
        [visible("m1"), hidden("m2"), hidden("m3"), hidden("m4"), visible("m5")],
        ALICE_VIEWER,
      ),
    ).toEqual([{ afterMessageId: "m1", count: 3 }])
  })

  it("counts two separated runs of hidden messages as two entries", () => {
    expect(
      countHiddenRuns(
        [
          visible("m1"),
          hidden("m2"),
          hidden("m3"),
          visible("m4"),
          visible("m5"),
          hidden("m6"),
          visible("m7"),
        ],
        ALICE_VIEWER,
      ),
    ).toEqual([
      { afterMessageId: "m1", count: 2 },
      { afterMessageId: "m5", count: 1 },
    ])
  })

  it("separates two runs split by exactly one visible message", () => {
    expect(
      countHiddenRuns(
        [hidden("m1"), hidden("m2"), visible("m3"), hidden("m4"), hidden("m5")],
        ALICE_VIEWER,
      ),
    ).toEqual([
      { afterMessageId: null, count: 2 },
      { afterMessageId: "m3", count: 2 },
    ])
  })

  it("anchors a run at the top of the thread to null", () => {
    expect(
      countHiddenRuns([hidden("m1"), hidden("m2"), visible("m3"), visible("m4")], ALICE_VIEWER),
    ).toEqual([{ afterMessageId: null, count: 2 }])
  })

  it("anchors a run in the middle to the last visible message before it", () => {
    expect(
      countHiddenRuns(
        [visible("m1"), visible("m2"), hidden("m3"), hidden("m4"), visible("m5")],
        ALICE_VIEWER,
      ),
    ).toEqual([{ afterMessageId: "m2", count: 2 }])
  })

  it("anchors a run at the end of the thread to the last visible message", () => {
    expect(
      countHiddenRuns(
        [visible("m1"), visible("m2"), hidden("m3"), hidden("m4"), hidden("m5")],
        ALICE_VIEWER,
      ),
    ).toEqual([{ afterMessageId: "m2", count: 3 }])
  })

  it("reports a wholly hidden thread as one run anchored to null", () => {
    expect(
      countHiddenRuns([hidden("m1"), hidden("m2"), hidden("m3"), hidden("m4")], ALICE_VIEWER),
    ).toEqual([{ afterMessageId: null, count: 4 }])
  })

  it("merges adjacent hidden messages into one run whatever hides each of them", () => {
    // Three different reasons to be hidden: an unheld scope, a second unheld
    // scope, and a disclosure list the viewer is not on. Still one run.
    expect(
      countHiddenRuns(
        [
          visible("m1"),
          { id: "m2", requiredScopes: [FINANCE], disclosureList: null },
          { id: "m3", requiredScopes: [HR], disclosureList: [BOB] },
          { id: "m4", requiredScopes: [CRM, HR], disclosureList: null },
        ],
        ALICE_VIEWER,
      ),
    ).toEqual([{ afterMessageId: "m1", count: 3 }])
  })

  it("returns an empty array for an empty thread", () => {
    expect(countHiddenRuns([], ALICE_VIEWER)).toEqual([])
  })

  it("handles a thread of a single message, visible or hidden", () => {
    expect(countHiddenRuns([visible("m1")], ALICE_VIEWER)).toEqual([])
    expect(countHiddenRuns([hidden("m1")], ALICE_VIEWER)).toEqual([
      { afterMessageId: null, count: 1 },
    ])
  })

  it("uses isMessageVisible, so a disclosed message is visible and splits a run", () => {
    const messages = [
      hidden("m1"),
      { id: "m2", requiredScopes: [FINANCE], disclosureList: [ALICE] },
      hidden("m3"),
    ]
    expect(countHiddenRuns(messages, ALICE_VIEWER)).toEqual([
      { afterMessageId: null, count: 1 },
      { afterMessageId: "m2", count: 1 },
    ])
    // The same thread with nobody disclosed is one run: the viewer's own
    // disclosure is the only difference.
    expect(
      countHiddenRuns(
        messages.map((m) => ({ ...m, disclosureList: null })),
        ALICE_VIEWER,
      ),
    ).toEqual([{ afterMessageId: null, count: 3 }])
  })

  it("reveals only a count and an anchor: no hidden id, scope, author or content", () => {
    const runs = countHiddenRuns(
      [visible("m1"), hidden("secret-message-id"), hidden("m3"), visible("m4")],
      ALICE_VIEWER,
    )
    expect(runs.map((run) => Object.keys(run).sort())).toEqual([["afterMessageId", "count"]])
    const serialised = JSON.stringify(runs)
    expect(serialised).not.toContain("secret-message-id")
    expect(serialised).not.toContain("m3")
    expect(serialised).not.toContain(FINANCE)
    expect(serialised).not.toContain(ALICE)
  })

  it("counts a run per viewer, so a viewer holding every scope sees no runs at all", () => {
    const messages = [visible("m1"), hidden("m2"), hidden("m3")]
    expect(countHiddenRuns(messages, { userId: BOB, grants: ["*"] })).toEqual([])
    expect(countHiddenRuns(messages, { userId: BOB, grants: [] })).toEqual([
      { afterMessageId: null, count: 3 },
    ])
  })
})

// A3, spec-security.md :56. The write-path half of scope taint: a turn that has
// read scoped data may write only into a sink whose reads enforce
// requiredScopes. Everything here delegates to 2a's checkScopeTaint and
// TAINT_ENFORCING_SINKS, so this can never disagree with the tool bridge.
describe("assertNoScopeTaintedWrite", () => {
  const TAINTED = ["pennylane:payouts:read"]
  const NON_ENFORCING = "kernel.contacts"

  /** The error a refused write threw, or null when the call returned. */
  function refusalOf(sinkTable: string, turnRequiredScopes: string[] | null): unknown {
    try {
      assertNoScopeTaintedWrite(sinkTable, turnRequiredScopes)
      return null
    } catch (err) {
      return err
    }
  }

  it("throws E_SCOPE_TAINT_BLOCKED for a non-empty requiredScopes write to a sink outside the closed list", () => {
    expect(() => assertNoScopeTaintedWrite(NON_ENFORCING, TAINTED)).toThrow(/E_SCOPE_TAINT_BLOCKED/)
    for (const sink of [
      NON_ENFORCING,
      "kernel.tickets",
      "app_mail.messages",
      "app_projects.projects",
      UNDECLARED_WRITE_TARGET,
    ]) {
      const err = refusalOf(sink, TAINTED) as { code?: string; writeTargetTable?: string }
      expect(err).not.toBeNull()
      expect(err.code).toBe("E_SCOPE_TAINT_BLOCKED")
      // The refusal names the sink it refused, so a reader can tell what was blocked.
      expect(err.writeTargetTable).toBe(sink)
    }
  })

  it("allows a write to messages, agent_memory or app_knowledge.documents regardless of requiredScopes", () => {
    for (const sink of [
      SINK_KERNEL_MESSAGES,
      SINK_KERNEL_AGENT_MEMORY,
      SINK_APP_KNOWLEDGE_DOCUMENTS,
    ]) {
      expect(refusalOf(sink, TAINTED)).toBeNull()
      expect(refusalOf(sink, ["a:b:read", "c:d:read"])).toBeNull()
      expect(refusalOf(sink, [])).toBeNull()
    }
    // The list is 2a's, not a second copy of it.
    for (const sink of TAINT_ENFORCING_SINKS) expect(refusalOf(sink, TAINTED)).toBeNull()
    expect([...TAINT_ENFORCING_SINKS].sort()).toEqual(
      [SINK_APP_KNOWLEDGE_DOCUMENTS, SINK_KERNEL_AGENT_MEMORY, SINK_KERNEL_MESSAGES].sort(),
    )
  })

  it("allows any sink when turnRequiredScopes is empty", () => {
    for (const sink of [
      NON_ENFORCING,
      "kernel.tickets",
      SINK_KERNEL_MESSAGES,
      UNDECLARED_WRITE_TARGET,
    ]) {
      expect(refusalOf(sink, [])).toBeNull()
    }
  })

  it("refuses a non-enforcing write when the turn's accumulated scopes cannot be determined", () => {
    // Fail closed: unknown taint is treated as the worst case, a tainted turn.
    const err = refusalOf(NON_ENFORCING, null) as { code?: string; writeTargetTable?: string }
    expect(err).not.toBeNull()
    expect(err.code).toBe("E_SCOPE_TAINT_BLOCKED")
    expect(err.writeTargetTable).toBe(NON_ENFORCING)
    // An unreadable value is unknown too, never an implicit empty set.
    expect(refusalOf(NON_ENFORCING, undefined as unknown as null)).not.toBeNull()
    expect(refusalOf(NON_ENFORCING, "pennylane:payouts:read" as unknown as null)).not.toBeNull()
    expect(refusalOf(NON_ENFORCING, [1] as unknown as string[])).not.toBeNull()
  })

  it("still allows an enforcing sink when the turn's scopes cannot be determined", () => {
    // Worst case is a tainted turn, and a tainted turn may write these three.
    for (const sink of TAINT_ENFORCING_SINKS) expect(refusalOf(sink, null)).toBeNull()
  })

  it("matches the sink literally, so a look-alike is non-enforcing", () => {
    for (const sink of [
      "messages",
      "app_mail.messages",
      "KERNEL.MESSAGES",
      " kernel.messages",
      "kernel.messages ",
      "kernel.messages_archive",
      "public.kernel.messages",
    ]) {
      expect(refusalOf(sink, TAINTED)).not.toBeNull()
    }
  })

  it("refuses with the 2a toScopeTaintBlockedError shape, so the withheld card can present it", () => {
    const err = refusalOf(NON_ENFORCING, TAINTED) as Record<string, unknown>
    expect(err).toBeInstanceOf(Error)
    expect(isScopeTaintBlockedWriteError(err)).toBe(true)
    const { message: _guidance, ...shape } = toScopeTaintBlockedError(NON_ENFORCING, TAINTED)
    expect({
      ok: err.ok,
      code: err.code,
      writeTargetTable: err.writeTargetTable,
      reason: err.reason,
    }).toEqual(shape)
    expect(err.retryable).toBe(false)
    expect(isScopeTaintBlockedWriteError(new Error("nope"))).toBe(false)
    expect(isScopeTaintBlockedWriteError(null)).toBe(false)
  })
})

// D5 and S8, spec-security.md: memory rows, knowledge documents and thread
// search hits injected into a later turn's prompt are filtered by that turn's
// CURRENT effective scope, "identically to message visibility, because context
// assembly runs the same predicate as the read path, not a separate one".
//
// So this suite pins REUSE as much as behaviour. Every case has a twin in the
// isMessageVisible suite above, and the last case walks a matrix asserting the
// two answer identically: a divergence is a bug in one of them, never a
// context-assembly policy of its own.
describe("filterByVisibility", () => {
  const CRM = "crm:contacts:read"
  const FINANCE = "pennylane:payouts:read"

  // A memory row exactly as kernel.agent_memory yields it: requiredScopes and
  // NO disclosure column, since only kernel.messages has disclosure_list.
  // app_knowledge.documents has the same shape. For these rows the scope branch
  // is the only branch that can ever admit them, which is why disclosureList is
  // optional on the parameter type rather than required.
  const memory = (name: string, requiredScopes: string[]) => ({
    name,
    content: `${name} body`,
    requiredScopes,
  })

  const ALICE_CRM = { userId: ALICE, grants: [CRM] }

  it("filters out a scope-tagged memory-shaped item the viewer's grants do not cover", () => {
    const items = [memory("payout-note", [FINANCE])]
    expect(filterByVisibility(items, ALICE_CRM)).toEqual([])
    // The row is not redacted or blanked, it is absent: nothing about it, not
    // its name and not its scope, reaches the assembled prompt.
    expect(JSON.stringify(filterByVisibility(items, ALICE_CRM))).not.toContain("payout-note")
    expect(JSON.stringify(filterByVisibility(items, ALICE_CRM))).not.toContain(FINANCE)
  })

  it("keeps an item in the viewer's disclosure list even without the matching grant", () => {
    const disclosed = { id: "m1", requiredScopes: [FINANCE], disclosureList: [BOB, ALICE] }
    expect(filterByVisibility([disclosed], ALICE_CRM)).toEqual([disclosed])
    // The same row with somebody else disclosed is filtered out, so it is the
    // viewer's own disclosure doing the work.
    expect(filterByVisibility([{ ...disclosed, disclosureList: [BOB] }], ALICE_CRM)).toEqual([])
  })

  it("keeps an item whose every required scope the viewer holds", () => {
    const held = memory("crm-note", [CRM])
    expect(filterByVisibility([held], ALICE_CRM)).toEqual([held])
    // Every required scope, not merely one of them.
    expect(filterByVisibility([memory("both", [CRM, FINANCE])], ALICE_CRM)).toEqual([])
    expect(
      filterByVisibility([memory("both", [CRM, FINANCE])], { userId: ALICE, grants: ["*"] }),
    ).toHaveLength(1)
  })

  it("keeps an empty-scope item for a viewer holding no grants at all", () => {
    // [] is a positive assertion that the row carries no scoped data, so it is
    // context for every turn, exactly as it is readable by every member.
    const untagged = memory("welcome", [])
    expect(filterByVisibility([untagged], { userId: ALICE, grants: [] })).toEqual([untagged])
  })

  it("excludes an undeterminable item even from a viewer who holds every scope", () => {
    // Fail closed. A row whose requiredScopes cannot be read is never treated
    // as the empty set: that would read as "this row carries no scoped data",
    // which is exactly the claim that cannot be made about it.
    const nullScopes = { name: "unreadable", requiredScopes: null as unknown as string[] }
    const missingScopes = { name: "unreadable" } as unknown as { requiredScopes: string[] }
    const emptyScopeString = memory("unreadable", [""])
    const godMode = { userId: ALICE, grants: ["*"] }
    expect(filterByVisibility([nullScopes], godMode)).toEqual([])
    expect(filterByVisibility([missingScopes], godMode)).toEqual([])
    expect(filterByVisibility([emptyScopeString], godMode)).toEqual([])
  })

  it("excludes an item whose requiredScopes holds a non string element, never throws", () => {
    // Recorded by 2b's T30 and closed here: a non-string element used to reach
    // hasScope's `required.split` and throw a TypeError out of the whole
    // filter, aborting context assembly instead of excluding the one bad row.
    // Fail closed means EXCLUDE, not ABORT.
    const nonString = {
      name: "unreadable",
      requiredScopes: [CRM, 42] as unknown as string[],
    }
    const godMode = { userId: ALICE, grants: ["*"] }
    expect(() => filterByVisibility([nonString], godMode)).not.toThrow()
    expect(filterByVisibility([nonString], godMode)).toEqual([])
    // The good rows around it still come back: one bad row costs one row.
    const good = memory("crm-note", [CRM])
    expect(filterByVisibility([nonString, good], ALICE_CRM)).toEqual([good])
    // The disclosure branch still admits it, exactly as for any other row whose
    // scope branch cannot be satisfied.
    const disclosed = { requiredScopes: [7] as unknown as string[], disclosureList: [ALICE] }
    expect(filterByVisibility([disclosed], ALICE_CRM)).toEqual([disclosed])
  })

  it("preserves input order and returns the original objects, not copies", () => {
    // The caller feeds the kept rows' scopes back into the turn accumulator, so
    // identity matters: it must be able to read requiredScopes off exactly the
    // rows it got back.
    const m1 = memory("m1", [])
    const m2 = memory("m2", [FINANCE])
    const m3 = memory("m3", [CRM])
    const m4 = { id: "m4", requiredScopes: [FINANCE], disclosureList: [ALICE] }
    const m5 = memory("m5", [CRM])
    const input = [m1, m2, m3, m4, m5]
    const kept = filterByVisibility(input, ALICE_CRM)
    expect(kept.map((k) => ("name" in k ? k.name : k.id))).toEqual(["m1", "m3", "m4", "m5"])
    expect(kept[0]).toBe(m1)
    expect(kept[3]).toBe(m5)
    // The input list is left alone: filtering a turn's candidate rows must not
    // disturb whatever the caller still holds.
    expect(input).toHaveLength(5)
    expect(input[1]).toBe(m2)
  })

  it("returns an empty array for an empty list", () => {
    expect(filterByVisibility([], ALICE_CRM)).toEqual([])
    expect(filterByVisibility([], { userId: "", grants: [] })).toEqual([])
  })

  it("answers item by item exactly as isMessageVisible does, the same predicate not a second one", () => {
    const rows = [
      { requiredScopes: [], disclosureList: null },
      { requiredScopes: [CRM], disclosureList: null },
      { requiredScopes: [FINANCE], disclosureList: null },
      { requiredScopes: [CRM, FINANCE], disclosureList: null },
      { requiredScopes: [FINANCE], disclosureList: [ALICE] },
      { requiredScopes: [FINANCE], disclosureList: [BOB] },
      { requiredScopes: [""], disclosureList: null },
      { requiredScopes: null as unknown as string[], disclosureList: null },
    ]
    const viewers = [
      ALICE_CRM,
      { userId: ALICE, grants: [] },
      { userId: ALICE, grants: ["*"] },
      { userId: BOB, grants: [FINANCE] },
      { userId: "", grants: [] },
    ]
    for (const viewer of viewers) {
      for (const row of rows) {
        expect(filterByVisibility([row], viewer)).toHaveLength(
          isMessageVisible(row, viewer) ? 1 : 0,
        )
      }
      // And in bulk: the filter is exactly the per-row predicate applied down
      // the list, so the kept set equals the predicate's own selection.
      expect(filterByVisibility(rows, viewer)).toEqual(
        rows.filter((row) => isMessageVisible(row, viewer)),
      )
    }
  })

  it("treats an absent disclosureList as no disclosure, never as a wildcard", () => {
    // A memory row has no disclosure column at all. Reading `undefined` as
    // "disclosed to everybody" would hand every scoped memory row to every
    // turn, so absent normalises to null and the row rides on its scopes alone.
    const scoped = memory("payout-note", [FINANCE])
    expect(filterByVisibility([scoped], ALICE_CRM)).toEqual([])
    expect(filterByVisibility([{ ...scoped, disclosureList: null }], ALICE_CRM)).toEqual([])
    expect(filterByVisibility([{ ...scoped, disclosureList: [] }], ALICE_CRM)).toEqual([])
  })
})
