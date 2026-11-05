// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { routineMailboxReader } from "~/modules/agent/mailbox-plaintext/routine-mailbox-trust"
import { routineDefinitionEditor } from "~/modules/agent/tools/skills-routines-tools"

const owner = "00000000-0000-4000-8000-00000000000a"
const other = "00000000-0000-4000-8000-00000000000b"

describe("routineMailboxReader", () => {
  it("is the owner for the owner's own routine, never edited, on its schedule", () => {
    expect(routineMailboxReader({ ownerUserId: owner, createdByUserId: owner })).toBe(owner)
  })

  it("is the owner when the owner edited it last and when the owner runs it now", () => {
    const row = {
      ownerUserId: owner,
      createdByUserId: owner,
      editedByUserId: owner,
      editedAt: new Date(),
    }
    expect(routineMailboxReader(row)).toBe(owner)
    expect(routineMailboxReader(row, owner)).toBe(owner)
  })

  it("refuses a routine someone else created to run as the owner (delegated create)", () => {
    expect(routineMailboxReader({ ownerUserId: owner, createdByUserId: other })).toBeUndefined()
    expect(routineMailboxReader({ ownerUserId: owner, createdByUserId: null })).toBeUndefined()
  })

  it("refuses a routine someone else edited last (an admin or delegate rewrote the prompt)", () => {
    expect(
      routineMailboxReader({
        ownerUserId: owner,
        createdByUserId: owner,
        editedByUserId: other,
        editedAt: new Date(),
      }),
    ).toBeUndefined()
  })

  it("refuses a routine changed by a path that did not say who (the 0230 trigger)", () => {
    expect(
      routineMailboxReader({
        ownerUserId: owner,
        createdByUserId: owner,
        editedByUserId: null,
        editedAt: "2026-10-31T00:00:00Z",
      }),
    ).toBeUndefined()
  })

  it("refuses a run-now somebody else asked for", () => {
    expect(
      routineMailboxReader({ ownerUserId: owner, createdByUserId: owner }, other),
    ).toBeUndefined()
  })
})

describe("routineDefinitionEditor", () => {
  it("records the editor, and with an approval the party that is not the owner", () => {
    expect(routineDefinitionEditor({ userId: owner, approverUserId: null }, owner)).toBe(owner)
    expect(routineDefinitionEditor({ userId: other, approverUserId: null }, owner)).toBe(other)
    // The owner asked, an admin approved (and could have changed it).
    expect(routineDefinitionEditor({ userId: owner, approverUserId: other }, owner)).toBe(other)
    // An admin asked, the owner approved.
    expect(routineDefinitionEditor({ userId: other, approverUserId: owner }, owner)).toBe(other)
    expect(routineDefinitionEditor({ userId: owner, approverUserId: owner }, owner)).toBe(owner)
  })
})
