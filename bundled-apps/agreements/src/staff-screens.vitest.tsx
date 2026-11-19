// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The staff screens, rendered: the list opens an agreement, the agreement offers a sign
// button only for the reader's own open link, the editor clears an agent's mark and saves
// the person's text, sets the price as minor units and keeps Prepare off until the checks
// pass, and the send tab freezes then sends with what the person typed.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createResource } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { STAND_IN_SENTENCE } from "./stand-in"
import { AgreementDetailView } from "./ui/Detail"
import { AgreementEditor } from "./ui/Editor"
import { AgreementsList } from "./ui/List"
import { AgreementNew } from "./ui/New"
import { AgreementSend } from "./ui/Send"

const navigateMock = vi.fn<(path: string) => void>()
const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
let answers: Record<string, (args: Record<string, unknown>) => unknown> = {}
let fetched: (url: string) => unknown = () => []

vi.mock("@liaison/host", () => ({
  app: {
    invokeTool: async (tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args })
      const answer = answers[tool]
      if (!answer) throw new Error(`no answer for ${tool}`)
      return answer(args)
    },
    createResource: (fetcher: () => unknown) => createResource(fetcher),
  },
  fetch: async (url: string) => fetched(url),
  fetchBlob: async () => new Blob(),
  openFile: async () => true,
  navigate: (path: string) => navigateMock(path),
  currentPath: () => window.location.pathname,
  hostLocale: () => "en",
  onEntityChange: () => () => {},
}))

const ID = "0f8a2c1e-1111-4111-8111-111111111111"

function agreement(over: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) {
  return {
    status: "ok",
    agreement: {
      id: ID,
      number: "AG-2026-014",
      title: "Booking and tracking",
      kind: "sow",
      status: "draft",
      needs: "being drafted",
      company_id: null,
      renews_on: null,
      price_minor: null,
      currency: null,
      org_access: "editor",
      what_it_is: null,
      starts_on: null,
      ends_on: null,
      template_id: null,
      template_version: null,
      ...over,
    },
    draft: {
      lock_version: 3,
      source: {
        body: {
          blocks: [
            { type: "heading", level: 1, text: "Statement of work" },
            {
              type: "article",
              level: 1,
              heading: "Scope",
              text: "A booking screen.",
              agent_draft: true,
            },
          ],
        },
      },
    },
    versions: [],
    shares: [],
    signing_links: [],
    ...rest,
  }
}

beforeEach(() => {
  navigateMock.mockClear()
  calls.length = 0
  answers = {}
})
afterEach(() => cleanup())

describe("the list", () => {
  it("puts drafts and waiting documents under Needs you and opens a row's agreement", async () => {
    answers.home_load = () => ({
      status: "ok",
      items: [
        { ...agreement().agreement },
        {
          ...agreement().agreement,
          id: "b",
          number: "AG-2026-006",
          status: "signed",
          price_minor: "626400",
          currency: "EUR",
        },
      ],
    })
    render(() => <AgreementsList entityId="home" />)
    expect(await screen.findByTestId(`agreements-needs-${ID}`)).toBeTruthy()
    expect(screen.queryByTestId("agreements-needs-b")).toBeNull()
    expect(screen.getByTestId("agreements-row-b").textContent).toContain("€6,264.00")
    fireEvent.click(screen.getByTestId(`agreements-needs-${ID}`))
    expect(navigateMock).toHaveBeenCalledWith(`/agreements/agreement/${ID}`)
    expect(screen.getByTestId("agreements-sort-sentence")).toBeTruthy()
  })

  it("says so when there is none, and when the list cannot load", async () => {
    answers.home_load = () => ({ status: "ok", items: [] })
    render(() => <AgreementsList entityId="all" />)
    expect(await screen.findByTestId("agreements-list-empty")).toBeTruthy()
    cleanup()
    answers.home_load = () => {
      throw new Error("timed out")
    }
    render(() => <AgreementsList entityId="all" />)
    expect(await screen.findByTestId("agreements-list-error")).toBeTruthy()
  })
})

