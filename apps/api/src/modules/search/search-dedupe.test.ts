// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { dedupeHitsByEntity, type SearchHit } from "./service"

describe("dedupeHitsByEntity", () => {
  it("keeps one hit per (app, entity type, entity id), internal before external", () => {
    // An app that both indexes its rows and answers an external search over
    // them returned the same row twice: once as an indexed document (its id in
    // `entity_id`), once as its own hit (its id in `id`).
    const internal: SearchHit = {
      id: "org_social_finding_f1",
      app: "social",
      entity_type: "finding",
      entity_id: "f1",
      title: "The preamp linked in seconds",
      source: "internal",
    }
    const external: SearchHit = {
      id: "f1",
      app: "social",
      entity_type: "finding",
      title: "The preamp linked in seconds",
      source: "external:social",
    }
    const other: SearchHit = { id: "f2", app: "social", entity_type: "finding", title: "Other" }
    const sameIdOtherType: SearchHit = { id: "f1", app: "social", entity_type: "post", title: "x" }

    const out = dedupeHitsByEntity([internal, external, other, sameIdOtherType, external])

    expect(out).toEqual([internal, other, sameIdOtherType])
  })
})
