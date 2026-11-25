// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A restricted record's taint scope is held by its list, never by a grant: the JS rules the
// taint judgement and the message read path apply (the database mirrors them, 0331).

import { describe, expect, it } from "bun:test"
import { holdsEveryScope } from "~/modules/agent/scopes/taint-approval-audience"
import { projectTaintScopes } from "~/modules/agent/scopes/taint-read-scopes"
import { restrictedRowsErrors } from "~/modules/apps/contract"
import { idsAtPath } from "~/modules/apps/execute-tool"
import { hasScope } from "~/modules/permissions/permissions"
import { isRestrictedScope, restrictedScope } from "~/modules/permissions/restricted-scope"
import { isMessageVisible } from "~/services/security/visibility"

const id = "4b0f1f3e-8a51-4c43-9d35-7a6a7b1c2d3e"
const scope = restrictedScope("agreements", "agreement", id)
const listed = "11111111-1111-4111-8111-111111111111"
const admin = "22222222-2222-4222-8222-222222222222"

describe("a restricted record's scope", () => {
  it("is named after the record and recognised as restricted", () => {
    expect(scope).toBe(`restricted:agreements.agreement:${id}`)
    expect(isRestrictedScope(scope)).toBe(true)
    expect(isRestrictedScope("agreements:agreements:read")).toBe(false)
  })

  it("is covered by no grant, every-scope and app wildcards included", () => {
    expect(hasScope(scope, ["*"])).toBe(false)
    expect(hasScope(scope, ["restricted:*"])).toBe(false)
    expect(hasScope(scope, [scope])).toBe(false)
    expect(hasScope("agreements:agreements:read", ["*"])).toBe(true)
  })

  it("is held only by a reader on the record's list", () => {
    const lists = new Map([[scope, new Set([listed])]])
    expect(holdsEveryScope(["*"], [scope])).toBe(false)
    expect(holdsEveryScope(["*"], [scope], { userId: admin, lists })).toBe(false)
    expect(holdsEveryScope([], [scope], { userId: listed, lists })).toBe(true)
    // The list does not stand in for the other scopes of the taint.
    expect(
      holdsEveryScope([], [scope, "agreements:agreements:read"], { userId: listed, lists }),
    ).toBe(false)
    // A record no longer restricted asks nothing; one never looked up is held by nobody.
    expect(holdsEveryScope([], [scope], { userId: admin, lists: new Map([[scope, null]]) })).toBe(
      true,
    )
    expect(holdsEveryScope([], [scope], { userId: listed, lists: new Map() })).toBe(false)
  })

  it("survives the taint projection unchanged", () => {
    expect(projectTaintScopes([scope], [])).toEqual([scope])
  })
})

describe("a message stamped with a restricted record's scope", () => {
  const message = {
    requiredScopes: [scope, "agreements:agreements:read"],
    disclosureList: [listed],
  }

  it("is read by nobody through grants alone, an admin holding every scope included", () => {
    expect(isMessageVisible(message, { userId: admin, grants: ["*"] })).toBe(false)
    expect(
      isMessageVisible({ ...message, disclosureList: null }, { userId: listed, grants: ["*"] }),
    ).toBe(false)
  })

  it("is read by the people on its disclosure list who hold the rest of the stamp", () => {
    expect(
      isMessageVisible(message, { userId: listed, grants: ["agreements:agreements:read"] }),
    ).toBe(true)
    expect(isMessageVisible(message, { userId: listed, grants: [] })).toBe(false)
  })

  it("leaves a stamp without restricted scopes as it was: a disclosure still lets in", () => {
    const plain = { requiredScopes: ["agreements:agreements:read"], disclosureList: [listed] }
    expect(isMessageVisible(plain, { userId: listed, grants: [] })).toBe(true)
    expect(isMessageVisible(plain, { userId: admin, grants: ["*"] })).toBe(true)
  })
})

describe("restrictedRows on a read tool", () => {
  it("reads every id at its path, through arrays", () => {
    expect(idsAtPath({ items: [{ id: "a" }, { id: "b" }, { id: "a" }] }, "items[].id")).toEqual([
      "a",
      "b",
    ])
    expect(idsAtPath({ agreement: { id: "c" } }, "agreement.id")).toEqual(["c"])
    expect(idsAtPath({ agreement: null }, "agreement.id")).toEqual([])
    expect(idsAtPath("text", "items[].id")).toEqual([])
  })

  it("is refused for a record kind with no list function, and taken on a tool that writes as on one that reads", () => {
    const manifest = (tool: Record<string, unknown>) => ({ name: "agreements", tools: { t: tool } })
    expect(
      restrictedRowsErrors(
        manifest({ readOnly: true, restrictedRows: { entity: "agreement", idPath: "id" } }),
      ),
    ).toEqual([])
    expect(
      restrictedRowsErrors(
        manifest({ readOnly: true, restrictedRows: { entity: "template", idPath: "id" } }),
      ),
    ).toHaveLength(1)
    expect(
      restrictedRowsErrors(manifest({ restrictedRows: { entity: "agreement", idPath: "id" } })),
    ).toEqual([])
  })
})
