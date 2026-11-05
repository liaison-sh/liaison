// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ApprovalCard from "./ApprovalCard"
import { handleWsCreate, handleWsUpdate, resetApprovalsStore } from "./approvals-store"
import { DecisionQueueTestAccess, decisionToastItems } from "./decision-queue"

let currentScope: string[] = ["seq_test:approve"]
let currentUserId = "u-approver"
const apiMocks = {
  get: vi.fn().mockResolvedValue(undefined),
  post: vi.fn(),
}

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => apiMocks,
  useOptionalApi: () => apiMocks,
}))

vi.mock("~/modules/auth/auth-store", () => ({
  hasScope: (s: string) => currentScope.includes(s),
  userFromToken: () => ({ userId: currentUserId, name: "Test User", scopes: currentScope }),
}))

vi.mock("~/modules/shell/toast-store", () => ({
  addToast: vi.fn(),
}))

vi.mock("~/modules/shell/entity-opener", () => ({
  openEntity: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("~/modules/shell/tab-store", () => ({
  openTab: vi.fn(),
}))

const head = (over = {}): any => ({
  id: "11111111-1111-4111-8111-111111111111",
  handle: "request-1",
  status: "pending",
  createdAt: "2026-05-21T12:00:00Z",
  expiresAt: "2026-05-21T13:00:00Z",
  toolName: "seq_test:step1",
  summary: { kind: "seq.step1", title: "Create return label", lines: [] },
  editableFields: [],
  currentPayload: {},
  threadId: "t-1",
  originatingThreadId: "t-1",
  requestedBy: { id: "u-req" },
  requester: { kind: "user", id: "u-req", name: "Agent" },
  notifyUserIds: ["u-approver"],
  lastEdit: null,
  bundleId: "11111111-1111-4111-8111-111111111111",
  bundlePosition: 0,
  ...over,
})
const step2: any = {
  id: "ar-step2",
  handle: "request-2",
  status: "deferred",
  createdAt: "2026-05-21T12:00:01Z",
  expiresAt: "2026-05-21T13:00:00Z",
  toolName: "seq_test:step2",
  summary: {
    kind: "seq.step2",
    title: "Reply to customer",
    lines: ["Attaches @ref:11111111-1111-4111-8111-111111111111:label_pdf"],
  },
  editableFields: [],
  currentPayload: { body: "Your label: @ref:11111111-1111-4111-8111-111111111111:label_pdf" },
  threadId: "t-1",
  originatingThreadId: "t-1",
  requestedBy: { id: "u-req" },
  requester: { kind: "user", id: "u-req", name: "Agent" },
  notifyUserIds: ["u-approver"],
  lastEdit: null,
  bundleId: "11111111-1111-4111-8111-111111111111",
  bundlePosition: 1,
}

const STEP_EDITABLE_ID = "22222222-2222-4222-8222-222222222222"
const stepEditable: any = {
  id: STEP_EDITABLE_ID,
  handle: "request-3",
  status: "deferred",
  createdAt: "2026-05-21T12:00:02Z",
  expiresAt: "2026-05-21T13:00:00Z",
  toolName: "seq_test:reply",
  summary: { kind: "seq.reply", title: "Reply to customer", lines: [] },
  editableFields: [{ field: "body", label: "Message", widget: "richtext" }],
  currentPayload: { body: "Draft reply text" },
  threadId: "t-1",
  originatingThreadId: "t-1",
  requestedBy: { id: "u-req" },
  requester: { kind: "user", id: "u-req", name: "Agent" },
  notifyUserIds: ["u-approver"],
  lastEdit: null,
  bundleId: "11111111-1111-4111-8111-111111111111",
  bundlePosition: 1,
}
// Same step, but its only editable field carries a token → must stay read-only.
const stepTokenLocked: any = {
  ...stepEditable,
  id: "33333333-3333-4333-8333-333333333333",
  handle: "request-4",
  currentPayload: { body: "Tracking: @ref:11111111-1111-4111-8111-111111111111:tracking_number" },
}

beforeEach(() => {
  resetApprovalsStore()
  currentScope = ["seq_test:approve"]
  currentUserId = "u-approver"
  apiMocks.get.mockReset().mockResolvedValue(undefined)
  apiMocks.post.mockReset()
})

describe("ApprovalCard — bundle", () => {
  it("renders all steps and one Approve action when the card is a bundle head", async () => {
    apiMocks.get.mockResolvedValue([head(), step2])
    handleWsCreate(head(), "u-approver")
    render(() => <ApprovalCard requestId="11111111-1111-4111-8111-111111111111" />)

    expect(await screen.findByTestId("approval-card-title")).toHaveTextContent(
      "Create return label",
    )
    expect(await screen.findByTestId("approval-bundle-step-1")).toHaveTextContent(
      "Reply to customer",
    )
    expect(screen.getAllByTestId("approval-card-action-approve")).toHaveLength(1)
  })

  it("titles a sequence by its last step, and keeps the head's own title as step 1", async () => {
    const sequenced = { ...step2, dependsOnId: "11111111-1111-4111-8111-111111111111" }
    apiMocks.get.mockResolvedValue([head(), sequenced])
    handleWsCreate(head(), "u-approver")
    render(() => <ApprovalCard requestId="11111111-1111-4111-8111-111111111111" />)

    const title = await screen.findByTestId("approval-card-title")
    await waitFor(() => expect(title).toHaveTextContent("Reply to customer"))
    expect(screen.getByTestId("approval-card-bundle-steps")).toHaveTextContent("2 steps")
    expect(screen.getByTestId("approval-card-head-step")).toHaveTextContent(
      "Step 1: Create return label",
    )
    expect(await screen.findByTestId("approval-bundle-step-1")).toHaveTextContent(
      "Reply to customer",
    )
  })

  it("approving a sequence queues ONE decision named by its outcome, with every step", async () => {
    DecisionQueueTestAccess.reset()
    const sequenced = { ...step2, dependsOnId: "11111111-1111-4111-8111-111111111111" }
    apiMocks.get.mockResolvedValue([head(), sequenced])
    handleWsCreate(head(), "u-approver")
    render(() => <ApprovalCard requestId="11111111-1111-4111-8111-111111111111" />)
    const title = await screen.findByTestId("approval-card-title")
    await waitFor(() => expect(title).toHaveTextContent("Reply to customer"))

    fireEvent.click(screen.getAllByTestId("approval-card-action-approve")[0] as HTMLElement)
    await waitFor(() => expect(decisionToastItems()).toHaveLength(1))
    const [item] = decisionToastItems()
    expect(item?.id).toBe("11111111-1111-4111-8111-111111111111")
    expect(item?.label?.title).toBe("Reply to customer")
    expect(item?.label?.steps).toEqual(["Create return label", "Reply to customer"])
    DecisionQueueTestAccess.reset()
  })

  it("humanizes @ref tokens in a deferred step's displayed text", async () => {
    apiMocks.get.mockResolvedValue([head(), step2])
    handleWsCreate(head(), "u-approver")
    render(() => <ApprovalCard requestId="11111111-1111-4111-8111-111111111111" />)
    const step = await screen.findByTestId("approval-bundle-step-1")
    expect(step.textContent).not.toContain("@ref:")
    // Named after the step it comes from, not a bare key.
    expect(step.textContent).toContain("label PDF from step 1]")
  })

  it("edits a deferred step's payload and posts to that step's own route", async () => {
    apiMocks.get.mockResolvedValue([head(), stepEditable])
    apiMocks.post.mockResolvedValue({ id: STEP_EDITABLE_ID, currentPayload: {}, lastEdit: null })
    handleWsCreate(head(), "u-approver")
    render(() => <ApprovalCard requestId="11111111-1111-4111-8111-111111111111" />)

    fireEvent.click(await screen.findByTestId("approval-bundle-step-1-edit"))
    const input = (await screen.findByTestId(
      "approval-bundle-step-1-field-body",
    )) as HTMLTextAreaElement
    fireEvent.input(input, { target: { value: "Revised reply text" } })
    fireEvent.click(screen.getByTestId("approval-bundle-step-1-save"))

    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith(`/approvals/${STEP_EDITABLE_ID}/payload`, {
        fields: { body: "Revised reply text" },
      }),
    )
  })

  it("keeps an open step editor, and what was typed into it, across a store refresh", async () => {
    // Every store write replaces the row object, and the step rows used to be
    // reconciled by that object's identity: a WS update on a step that had not
    // changed tore the row down and built a new one, closing an editor the
    // person was in the middle of using.
    apiMocks.get.mockResolvedValue([head(), stepEditable])
    handleWsCreate(head(), "u-approver")
    render(() => <ApprovalCard requestId="11111111-1111-4111-8111-111111111111" />)

    fireEvent.click(await screen.findByTestId("approval-bundle-step-1-edit"))
    const input = (await screen.findByTestId(
      "approval-bundle-step-1-field-body",
    )) as HTMLTextAreaElement
    fireEvent.input(input, { target: { value: "Half written reply" } })

    // The same step, same status, as a fresh object: exactly what a WS frame or
    // a refetch delivers.
    handleWsUpdate({ ...stepEditable })

    await waitFor(() => {
      const after = screen.queryByTestId(
        "approval-bundle-step-1-field-body",
      ) as HTMLTextAreaElement | null
      expect(after, "the step editor must survive a refresh of its own row").not.toBeNull()
      expect(after?.value).toBe("Half written reply")
    })
    expect(screen.getByTestId("approval-bundle-step-1-save")).toBeTruthy()
  })

  it("keeps a token-bearing step field read-only — no Edit button", async () => {
    apiMocks.get.mockResolvedValue([head(), stepTokenLocked])
    handleWsCreate(head(), "u-approver")
    render(() => <ApprovalCard requestId="11111111-1111-4111-8111-111111111111" />)

    await screen.findByTestId("approval-bundle-step-1")
    expect(screen.queryByTestId("approval-bundle-step-1-edit")).toBeNull()
  })

  it("previews every step of a 3-step sequence as it would read alone, refs as their steps", async () => {
    // The demo sales bundle: a CRM record, a quote citing it, and the reply that
    // attaches the quote's PDF and names its number. Nothing has run yet.
    const HEAD = "44444444-4444-4444-8444-444444444444"
    const QUOTE = "55555555-5555-4555-8555-555555555555"
    const REPLY = "66666666-6666-4666-8666-666666666666"
    const crm = head({
      id: HEAD,
      bundleId: HEAD,
      toolName: "api-connector:connector_write",
      summary: {
        kind: "api-connector.write",
        title: "Create contact in CRM: Inês Duarte",
        subtitle: "Writes to an external system",
        lines: ["POST crm.example/contacts", "name: Inês Duarte", "email: ines@example.org"],
      },
      currentPayload: {
        connection: "crm",
        operation: "create_contact",
        params: { name: "Inês Duarte", email: "ines@example.org" },
      },
    })
    const quote: any = {
      ...step2,
      id: QUOTE,
      handle: "request-5",
      bundleId: HEAD,
      bundlePosition: 1,
      dependsOnId: HEAD,
      toolName: "invoicing:quote_create_and_issue",
      // As the server stores it: the summarizer's tokens already read as their step.
      summary: {
        kind: "quote_create_and_issue",
        title: "Issue quote for Northwind Acoustics, 22 295,20 €",
        subtitle: "Creates a quote for Northwind Acoustics, with its next quote number",
        lines: [
          "Document: new quote (number assigned on issue)",
          "Customer: Northwind Acoustics",
          "Lines total: 22 295,20 € (before tax, tax added on issue)",
          "Line: Kestrel 6 x 40 @ 899,00 €, less 13 664,80 €",
          "Customer ref: [CRM record from step 1]",
          "Valid until: 2026-11-30",
        ],
      },
      currentPayload: {
        counterparty: { legal_name: "Northwind Acoustics", country: "PT" },
        customer_reference: `@ref:${HEAD}:record_id`,
        items: [
          {
            description: "Kestrel 6",
            quantity: 40,
            unit_price_minor: 89900,
            discount_minor: 1366480,
          },
        ],
      },
    }
    const reply: any = {
      ...step2,
      id: REPLY,
      handle: "request-6",
      bundleId: HEAD,
      bundlePosition: 2,
      dependsOnId: QUOTE,
      toolName: "mail:reply",
      summary: {
        kind: "mail.reply",
        title: "Re: 40 Kestrel 6 for our studios",
        subtitle: "Reply to Inês Duarte via sales@example.com",
        lines: [
          "To: ines@example.org",
          "📎 [quote PDF from step 2] (attached once that step has run)",
        ],
        links: [
          { label: "Open conversation", app: "mail", entityType: "conversation", entityId: "c-1" },
        ],
      },
      currentPayload: {
        conversationId: "c-1",
        attachments: [`@ref:${QUOTE}:pdf_file_id`],
        textBody: `Hello Inês,\n\nPlease find our quote @ref:${QUOTE}:number attached.`,
      },
    }
    apiMocks.get.mockResolvedValue([crm, quote, reply])
    handleWsCreate(crm, "u-approver")
    render(() => <ApprovalCard requestId={HEAD} />)

    // The bundle reads as its outcome, the head's own record as step 1 with its fields.
    const title = await screen.findByTestId("approval-card-title")
    await waitFor(() => expect(title).toHaveTextContent("Re: 40 Kestrel 6 for our studios"))
    expect(screen.getByTestId("approval-card-bundle-steps")).toHaveTextContent("3 steps")
    expect(screen.getByTestId("approval-card-head-step")).toHaveTextContent(
      "Step 1: Create contact in CRM: Inês Duarte",
    )
    expect(screen.getByText("name: Inês Duarte")).toBeTruthy()

    // The quote: customer, lines, discount, total, validity, the CRM record it cites.
    const quoteStep = await screen.findByTestId("approval-bundle-step-1")
    expect(screen.getByTestId("approval-bundle-step-1-subtitle")).toHaveTextContent(
      "Creates a quote for Northwind Acoustics",
    )
    const quoteLines = screen.getByTestId("approval-bundle-step-1-lines")
    expect(quoteLines).toHaveTextContent("Line: Kestrel 6 x 40 @ 899,00 €, less 13 664,80 €")
    expect(quoteLines).toHaveTextContent("Customer ref: [CRM record from step 1]")
    expect(quoteLines).toHaveTextContent("Valid until: 2026-11-30")
    // The exact payload names the record by the step that makes it.
    expect(screen.getByTestId("approval-bundle-step-1-payload")).toHaveTextContent(
      "the CRM record from step 1",
    )
    expect(quoteStep.textContent).not.toContain("@ref:")

    // The reply: who it reaches, the whole message, the attachment pending on step 2.
    const replyStep = await screen.findByTestId("approval-bundle-step-2")
    expect(screen.getByTestId("approval-bundle-step-2-subtitle")).toHaveTextContent(
      "Reply to Inês Duarte via sales@example.com",
    )
    expect(screen.getByTestId("approval-bundle-step-2-lines")).toHaveTextContent(
      "📎 [quote PDF from step 2] (attached once that step has run)",
    )
    expect(screen.getByTestId("approval-bundle-step-2-message-body")).toHaveTextContent(
      "Please find our quote [quote number from step 2] attached.",
    )
    expect(screen.getByTestId("approval-bundle-step-2-links")).toHaveTextContent(
      "Open conversation",
    )
    expect(screen.getByTestId("approval-bundle-step-2-payload")).toHaveTextContent(
      "the quote PDF from step 2",
    )
    expect(replyStep.textContent).not.toContain("@ref:")
  })

  // A reply from an end-to-end encrypted personal mailbox: its draft is sealed to
  // the owner, so the head's row lists no key material, offers no inline edit,
  // and once the step waits on its own it is decided on its own card (which
  // opens the draft and supplies it with the approval).
  const sealedReply = (status: string): any => ({
    ...step2,
    id: "44444444-4444-4444-8444-444444444444",
    status,
    toolName: "mail:reply",
    dependsOnId: "11111111-1111-4111-8111-111111111111",
    summary: { kind: "mail.reply", title: "Reply to customer", lines: [] },
    editableFields: [{ field: "textBody", label: "Message", widget: "richtext" }],
    currentPayload: {
      conversationId: "c-1",
      attachments: ["@ref:11111111-1111-4111-8111-111111111111:pdf_file_id"],
      mailboxSealed: true,
      bodyCiphertext: "CIPHERTEXTNONCE",
      subjectCiphertext: "CIPHERTEXTNONCE",
      contentKeyWrapped: "KEYNONCE",
      contentKeyEpk: "KEYNONCE",
      encKeyId: 3,
      encVersion: 1,
    },
  })
  const serveSealedBundle = (reply: any) =>
    apiMocks.get.mockImplementation(async (url: string) => {
      if (url.includes("bundleId=")) return [head(), reply]
      if (url.includes(reply.id)) return reply
      return head()
    })

  it("lists a deferred sealed reply without its key material or an inline edit", async () => {
    const reply = sealedReply("deferred")
    serveSealedBundle(reply)
    handleWsCreate(head(), "u-approver")
    render(() => <ApprovalCard requestId="11111111-1111-4111-8111-111111111111" />)

    const row = await screen.findByTestId("approval-bundle-step-1")
    expect(row.textContent).not.toContain("CIPHERTEXTNONCE")
    expect(row.textContent).not.toContain("KEYNONCE")
    expect(screen.getByTestId("approval-bundle-step-1-runs-hint")).toHaveTextContent(
      /encrypted mailbox/i,
    )
    expect(screen.queryByTestId("approval-bundle-step-1-edit")).toBeNull()
  })

  it("decides a waiting sealed reply on its own card, not with the plain step Approve", async () => {
    const reply = sealedReply("pending")
    serveSealedBundle(reply)
    handleWsCreate(head({ status: "approved" }), "u-approver")
    render(() => <ApprovalCard requestId="11111111-1111-4111-8111-111111111111" />)

    expect(await screen.findByTestId("approval-bundle-step-1-own-card")).toBeTruthy()
    expect(screen.queryByTestId("approval-bundle-step-1-approve")).toBeNull()
  })

  it("renders a non-bundle approval unchanged — no bundle step block", async () => {
    handleWsCreate(head({ bundleId: null, bundlePosition: null }), "u-approver")
    render(() => <ApprovalCard requestId="11111111-1111-4111-8111-111111111111" />)

    expect(await screen.findByTestId("approval-card-title")).toHaveTextContent(
      "Create return label",
    )
    expect(screen.queryByTestId("approval-bundle-steps")).toBeNull()
  })
})
