// SPDX-License-Identifier: FSL-1.1-ALv2
// Value formats of a list column (M2): basis points read as a percentage and a
// stored Postgres timestamp reads as a relative time, never the raw value.
import { render, screen } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createFakeApi, type FakeApi } from "./__fixtures__/fake-api"
import { formatBasisPoints, normaliseTimestamp } from "./cell-format"
import type { SettingsListBlock } from "./types"

const state = vi.hoisted(() => ({ api: null as unknown }))
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => state.api,
  useOptionalApi: () => state.api,
}))

import { ListBlock } from "./ListBlock"

describe("formatBasisPoints", () => {
  it("reads basis points as a percentage in the reader's locale", () => {
    expect(formatBasisPoints(2000, "en")).toBe("20%")
    expect(formatBasisPoints(550, "en")).toBe("5.5%")
    expect(formatBasisPoints(0, "en")).toBe("0%")
    expect(formatBasisPoints("2000", "en")).toBe("20%")
    expect(formatBasisPoints(2000, "fr").replace(/\s/g, " ")).toBe("20 %")
    expect(formatBasisPoints(null, "en")).toBe("")
  })
})

describe("normaliseTimestamp", () => {
  it("turns Postgres timestamp text into ISO 8601", () => {
    expect(normaliseTimestamp("2026-10-21 15:13:02.817+00")).toBe("2026-10-21T15:13:02.817+00:00")
    expect(normaliseTimestamp("2026-10-21 15:13:02+0200")).toBe("2026-10-21T15:13:02+02:00")
    expect(normaliseTimestamp("2026-10-21T15:13:02.817Z")).toBe("2026-10-21T15:13:02.817Z")
    expect(normaliseTimestamp(null)).toBeNull()
    expect(normaliseTimestamp("")).toBeNull()
  })
})

describe("ListBlock value formats", () => {
  let api: FakeApi
  const block: SettingsListBlock = {
    block: "list",
    ops: { list: "regimes.list" },
    columns: [
      { key: "code", label: "Code" },
      { key: "rate", label: "Rate", format: "basisPoints" },
      { key: "usedAt", label: "Last used", format: "datetime" },
    ],
  }
  beforeEach(() => {
    api = createFakeApi()
    state.api = api
  })

  it("shows a percentage and a relative time, never basis points or a raw timestamp", async () => {
    const pg = new Date(Date.now() - 3 * 86_400_000)
      .toISOString()
      .replace("T", " ")
      .replace("Z", "+00")
    api.tool("fixture:regimes.list", () => [{ id: "r1", code: "FR", rate: 2000, usedAt: pg }])
    render(() => <ListBlock app="fixture" block={block} blockId="regimes-0" />)
    const text = (await screen.findByTestId("settings-list-row-r1")).textContent ?? ""
    expect(text).toContain("20%")
    expect(text).not.toContain("2000")
    expect(text).not.toContain(pg)
    expect(text).not.toContain("Never")
    expect(text).toMatch(/3\s?d/)
  })
})
