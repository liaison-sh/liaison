// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The staff screens' pure rules: money as people read it, the price a person types, the
// agent mark a person clears, computed article numbers, the layout setting, the checks that
// keep Prepare off, and the only sign button being the reader's own.
import { describe, expect, it } from "bun:test"
import {
  type AgreementBrief,
  type AgreementDetail,
  addBlock,
  agentBlockCount,
  articleNumbers,
  canPrepare,
  clearAgentMark,
  editorChecks,
  filterRows,
  formatMoney,
  layoutOf,
  needsYou,
  PREPARE_WHY,
  parsePrice,
  prepareWhy,
  relinkable,
  STATUS_LABEL,
  setBlockText,
  setLayout,
  sidebarCounts,
  signersForSend,
  statusKey,
  yourOpenLink,
} from "./model"

const brief = (over: Partial<AgreementBrief>): AgreementBrief => ({
  id: "a",
  number: "AG-2026-001",
  title: "T",
  kind: "sow",
  status: "draft",
  needs: "",
  company_id: null,
  renews_on: null,
  price_minor: null,
  currency: null,
  org_access: "editor",
  ...over,
})

const detail = (over: Partial<AgreementDetail["agreement"]> = {}): AgreementDetail => ({
  agreement: {
    ...brief({}),
    what_it_is: null,
    starts_on: null,
    ends_on: null,
    template_id: null,
    template_version: null,
    ...over,
  },
  draft: { lock_version: 1, source: null },
  versions: [],
  shares: [],
  signing_links: [],
})

describe("money", () => {
  it("groups thousands and keeps the cents exact", () => {
    expect(formatMoney("626400", "EUR", "en")).toBe("€6,264.00")
    expect(formatMoney("3800000", "EUR", "en")).toBe("€38,000.00")
    expect(formatMoney("5", "EUR", "en")).toBe("€0.05")
    expect(formatMoney("626400", "EUR", "fr").replace(/\s/g, " ")).toBe("6 264,00 €")
    expect(formatMoney(null, "EUR")).toBe("")
  })

  it("reads what a person types as minor units, or refuses it", () => {
    expect(parsePrice("38000", "EUR")).toBe("3800000")
    expect(parsePrice("38 000,50", "EUR")).toBe("3800050")
    expect(parsePrice("38,000.50", "EUR")).toBe("3800050")
    expect(parsePrice("38,000", "EUR")).toBe("3800000")
    expect(parsePrice("12.5", "EUR")).toBe("1250")
    expect(parsePrice("-3", "EUR")).toBeNull()
    expect(parsePrice("1.234", "EUR")).toBe("123400")
    expect(parsePrice("abc", "EUR")).toBeNull()
    expect(parsePrice("", "EUR")).toBeNull()
  })
})

describe("the document", () => {
  const src = {
    body: {
      blocks: [
        { type: "article", level: 1, heading: "Scope", text: "a", agent_draft: true },
        { type: "article", level: 2, text: "b" },
        { type: "article", level: 2, text: "c" },
        { type: "paragraph", text: "d" },
        { type: "article", level: 1, text: "e", agent_draft: true },
        { type: "article", level: 2, text: "f" },
      ],
    },
  }

  it("numbers articles by position, never by a typed number", () => {
    expect(articleNumbers(src.body.blocks)).toEqual(["1", "1.1", "1.2", null, "2", "2.1"])
  })

  it("a person reading a clause clears its agent mark and keeps the text", () => {
    expect(agentBlockCount(src)).toBe(2)
    const read = clearAgentMark(src, 0)
    expect(read.body?.blocks?.[0]).toEqual({
      type: "article",
      level: 1,
      heading: "Scope",
      text: "a",
    })
    expect(agentBlockCount(read)).toBe(1)
    // A person's own words are theirs: no agent mark stays.
    expect(setBlockText(src, 4, "mine").body?.blocks?.[4]?.agent_draft).toBeUndefined()
    // The source itself is untouched.
    expect(agentBlockCount(src)).toBe(2)
  })

  it("adds a block and sets the classic layout on the page", () => {
    expect(addBlock(null, "paragraph").body?.blocks).toEqual([{ type: "paragraph", text: "" }])
    const legal = setLayout(src, "legal", "fr")
    expect(layoutOf(legal)).toBe("legal")
    expect((legal.body as { page?: unknown }).page).toEqual({ layout: "legal", lang: "fr" })
    expect(layoutOf(setLayout(legal, "standard", "fr"))).toBe("standard")
  })
})

