// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { validateAppManifest } from "~/modules/apps/contract"

const baseValid = {
  name: "tickets",
  version: "1.0.0",
  tools: {
    open: { description: "open", requiredScopes: ["tickets:tickets:read"], handler: "h" },
  },
  entities: {
    ticket: {
      labelField: "title",
      handlePrefix: "ticket-",
      searchable: true,
      tableName: "tickets",
      readScope: "tickets:tickets:read",
      indexFields: { title: "title", body: "description" },
      permissionFields: {
        readScope: "tickets:tickets:read",
        participantIdsField: "participant_ids",
        dimensionFields: ["team", "priority"],
      },
      fileParent: {
        tableName: "tickets",
        schemaRef: "app_tickets",
        joinOn: "id",
        readScope: "tickets:tickets:read",
        writeScope: "tickets:tickets:write",
      },
    },
  },
  attention: {
    translations: [
      {
        event: "tickets:assign",
        kind: "mention",
        urgency: 60,
        isUrgent: false,
        summary: "Ticket {{payload.handle}} assigned to you",
        recipients: { kind: "field", path: "data.assigneeId" },
      },
    ],
  },
}

describe("manifest-schema entity index, permission, file-parent and attention fields", () => {
  it("accepts indexFields, permissionFields, fileParent and attention", () => {
    const r = validateAppManifest(baseValid)
    expect(r.success).toBe(true)
  })

  it("rejects unknown entity field names", () => {
    const r = validateAppManifest({
      ...baseValid,
      entities: {
        ticket: { ...baseValid.entities.ticket, garbage: 1 },
      },
    })
    expect(r.success).toBe(false)
  })

  it("rejects when permissionFields.readScope missing", () => {
    const r = validateAppManifest({
      ...baseValid,
      entities: {
        ticket: {
          ...baseValid.entities.ticket,
          permissionFields: { participantIdsField: "p" },
        },
      },
    })
    expect(r.success).toBe(false)
  })

  it("rejects unknown attention.translations.recipients.kind", () => {
    const r = validateAppManifest({
      ...baseValid,
      attention: {
        translations: [
          {
            ...baseValid.attention.translations[0],
            recipients: { kind: "ufo", path: "x" },
          },
        ],
      },
    })
    expect(r.success).toBe(false)
  })

  it("accepts excludeActor on scope_holders recipients", () => {
    const r = validateAppManifest({
      ...baseValid,
      attention: {
        translations: [
          {
            ...baseValid.attention.translations[0],
            recipients: {
              kind: "scope_holders",
              scope: "tickets:inboxes:admin",
              excludeActor: true,
            },
          },
        ],
      },
    })
    expect(r.success).toBe(true)
  })

  it("rejects unknown attention.translations.kind", () => {
    const r = validateAppManifest({
      ...baseValid,
      attention: {
        translations: [
          {
            ...baseValid.attention.translations[0],
            kind: "fake_kind",
          },
        ],
      },
    })
    expect(r.success).toBe(false)
  })
})