describe("the agreement", () => {
  const link = (over: Record<string, unknown>) => ({
    client_action_id: "x",
    signer: "Jean Tessier",
    email: "jean@client.example",
    sign_order: 1,
    state: "open",
    expires_at: "2026-11-30",
    ...over,
  })

  it("offers Read and sign for the reader's own open link only, and opens the kernel's sign tab", async () => {
    answers.agreement_get = () =>
      agreement(
        { status: "partly_signed" },
        {
          signing_links: [
            link({ client_action_id: "theirs", state: "decided" }),
            link({ client_action_id: "mine", signer: "Léa Fontaine", sign_order: 2, yours: true }),
          ],
        },
      )
    render(() => <AgreementDetailView entityId={ID} />)
    const sign = await screen.findByTestId("agreement-read-and-sign")
    fireEvent.click(sign)
    expect(navigateMock).toHaveBeenCalledWith("/sign/mine")
    expect(screen.getAllByTestId("agreement-read-and-sign")).toHaveLength(1)
  })

  it("never shows a sign button for another person's link", async () => {
    answers.agreement_get = () =>
      agreement({ status: "sent" }, { signing_links: [link({ client_action_id: "theirs" })] })
    render(() => <AgreementDetailView entityId={ID} />)
    expect(await screen.findByTestId("agreement-signer-theirs")).toBeTruthy()
    expect(screen.queryByTestId("agreement-read-and-sign")).toBeNull()
    expect(screen.getByTestId("agreement-remind")).toBeTruthy()
  })

  it("says what happened to a link that ended, and offers a new one", async () => {
    answers.agreement_get = () =>
      agreement(
        { status: "expired" },
        { signing_links: [link({ client_action_id: "late", state: "expired" })] },
      )
    answers.agreement_new_link = () => ({ status: "ok", message: "sent" })
    render(() => <AgreementDetailView entityId={ID} />)
    expect(await screen.findByTestId("agreement-state-expired")).toBeTruthy()
    fireEvent.click(screen.getByTestId("agreement-new-link-late"))
    await waitFor(() => expect(calls.some((c) => c.tool === "agreement_new_link")).toBe(true))
    expect(calls.find((c) => c.tool === "agreement_new_link")?.args).toEqual({
      client_action_id: "late",
    })
  })

  it("offers a new link in one click on a decline made without the emailed code, and only then", async () => {
    answers.agreement_get = () =>
      agreement(
        { status: "declined" },
        {
          signing_links: [
            link({ client_action_id: "unproven", state: "declined", code_verified: false }),
            link({ client_action_id: "proven", state: "declined", sign_order: 2 }),
          ],
        },
      )
    answers.agreement_new_link = () => ({ status: "ok", message: "sent" })
    render(() => <AgreementDetailView entityId={ID} />)
    const relink = await screen.findByTestId("agreement-not-them-unproven")
    expect(relink.textContent).toContain("If this was not them, send a new link")
    expect(screen.queryByTestId("agreement-not-them-proven")).toBeNull()
    fireEvent.click(relink)
    await waitFor(() => expect(calls.some((c) => c.tool === "agreement_new_link")).toBe(true))
    expect(calls.find((c) => c.tool === "agreement_new_link")?.args).toEqual({
      client_action_id: "unproven",
    })
  })

  it("says the signed copy did not match, offers no repair, and lets a person withdraw it", async () => {
    answers.agreement_get = () =>
      agreement(
        { status: "signed" },
        {
          versions: [
            {
              id: "v1",
              number: 1,
              status: "signed",
              sha256: "a".repeat(64),
              page_count: 2,
              frozen_at: "2026-11-10",
              copy_differs: true,
            },
          ],
          signing_links: [link({ client_action_id: "done", state: "decided" })],
        },
      )
    answers.agreement_evidence_get = () => ({ status: "error", error: { code: "NOT_SEALED" } })
    answers.agreement_void = () => ({ status: "ok", message: "voided" })
    render(() => <AgreementDetailView entityId={ID} />)
    const state = await screen.findByTestId("agreement-state-copy-differs")
    expect(state.textContent).toContain(
      "The signed copy did not match what was read. Nothing was sealed. Send it again.",
    )
    expect(screen.queryByText(/seal again|repair|try again/i)).toBeNull()
    fireEvent.click(screen.getByTestId("agreement-void-open"))
    fireEvent.input(screen.getByTestId("agreement-void-reason"), {
      target: { value: "print to a clean PDF" },
    })
    fireEvent.click(screen.getByTestId("agreement-void"))
    await waitFor(() => expect(calls.some((c) => c.tool === "agreement_void")).toBe(true))
    expect(calls.find((c) => c.tool === "agreement_void")?.args).toEqual({
      id: ID,
      reason: "print to a clean PDF",
    })
  })

  it("a plainly signed agreement shows neither the difference nor a way to withdraw it", async () => {
    answers.agreement_get = () =>
      agreement(
        { status: "signed" },
        {
          versions: [
            {
              id: "v1",
              number: 1,
              status: "signed",
              sha256: "a".repeat(64),
              page_count: 2,
              frozen_at: "2026-11-10",
            },
          ],
        },
      )
    render(() => <AgreementDetailView entityId={ID} />)
    expect(await screen.findByTestId("agreement-overview")).toBeTruthy()
    expect(screen.queryByTestId("agreement-state-copy-differs")).toBeNull()
    expect(screen.queryByTestId("agreement-void-open")).toBeNull()
  })
})