describe("checks before Prepare", () => {
  it("keeps Prepare off while a clause an agent wrote is unread, the price unset or the text empty", () => {
    const agentText = { body: { blocks: [{ type: "paragraph", text: "x", agent_draft: true }] } }
    const priced = detail({ price_minor: "100" })
    expect(canPrepare(editorChecks(priced, agentText))).toBe(false)
    expect(canPrepare(editorChecks(priced, clearAgentMark(agentText, 0)))).toBe(true)
    expect(canPrepare(editorChecks(detail(), clearAgentMark(agentText, 0)))).toBe(false)
    expect(canPrepare(editorChecks(priced, { body: { blocks: [] } }))).toBe(false)
  })
})

describe("what the editor and the list say", () => {
  it("an empty document shows no 'every clause was read' tick, and says why Prepare waits", () => {
    const priced = detail({ price_minor: "100" })
    const empty = editorChecks(priced, { body: { blocks: [] } })
    expect(empty.map((c) => c.code)).not.toContain("AGENT_TEXT_UNREAD")
    expect(prepareWhy(false, empty)).toBe("checks")
    expect(PREPARE_WHY.checks).toContain("Before it can be sent")
    const written = { body: { blocks: [{ type: "paragraph", text: "x" }] } }
    const ready = editorChecks(priced, written)
    expect(ready.find((c) => c.code === "AGENT_TEXT_UNREAD")?.ok).toBe(true)
    expect(prepareWhy(true, ready)).toBe("unsaved")
    expect(prepareWhy(false, ready)).toBeNull()
  })

  it("a change request waiting on the client reads as an approval, never as signatures", () => {
    expect(STATUS_LABEL[statusKey("sent", "change_request")]).toBe(
      "Waiting for the client's approval",
    )
    expect(STATUS_LABEL[statusKey("sent", "sow")]).toBe("Waiting for signatures")
  })
})

describe("the list", () => {
  const rows = [
    brief({ id: "1", status: "draft" }),
    brief({ id: "2", status: "sent", kind: "nda" }),
    brief({ id: "3", status: "signed", renews_on: "2026-12-01" }),
    brief({ id: "4", status: "signed", renews_on: "2027-12-01" }),
  ]
  it("Needs you holds drafts and documents waiting for a signature", () => {
    expect(needsYou(rows).map((r) => r.id)).toEqual(["1", "2"])
  })
  it("filters by sidebar entry and counts them", () => {
    expect(filterRows(rows, "nda", "2026-11-17").map((r) => r.id)).toEqual(["2"])
    // The home tab's entity id names no entry: the whole list.
    expect(filterRows(rows, "home", "2026-11-17")).toHaveLength(4)
    expect(filterRows(rows, "ending", "2026-11-17").map((r) => r.id)).toEqual(["3"])
    expect(sidebarCounts(rows, "2026-11-17")).toMatchObject({
      all: 4,
      waiting: 1,
      ending: 1,
      nda: 1,
      sow: 3,
    })
  })
})

describe("signers", () => {
  it("offers a sign button only for the reader's own open link", () => {
    const link = (over: object) => ({
      client_action_id: "x",
      signer: "S",
      email: "s@x.example",
      sign_order: 1,
      state: "open",
      expires_at: "",
      ...over,
    })
    expect(yourOpenLink([link({})])).toBeNull()
    expect(yourOpenLink([link({ yours: true, state: "waiting_turn" })])).toBeNull()
    expect(yourOpenLink([link({ yours: true, client_action_id: "me" })])?.client_action_id).toBe(
      "me",
    )
  })
  it("offers a new link only for an ended link its signer has no newer link for", () => {
    const link = (id: string, email: string, state: string) => ({
      client_action_id: id,
      signer: "S",
      email,
      sign_order: 1,
      state,
      expires_at: "",
    })
    const ended = link("old", "jean@client.example", "expired")
    const renewed = link("new", "jean@client.example", "open")
    const other = link("other", "anne@client.example", "revoked")
    expect(relinkable([ended, renewed, other]).map((l) => l.client_action_id)).toEqual(["other"])
    expect(relinkable([ended]).map((l) => l.client_action_id)).toEqual(["old"])
  })
  it("takes complete signers only", () => {
    expect(signersForSend([{ name: "Jean", email: "jean@client.example" }])).toEqual([
      { name: "Jean", email: "jean@client.example" },
    ])
    expect(signersForSend([{ name: "Jean", email: "not an address" }])).toBeNull()
    expect(signersForSend([{ name: "", email: "" }])).toBeNull()
  })
})
