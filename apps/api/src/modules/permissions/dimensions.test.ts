// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { matchesDimensions } from "~/modules/permissions/dimensions"

describe("matchesDimensions", () => {
  describe("membership type", () => {
    const dimensions = { team: { type: "membership" as const } }

    it("matches when value is in grant", () => {
      expect(matchesDimensions({ team: "alpha" }, { team: ["alpha"] }, dimensions)).toBe(true)
    })

    it("rejects when value is not in grant", () => {
      expect(matchesDimensions({ team: "beta" }, { team: ["alpha"] }, dimensions)).toBe(false)
    })

    it("matches with multiple grant values", () => {
      expect(matchesDimensions({ team: "beta" }, { team: ["alpha", "beta"] }, dimensions)).toBe(
        true,
      )
    })

    it("wildcard matches everything", () => {
      expect(matchesDimensions({ team: "gamma" }, { team: ["*"] }, dimensions)).toBe(true)
    })

    it("empty grant matches nothing", () => {
      expect(matchesDimensions({ team: "alpha" }, { team: [] }, dimensions)).toBe(false)
    })

    it("null value on row does not match", () => {
      expect(matchesDimensions({ team: null }, { team: ["alpha"] }, dimensions)).toBe(false)
    })
  })

  describe("level type", () => {
    const dimensions = {
      sensitivity: {
        type: "level" as const,
        order: ["public", "internal", "confidential"],
      },
    }

    it("matches when row level <= grant level", () => {
      expect(
        matchesDimensions({ sensitivity: "public" }, { sensitivity: ["internal"] }, dimensions),
      ).toBe(true)
      expect(
        matchesDimensions({ sensitivity: "internal" }, { sensitivity: ["internal"] }, dimensions),
      ).toBe(true)
    })

    it("rejects when row level > grant level", () => {
      expect(
        matchesDimensions(
          { sensitivity: "confidential" },
          { sensitivity: ["internal"] },
          dimensions,
        ),
      ).toBe(false)
    })

    it("wildcard bypasses level check", () => {
      expect(
        matchesDimensions({ sensitivity: "confidential" }, { sensitivity: ["*"] }, dimensions),
      ).toBe(true)
    })
  })

  describe("enum type", () => {
    const dimensions = { region: { type: "enum" as const, values: ["eu", "us", "ap"] } }

    it("matches like membership", () => {
      expect(matchesDimensions({ region: "eu" }, { region: ["eu"] }, dimensions)).toBe(true)
    })

    it("rejects non-matching value", () => {
      expect(matchesDimensions({ region: "ap" }, { region: ["eu"] }, dimensions)).toBe(false)
    })
  })

  describe("value type", () => {
    const dimensions = { assignee: { type: "value" as const } }

    it("exact match", () => {
      expect(
        matchesDimensions({ assignee: "user-123" }, { assignee: ["user-123"] }, dimensions),
      ).toBe(true)
    })

    it("rejects non-match", () => {
      expect(
        matchesDimensions({ assignee: "user-456" }, { assignee: ["user-123"] }, dimensions),
      ).toBe(false)
    })
  })

  describe("multiple dimensions (AND logic)", () => {
    const dimensions = {
      team: { type: "membership" as const },
      sensitivity: {
        type: "level" as const,
        order: ["public", "internal", "confidential"],
      },
    }

    it("requires ALL dimensions to match", () => {
      expect(
        matchesDimensions(
          { team: "alpha", sensitivity: "public" },
          { team: ["alpha"], sensitivity: ["internal"] },
          dimensions,
        ),
      ).toBe(true)
    })

    it("rejects if any dimension fails", () => {
      expect(
        matchesDimensions(
          { team: "beta", sensitivity: "public" },
          { team: ["alpha"], sensitivity: ["internal"] },
          dimensions,
        ),
      ).toBe(false)
    })
  })

  describe("missing dimension grant", () => {
    const dimensions = { team: { type: "membership" as const } }

    it("denies when user has no grant for dimension", () => {
      expect(matchesDimensions({ team: "alpha" }, {}, dimensions)).toBe(false)
    })
  })
})
