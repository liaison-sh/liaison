// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { createSkillRequestSchema, updateSkillRequestSchema } from "./skills"

describe("createSkillRequestSchema", () => {
  it("accepts kebab-case name, description ≤100, body ≥1", () => {
    const parsed = createSkillRequestSchema.parse({
      name: "draft-reply",
      description: "Draft a reply to the customer email.",
      body: "Use a friendly tone.",
      visibility: "personal",
    })
    expect(parsed.requiredScopes).toEqual([])
  })

  it("accepts requiredScopes when provided", () => {
    const parsed = createSkillRequestSchema.parse({
      name: "x",
      description: "y",
      body: "z",
      visibility: "org",
      requiredScopes: ["kernel:threads:write"],
    })
    expect(parsed.requiredScopes).toEqual(["kernel:threads:write"])
  })

  it("rejects name with spaces", () => {
    expect(() =>
      createSkillRequestSchema.parse({
        name: "draft reply",
        description: "d",
        body: "b",
        visibility: "personal",
      }),
    ).toThrow()
  })

  it("rejects UPPERCASE in name", () => {
    expect(() =>
      createSkillRequestSchema.parse({
        name: "DraftReply",
        description: "d",
        body: "b",
        visibility: "personal",
      }),
    ).toThrow()
  })

  it("rejects description with 101 chars", () => {
    expect(() =>
      createSkillRequestSchema.parse({
        name: "x",
        description: "x".repeat(101),
        body: "b",
        visibility: "personal",
      }),
    ).toThrow()
  })

  it("rejects body of length 0", () => {
    expect(() =>
      createSkillRequestSchema.parse({
        name: "x",
        description: "d",
        body: "",
        visibility: "personal",
      }),
    ).toThrow()
  })

  it("requires visibility ∈ {personal, org}", () => {
    expect(() =>
      createSkillRequestSchema.parse({
        name: "x",
        description: "d",
        body: "b",
        visibility: "team" as never,
      }),
    ).toThrow()
  })

  it("accepts an optional slug domain", () => {
    const parsed = createSkillRequestSchema.parse({
      name: "x",
      description: "d",
      body: "b",
      visibility: "personal",
      domain: "shipping",
    })
    expect(parsed.domain).toBe("shipping")
  })

  it("omitting domain is allowed (general routing)", () => {
    const parsed = createSkillRequestSchema.parse({
      name: "x",
      description: "d",
      body: "b",
      visibility: "personal",
    })
    expect(parsed.domain).toBeUndefined()
  })

  it("rejects a non-slug domain (spaces/uppercase)", () => {
    expect(() =>
      createSkillRequestSchema.parse({
        name: "x",
        description: "d",
        body: "b",
        visibility: "personal",
        domain: "Ship Ping",
      }),
    ).toThrow()
  })
})

describe("updateSkillRequestSchema", () => {
  it("a body-only edit leaves requiredScopes absent, so the skill keeps its scopes", () => {
    const parsed = updateSkillRequestSchema.parse({ body: "new body" })
    expect("requiredScopes" in parsed).toBe(false)
  })

  it("omits visibility (cannot change ownership via update)", () => {
    const parsed = updateSkillRequestSchema.parse({ description: "new desc" })
    expect(parsed.description).toBe("new desc")
    expect("visibility" in parsed).toBe(false)
  })

  it("strips visibility on update (unknown fields are coerced away, not rejected)", () => {
    // updateSkillRequestSchema omits `visibility`; Zod strips unknown keys by
    // default, so passing `visibility` does not throw — it is silently removed.
    // This test documents the coercion behaviour so a future change to strict
    // mode doesn't go unnoticed.
    const parsed = updateSkillRequestSchema.parse({
      description: "d",
      visibility: "anything",
    } as never)
    expect((parsed as Record<string, unknown>).visibility).toBeUndefined()
  })

  it("permits partial body update", () => {
    expect(updateSkillRequestSchema.parse({ body: "new body" }).body).toBe("new body")
  })
})
