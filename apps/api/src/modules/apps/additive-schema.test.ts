// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { assertAdditiveSchema, nonAdditiveChanges } from "~/modules/apps/additive-schema"

const active = {
  notes: {
    fields: {
      body: "string",
      amount: { type: "numeric", precision: 12, scale: 2 },
      status: { type: "string", enum: ["open", "closed"] },
      label: "string?",
      kind: "string",
    },
    constraints: { unique: [["body"]] },
  },
  tags: { fields: { name: "string" } },
}

function withNotes(fields: Record<string, unknown>, unique?: unknown[]) {
  return {
    ...active,
    notes: {
      fields: { ...active.notes.fields, ...fields },
      constraints: { unique: unique ?? active.notes.constraints.unique },
    },
  }
}

describe("nonAdditiveChanges (S10, A21)", () => {
  it("accepts the same schema, a new table, a new column and a wider enum", () => {
    expect(nonAdditiveChanges(active, active)).toEqual([])
    expect(
      nonAdditiveChanges(active, {
        ...withNotes({
          status: { type: "string", enum: ["open", "closed", "archived"] },
          priority: "integer?",
        }),
        extra: { fields: { x: "string" } },
      }),
    ).toEqual([])
  })

  it("refuses a dropped table", () => {
    const { tags: _dropped, ...next } = active
    expect(nonAdditiveChanges(active, next)).toEqual(["table tags is dropped"])
  })

  it("refuses a dropped (or renamed) column", () => {
    const { kind: _k, ...fields } = active.notes.fields
    const next = { ...active, notes: { ...active.notes, fields: { ...fields, kind2: "string" } } }
    expect(nonAdditiveChanges(active, next)).toEqual(["column notes.kind is dropped"])
  })

  it("refuses a column type change, numeric precision included", () => {
    expect(nonAdditiveChanges(active, withNotes({ kind: "integer" }))).toEqual([
      "column notes.kind changes type from string to integer",
    ])
    expect(
      nonAdditiveChanges(
        active,
        withNotes({ amount: { type: "numeric", precision: 10, scale: 2 } }),
      ),
    ).toEqual(["column notes.amount changes type from numeric(12,2) to numeric(10,2)"])
  })

  it("refuses an enum narrowing and a free column becoming an enum", () => {
    expect(
      nonAdditiveChanges(active, withNotes({ status: { type: "string", enum: ["open"] } })),
    ).toEqual(["column notes.status loses enum values closed"])
    expect(
      nonAdditiveChanges(active, withNotes({ kind: { type: "string", enum: ["a"] } })),
    ).toEqual(["column notes.kind becomes an enum; its existing values may not fit"])
  })

  it("refuses NOT NULL added to an existing column", () => {
    expect(nonAdditiveChanges(active, withNotes({ label: "string" }))).toEqual([
      "column notes.label becomes required (NOT NULL)",
    ])
  })

  it("refuses a unique constraint on existing columns, not one on a new column", () => {
    expect(nonAdditiveChanges(active, withNotes({}, [["body"], ["kind"]]))).toEqual([
      "table notes adds a unique constraint on existing data (kind)",
    ])
    expect(
      nonAdditiveChanges(active, withNotes({ code: "string?" }, [["body"], ["code"]])),
    ).toEqual([])
  })

  it("assertAdditiveSchema lists everything that would be lost", () => {
    expect(() =>
      assertAdditiveSchema("notes-app", "1.0.0", "2.0.0", active, { notes: active.notes }),
    ).toThrow(
      "Cannot move 'notes-app' from 1.0.0 to 2.0.0: the new version would lose data the running version keeps. A new version may only add tables, columns and enum values. Would be lost: table tags is dropped.",
    )
  })

  it("P2-fix7c: refuses a dropped unique constraint and a changed partial one", () => {
    expect(nonAdditiveChanges(active, withNotes({}, []))).toEqual([
      "table notes drops a unique constraint (body)",
    ])
    const partial = (where: string) => ({
      ...active,
      notes: {
        fields: active.notes.fields,
        constraints: { unique: [["body"], { columns: ["kind"], where }] },
      },
    })
    expect(nonAdditiveChanges(partial("kind IS NOT NULL"), partial("kind = 'a'")).sort()).toEqual([
      "table notes adds a unique constraint on existing data (kind where kind = 'a')",
      "table notes drops a unique constraint (kind where kind IS NOT NULL)",
    ])
  })

  it("P2-fix7d: refuses a unique constraint on a new column every existing row fills with one default", () => {
    expect(
      nonAdditiveChanges(
        active,
        withNotes({ code: { type: "string", default: "x" } }, [["body"], ["code"]]),
      ),
    ).toEqual(["table notes adds a unique constraint on a new column with a default (code)"])
  })
})
