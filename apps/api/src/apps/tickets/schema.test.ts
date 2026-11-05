// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { generateTableDdl } from "~/modules/apps/ddl"
import manifest from "./app.manifest.json"

describe("tickets schema parity (manifest-derived DDL)", () => {
  it("inboxes carries is_default_for_create as bool not-null default false", () => {
    const ddl = generateTableDdl(
      "app_tickets",
      "inboxes",
      manifest.schema.inboxes.fields,
      manifest.schema.inboxes.constraints as never,
      undefined,
    )
    expect(ddl).toMatch(/"is_default_for_create" BOOLEAN NOT NULL DEFAULT false/i)
  })

  it("inboxes has a partial unique on (org_id) WHERE is_default_for_create = true", () => {
    const ddl = generateTableDdl(
      "app_tickets",
      "inboxes",
      manifest.schema.inboxes.fields,
      manifest.schema.inboxes.constraints as never,
      undefined,
    )
    expect(ddl).toMatch(/CREATE UNIQUE INDEX[^;]*\(org_id\) WHERE is_default_for_create = true/)
  })

  it("messages declares partial unique on (org_id, external_message_id) where not null", () => {
    const ddl = generateTableDdl(
      "app_tickets",
      "messages",
      manifest.schema.messages.fields,
      manifest.schema.messages.constraints as never,
      undefined,
    )
    expect(ddl).toMatch(
      /CREATE UNIQUE INDEX[^;]*\(org_id, "?external_message_id"?\) WHERE external_message_id IS NOT NULL/,
    )
  })
})