describe("the editor", () => {
  it("clears an agent's mark when a person reads the clause, and saves the person's text", async () => {
    answers.agreement_get = () => agreement({ price_minor: "3800000", currency: "EUR" })
    answers.agreement_update = () => ({ status: "ok", message: "saved" })
    render(() => <AgreementEditor entityId={ID} />)
    const block = await screen.findByTestId("agreement-block-1")
    expect(block.getAttribute("data-agent")).toBe("true")
    const prepare = screen.getByTestId("agreement-editor-prepare") as HTMLButtonElement
    expect(prepare.disabled).toBe(true)
    expect(screen.getByTestId("agreement-check-AGENT_TEXT_UNREAD").getAttribute("data-ok")).toBe(
      "false",
    )

    fireEvent.click(screen.getByTestId("agreement-block-read-1"))
    expect(screen.getByTestId("agreement-block-1").getAttribute("data-agent")).toBeNull()
    expect(screen.getByTestId("agreement-check-AGENT_TEXT_UNREAD").getAttribute("data-ok")).toBe(
      "true",
    )
    // Unsaved: Prepare waits for the save.
    expect(prepare.disabled).toBe(true)
    fireEvent.click(screen.getByTestId("agreement-editor-save"))
    await waitFor(() => expect(calls.some((c) => c.tool === "agreement_update")).toBe(true))
    const saved = calls.find((c) => c.tool === "agreement_update")?.args as {
      lock_version: number
      source: { body: { blocks: Array<Record<string, unknown>> } }
    }
    expect(saved.lock_version).toBe(3)
    expect(saved.source.body.blocks[1]).toEqual({
      type: "article",
      level: 1,
      heading: "Scope",
      text: "A booking screen.",
    })
  })

  it("sets the price a person types, as minor units, through the person-only tool", async () => {
    answers.agreement_get = () => agreement()
    answers.agreement_price_set = () => ({ status: "ok", message: "set" })
    render(() => <AgreementEditor entityId={ID} />)
    expect((await screen.findByTestId("agreement-price-panel")).textContent).toContain(
      "No price yet",
    )
    fireEvent.input(screen.getByTestId("agreement-price-input"), { target: { value: "38 000" } })
    fireEvent.click(screen.getByTestId("agreement-price-set"))
    await waitFor(() => expect(calls.some((c) => c.tool === "agreement_price_set")).toBe(true))
    expect(calls.find((c) => c.tool === "agreement_price_set")?.args).toEqual({
      id: ID,
      price_minor: "3800000",
      currency: "EUR",
    })
  })

  it("keeps a person's unsaved writing when the price is set", async () => {
    answers.agreement_get = () => agreement()
    answers.agreement_price_set = () => ({ status: "ok", message: "set" })
    render(() => <AgreementEditor entityId={ID} />)
    const text = (await screen.findByTestId("agreement-block-text-1")) as HTMLTextAreaElement
    fireEvent.input(text, { target: { value: "My own words." } })
    fireEvent.input(screen.getByTestId("agreement-price-input"), { target: { value: "1200" } })
    fireEvent.click(screen.getByTestId("agreement-price-set"))
    await waitFor(() => expect(calls.filter((c) => c.tool === "agreement_get")).toHaveLength(2))
    expect((screen.getByTestId("agreement-block-text-1") as HTMLTextAreaElement).value).toBe(
      "My own words.",
    )
  })

  it("warns before changing a sent agreement", async () => {
    answers.agreement_get = () => agreement({ status: "sent" })
    render(() => <AgreementEditor entityId={ID} />)
    expect(await screen.findByTestId("agreement-editor-replaces")).toBeTruthy()
  })
})

