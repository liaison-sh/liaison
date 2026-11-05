// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The withheld block that travels to the requester on the agent reply, and to
// nobody else.

import { describe, expect, test } from "bun:test"
import {
  buildWithheldItems,
  buildWithheldMessageMetadata,
  projectMessageMetadataForViewer,
} from "./withheld-capability"

const REQUESTER = "00000000-0000-0000-0000-0000000000a1"
const OTHER = "00000000-0000-0000-0000-0000000000a2"

describe("buildWithheldItems", () => {
  test("one item per distinct label, and no raw scope on it anywhere", () => {
    const items = buildWithheldItems(["pennylane:payouts:read", "pennylane:ledger:read"], {
      categoryLabels: { pennylane: "finance data" },
    })
    expect(items).toEqual([{ label: "finance data" }])
    expect(JSON.stringify(items)).not.toContain("pennylane:")
  })

  test("a scope-tainted turn marks every item, so no item offers a rerun", () => {
    const items = buildWithheldItems(["pennylane:payouts:read", "tickets:tickets:read"], {
      categoryLabels: { pennylane: "finance data", tickets: "support data" },
      scopeTainted: true,
    })
    expect(items.map((i) => i.scopeTainted)).toEqual([true, true])
  })

  test("an item whose label covers a closed scope is marked non-disclosable", () => {
    const items = buildWithheldItems(["pennylane:payouts:read", "pennylane:ledger:read"], {
      categoryLabels: { pennylane: "finance data" },
      nonDisclosableScopes: ["pennylane:ledger:read"],
    })
    expect(items[0].nonDisclosable).toBe(true)
  })

  test("labels never carry the raw scope string", () => {
    const items = buildWithheldItems(["secretapp:vault:read"], {})
    expect(items[0].label).toBe("a capability")
    expect(items[0].label).not.toContain("secretapp")
  })
})

describe("buildWithheldMessageMetadata", () => {
  test("a turn that withheld nothing produces no block at all", () => {
    expect(
      buildWithheldMessageMetadata({ requesterId: REQUESTER, turnId: null, withheldScopes: [] }),
    ).toBeUndefined()
  })

  test("the block names the requester and the turn it would rerun, and no raw scope", () => {
    const block = buildWithheldMessageMetadata({
      requesterId: REQUESTER,
      turnId: "00000000-0000-0000-0000-0000000000b1",
      withheldScopes: ["pennylane:payouts:read"],
    })
    expect(block?.requesterId).toBe(REQUESTER)
    expect(block?.turnId).toBe("00000000-0000-0000-0000-0000000000b1")
    // The shipped curated label (d9cacca20 made it the default): the category,
    // never the raw scope or the app's machine name.
    expect(block?.items).toEqual([{ label: "finance data" }])
    expect(JSON.stringify(block)).not.toContain("pennylane")
  })
})

describe("projectMessageMetadataForViewer", () => {
  test("the requester reads the withheld block", () => {
    const meta = { modelId: "m", withheld: { requesterId: REQUESTER, turnId: null, items: [] } }
    expect(projectMessageMetadataForViewer(meta, REQUESTER)).toEqual(meta)
  })

  test("another member gets the metadata with the key GONE, not emptied", () => {
    const meta = {
      modelId: "m",
      withheld: { requesterId: REQUESTER, turnId: null, items: [{ label: "finance data" }] },
    }
    const seen = projectMessageMetadataForViewer(meta, OTHER) as Record<string, unknown>
    expect(seen.modelId).toBe("m")
    expect("withheld" in seen).toBe(false)
  })

  test("a legacy row's raw scope name is stripped for the requester too", () => {
    const meta = {
      modelId: "m",
      withheld: {
        requesterId: REQUESTER,
        turnId: null,
        items: [
          { label: "finance data", scopeName: "finance:payouts:read" },
          { label: "files", scopeName: "files:read", nonDisclosable: true },
        ],
      },
    }
    const seen = projectMessageMetadataForViewer(meta, REQUESTER) as {
      withheld: { items: Array<Record<string, unknown>> }
    }
    expect(seen.withheld.items).toEqual([
      { label: "finance data" },
      { label: "files", nonDisclosable: true },
    ])
    // The stored row is never mutated: the projection is a read-path view.
    expect(meta.withheld.items[0]?.scopeName).toBe("finance:payouts:read")
  })

  test("metadata with no withheld block is returned untouched", () => {
    const meta = { modelId: "m" }
    expect(projectMessageMetadataForViewer(meta, OTHER)).toBe(meta)
    expect(projectMessageMetadataForViewer(null, OTHER)).toBe(null)
  })
})