describe("prepare and send", () => {
  it("freezes first, then sends the frozen version to the signers the person typed", async () => {
    answers.agreement_get = () => agreement({ price_minor: "3800000", currency: "EUR" })
    answers.agreement_prepare = () => ({
      status: "ok",
      version_id: "v1",
      version: 1,
      sha256: "c".repeat(64),
      page_count: 2,
    })
    answers.agreement_send = () => ({ status: "ok", message: "sent" })
    render(() => <AgreementSend entityId={ID} />)
    fireEvent.click(await screen.findByTestId("agreement-send-prepare"))
    expect((await screen.findByTestId("agreement-send-frozen")).textContent).toContain(
      "c".repeat(64),
    )
    const send = screen.getByTestId("agreement-send-submit") as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.input(screen.getByTestId("agreement-send-signer-name-0"), {
      target: { value: "Jean Tessier" },
    })
    fireEvent.input(screen.getByTestId("agreement-send-signer-email-0"), {
      target: { value: "jean@client.example" },
    })
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith(`/agreements/agreement/${ID}`))
    expect(calls.find((c) => c.tool === "agreement_send")?.args).toEqual({
      version_id: "v1",
      sha256: "c".repeat(64),
      signers: [{ name: "Jean Tessier", email: "jean@client.example" }],
      order: "sequential",
      expires_in_days: 14,
    })
  })
})

describe("a new agreement", () => {
  afterEach(() => {
    fetched = () => []
  })

  it("is made for a client company the person picks, so it reaches that client", async () => {
    fetched = (url) =>
      url.startsWith("/api/contacts/companies")
        ? [{ id: "c0000000-0000-4000-8000-000000000001", name: "Maison Brun" }]
        : []
    answers.templates_list = () => ({ status: "ok", items: [] })
    answers.agreement_create = () => ({ status: "ok", agreement: { id: ID } })
    render(() => <AgreementNew />)
    const company = (await screen.findByTestId("agreement-new-company")) as HTMLSelectElement
    await waitFor(() => expect(company.options.length).toBe(2))
    fireEvent.change(company, { target: { value: "c0000000-0000-4000-8000-000000000001" } })
    fireEvent.input(screen.getByTestId("agreement-new-title"), { target: { value: "Website" } })
    fireEvent.click(screen.getByTestId("agreement-new-create"))
    await waitFor(() => expect(calls.some((c) => c.tool === "agreement_create")).toBe(true))
    expect(calls.find((c) => c.tool === "agreement_create")?.args).toMatchObject({
      title: "Website",
      company_id: "c0000000-0000-4000-8000-000000000001",
    })
  })
})

describe("the editor of an uploaded document", () => {
  it("shows the file it is, offers no text to add, and no 'no text' check", async () => {
    const base = agreement({
      kind: "other",
      status: "sent",
      upload: true,
      what_it_is: "Term sheet",
    })
    answers.agreement_get = () => ({
      ...base,
      draft: { lock_version: 1, source: null },
      versions: [
        { id: "v1", number: 1, status: "frozen", sha256: "d".repeat(64), file_id: "file-up" },
      ],
    })
    render(() => <AgreementEditor entityId={ID} />)
    expect((await screen.findByTestId("agreement-editor-upload")).textContent).toContain(
      "uploaded PDF",
    )
    expect(screen.queryByText(/has no text yet/)).toBeNull()
    expect(screen.queryByTestId("agreement-add-block")).toBeNull()
    expect(screen.getByTestId("agreement-checks").textContent ?? "").not.toMatch(/no text/i)
    expect(screen.getByTestId("agreement-editor-upload-open")).toBeTruthy()
  })

  it("offers no layout to choose: a layout lays out text, and a file has none to lay out", async () => {
    const base = agreement({
      kind: "other",
      status: "draft",
      upload: true,
      what_it_is: "Term sheet",
    })
    answers.agreement_get = () => ({
      ...base,
      draft: { lock_version: 1, source: null },
      versions: [],
    })
    render(() => <AgreementEditor entityId={ID} />)
    await screen.findByTestId("agreement-editor-upload")
    expect(screen.queryByTestId("agreement-layout")).toBeNull()
  })
})

describe("the proof of signature on the agreement's page", () => {
  const evidence = (over: Record<string, unknown> = {}) => ({
    status: "ok",
    document_sha256: "a".repeat(64),
    signed_pdf_sha256: "b".repeat(64),
    seal: "c".repeat(64),
    sealed_at: "2026-11-10",
    timestamp: "stamped",
    timestamped_at: "2026-11-10",
    last_verified_at: null,
    last_verify_ok: null,
    retention_until: "2032-11-10",
    devices: "shown",
    signers: [],
    signed_pdf_file_id: "file-signed",
    evidence_file_id: "file-zip",
    ...over,
  })

  it("downloads the signed PDF and the evidence file, and says what it proves and does not", async () => {
    answers.agreement_get = () => agreement({ status: "signed" })
    answers.agreement_evidence_get = () => evidence()
    render(() => <AgreementDetailView entityId={ID} />)
    fireEvent.click(await screen.findByTestId("agreement-pane-evidence"))
    expect(await screen.findByTestId("agreement-download-signed")).toBeTruthy()
    expect(screen.getByTestId("agreement-download-evidence")).toBeTruthy()
    const text = screen.getByTestId("agreement-evidence").textContent ?? ""
    expect(text).toContain("What this proves, and what it does not")
    expect(text).toContain("How long it is kept")
    expect(text).toContain("If you leave Liaison")
  })

  it("a seeded agreement's detail and evidence say the signature is a stand-in and offer no download or offline check", async () => {
    answers.agreement_get = () => agreement({ status: "signed" })
    // What agreement_evidence_get answers on a stand-in signature: no fingerprint, no file.
    answers.agreement_evidence_get = () => ({
      status: "ok",
      agreement: { id: ID, number: "AG-2026-014" },
      version: 1,
      level: "demo",
      result: "stand-in",
      message: `AG-2026-014 version 1: stand-in. ${STAND_IN_SENTENCE}`,
    })
    render(() => <AgreementDetailView entityId={ID} />)
    expect((await screen.findByTestId("agreement-stand-in")).textContent).toBe(STAND_IN_SENTENCE)
    fireEvent.click(await screen.findByTestId("agreement-pane-evidence"))
    const frame = await screen.findByTestId("agreement-evidence-stand-in")
    expect(frame.textContent).toContain(STAND_IN_SENTENCE)
    expect(frame.textContent).toContain("There is no evidence file to download or check.")
    for (const testid of [
      "agreement-verify",
      "agreement-download-signed",
      "agreement-download-evidence",
    ])
      expect(screen.queryByTestId(testid)).toBeNull()
  })

  it("a really signed agreement's page says nothing of a stand-in", async () => {
    answers.agreement_get = () => agreement({ status: "signed" })
    answers.agreement_evidence_get = () => evidence({ level: "simple" })
    render(() => <AgreementDetailView entityId={ID} />)
    await screen.findByTestId("agreement-overview")
    fireEvent.click(await screen.findByTestId("agreement-pane-evidence"))
    expect(await screen.findByTestId("agreement-verify")).toBeTruthy()
    expect(screen.queryByTestId("agreement-stand-in")).toBeNull()
    expect(screen.queryByTestId("agreement-evidence-stand-in")).toBeNull()
  })

  it("offers no evidence file to someone without the devices permission", async () => {
    answers.agreement_get = () => agreement({ status: "signed" })
    answers.agreement_evidence_get = () =>
      evidence({ devices: "withheld", evidence_file_id: undefined })
    render(() => <AgreementDetailView entityId={ID} />)
    fireEvent.click(await screen.findByTestId("agreement-pane-evidence"))
    expect(await screen.findByTestId("agreement-download-signed")).toBeTruthy()
    expect(screen.queryByTestId("agreement-download-evidence")).toBeNull()
  })
})
