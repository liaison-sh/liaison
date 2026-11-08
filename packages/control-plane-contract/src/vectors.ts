// SPDX-License-Identifier: FSL-1.1-ALv2
// Frozen examples of the control plane contract. The instance's tests and the
// control plane's tests both parse these, so a schema change that breaks one
// side breaks the other. The signing triples were generated once with
// `node:crypto` and are literals on purpose: never regenerate them to make a
// test pass, a mismatch means the derivation or the signature changed.
//
// No imports: `index.ts` re-exports this file into the sandbox bundle.

const INSTANCE_ID = "fd175506-ef5b-42ad-9b36-262f7354495d"
const MESSAGE_ID = "b4469ef5-b66b-43b8-a9ba-7990cad8c03a"
const REPORT_MESSAGE_ID = "3bcd4ed7-b4b0-42ff-8e84-6fa45e33d499"
const LEAD_ID = "38c8fe1c-dc7d-4aaa-a4c0-0147faeed7f4"
const TS = "2026-11-02T00:00:00.000Z"
/** sha256 of the 5 bytes "hello". */
const HELLO_SHA256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"

function envelope<T extends string, D>(type: T, data: D) {
  return { v: 1, type, messageId: MESSAGE_ID, instanceId: INSTANCE_ID, ts: TS, data }
}

const bugReportData = {
  version: "1.4.0",
  edition: "self_hosted",
  report: {
    description: "The inbox list stays empty after a reload on <instance>.",
    page: "/tickets?view",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    logs: ["[warn] ws reconnect 1", "[error] GET /api/tickets 500"],
    logsTruncated: false,
    attachments: [
      {
        index: 0,
        filename: "screen.png",
        mimeType: "image/png",
        sizeBytes: 5,
        sha256: HELLO_SHA256,
      },
    ],
  },
  reporter: { email: "reporter@example.com" },
}

export const contractVectors = {
  /** One valid envelope per message type. */
  valid: {
    register: envelope("register", {
      version: "1.4.0",
      edition: "self_hosted",
      activeUsers: 3,
      nonce: "bdlNE7hoLgw-eHKX_GJE19OHUWhN-BuTjLMebflbXoo",
    }),
    heartbeat: envelope("heartbeat", { version: "1.4.0", edition: "managed", activeUsers: 12 }),
    "bug-report": envelope("bug-report", bugReportData),
    "bug-report-attachment": envelope("bug-report-attachment", {
      reportMessageId: REPORT_MESSAGE_ID,
      index: 0,
      filename: "screen.png",
      mimeType: "image/png",
      sizeBytes: 5,
      sha256: HELLO_SHA256,
      bytesBase64: "aGVsbG8=",
    }),
    lead: envelope("lead", {
      leadId: LEAD_ID,
      email: "visitor@example.com",
      name: "Ada Visitor",
      needs: ["support", "invoicing"],
      verified: false,
      notifyManaged: true,
      noticeVersion: "2026-10-16",
      signedUpAt: "2026-11-01T23:10:00.000Z",
    }),
    "lead-update": envelope("lead-update", { leadId: LEAD_ID, optedOut: true }),
    deregister: envelope("deregister", {}),
  },
  /** One invalid envelope per message type, with the issue path it must fail on. */
  invalid: {
    register: {
      message: envelope("register", { version: "1.4.0", edition: "self_hosted", activeUsers: 3 }),
      path: ["data", "nonce"],
    },
    heartbeat: {
      message: envelope("heartbeat", { version: "1.4.0", edition: "managed", activeUsers: -1 }),
      path: ["data", "activeUsers"],
    },
    "bug-report": {
      message: envelope("bug-report", {
        ...bugReportData,
        reporter: { name: "Ada", email: "a@example.com" },
      }),
      path: ["data", "reporter"],
    },
    "bug-report-attachment": {
      message: envelope("bug-report-attachment", {
        reportMessageId: REPORT_MESSAGE_ID,
        index: 0,
        filename: "screen.png",
        mimeType: "image/png",
        sizeBytes: 5,
        sha256: "not-a-digest",
        bytesBase64: "aGVsbG8=",
      }),
      path: ["data", "sha256"],
    },
    lead: {
      message: envelope("lead", {
        leadId: LEAD_ID,
        email: "not-an-email",
        name: "Ada Visitor",
        needs: [],
        verified: false,
        notifyManaged: false,
        noticeVersion: "2026-10-16",
        signedUpAt: "2026-11-01T23:10:00.000Z",
      }),
      path: ["data", "email"],
    },
    "lead-update": {
      message: envelope("lead-update", { leadId: "lead-1", optedOut: true }),
      path: ["data", "leadId"],
    },
    deregister: {
      message: { ...envelope("deregister", {}), v: 3 },
      path: ["v"],
    },
  },
  /** Reply bodies (the object under `{data: ...}`) for the success shapes. */
  replies: {
    registered: {
      type: "registered",
      instanceKey: "bdc9abb4dedf071522ec79947c800481744976593804deb1a000a1742e337892",
      contract: 1,
    },
    ack: { type: "ack", messageId: MESSAGE_ID },
    duplicate: { received: true, duplicate: true },
  },
  /** One 4xx body per rejection code, with the status a handler answers it with. */
  rejections: [
    { status: 400, body: { error: { message: "invalid_message" } } },
    { status: 403, body: { error: { message: "unknown_instance" } } },
    { status: 409, body: { error: { message: "already_registered" } } },
    { status: 403, body: { error: { message: "not_a_demo_instance" } } },
    { status: 409, body: { error: { message: "unknown_report" } } },
  ],
  /** 200 bodies a handler answers when it cannot act now. */
  retryLater: [{ type: "retry_later", reason: "over_quota", retryAfterSeconds: 3600 }],
  /**
   * `instanceKey = deriveInstanceKey(masterSecret, instanceId)` and
   * `signature = signBody(instanceKey, rawBody)`, byte for byte.
   */
  signing: [
    {
      masterSecret: "d4a3c179d8ef449a948a561f0d4cdf17557899df7a078f65bba8c3803fb923fe",
      instanceId: "560cf9d1-9bcc-4941-bb36-1f09d65125cb",
      instanceKey: "bdc9abb4dedf071522ec79947c800481744976593804deb1a000a1742e337892",
      rawBody:
        '{"data":{"activeUsers":7,"edition":"self_hosted","version":"1.4.0"},"instanceId":"560cf9d1-9bcc-4941-bb36-1f09d65125cb","messageId":"fde87a9b-50b4-48a6-82ee-0be8296f589a","ts":"2026-11-02T00:00:00.000Z","type":"heartbeat","v":1}',
      signature: "c7qDc1VR6gi6QUuxMEd8xVVN+qrfl0s/olrZK3Gegpo=",
    },
    {
      masterSecret: "8f9b262944a7584c061fff311cf98d4ff225abecdf42cb2c28229fcc2cb4a162",
      instanceId: "6893e558-6a6f-4aed-90e7-4bc82b47abaa",
      instanceKey: "a3a546870cf3be25cc3262ca470ba13b052fb2c0025acd01aba7ccdb948ef10b",
      rawBody:
        '{"data":{},"instanceId":"6893e558-6a6f-4aed-90e7-4bc82b47abaa","messageId":"e774df51-faf7-42d9-93b9-d3d6e4d63dcb","ts":"2026-11-02T00:01:00.000Z","type":"deregister","v":1}',
      signature: "76DCOLIiQ5sucnPLuANgkIdbOb7nxps+4iM0j/MbeGc=",
    },
    {
      masterSecret: "f880d1be5286f89727d74dea5bd3ca25c573b565c6c05f696eb79766a26d2006",
      instanceId: "4bd7f47d-1c84-4756-b044-a6e1d8627ea7",
      instanceKey: "1b4bf8c6f6c4498eabc3ca222b50ed4a4b11d46e9caf93585b5049c6a14acd71",
      rawBody:
        '{"data":{"activeUsers":1,"edition":"managed","nonce":"nHagztT7mvSr5fepKysTfwMq6AGzN9ZJjxwdkyVg8ao","version":"1.4.0"},"instanceId":"4bd7f47d-1c84-4756-b044-a6e1d8627ea7","messageId":"119705b0-e13d-4b75-88ae-8e167b1244ec","ts":"2026-11-02T00:02:00.000Z","type":"register","v":1}',
      signature: "UNO2XwjUxAcZ3rm6ySN0IN+CbJmlPnRfTI3hyT19kEM=",
    },
    {
      // Contract v2: a `cell-billing` message (envelope `v` 2), same instance-key signing.
      masterSecret: "d8ad534f318b9b5ecb412ea0d44e07d3988fa17e6317f71e39a5b6cdc90de36d",
      instanceId: "2abc7fa9-01ff-49ba-b320-ae0f187489d4",
      instanceKey: "c69940b4d291b8ed2cd06bd2ada249c93b62d99c6a74462f701838d7178dcd76",
      rawBody:
        '{"data":{"credits":25,"orgId":"7d1f3a52-9c4e-4b8a-8f61-2b0e5c9d4a17","requestId":"6b4321f7-3f27-4d8c-8b45-8847e67d8be7"},"instanceId":"2abc7fa9-01ff-49ba-b320-ae0f187489d4","messageId":"004cec7f-52d0-4cfe-8951-c3252019f5a6","ts":"2026-11-02T00:03:00.000Z","type":"billing.topup","v":2}',
      signature: "BnQ+uxuMHmVmRgwlPmT17Y5z909cNLYy2SMrn0XT5Xg=",
    },
  ],
} as const

// ── Contract v2 money messages (`./money.ts`) ───────────────────────────────
// Amounts, display strings and the rate below are arbitrary examples, not
// anyone's prices: real values come from Control's config at run time.

const CELL_INSTANCE_ID = "2abc7fa9-01ff-49ba-b320-ae0f187489d4"
const ORG_ID = "7d1f3a52-9c4e-4b8a-8f61-2b0e5c9d4a17"
const REQUEST_ID = "6b4321f7-3f27-4d8c-8b45-8847e67d8be7"
const INVOICE_ID = "in_test_a1b2c3"
const TRANSFER_ID = "0f6b2c1e-8d4a-4f3b-9a7e-5c2d1b0e9f83"

function cellMessage<T extends string, D>(type: T, data: D) {
  return {
    v: 2,
    type,
    messageId: MESSAGE_ID,
    instanceId: CELL_INSTANCE_ID,
    ts: TS,
    data: { requestId: REQUEST_ID, orgId: ORG_ID, ...data },
  }
}

const autoTopUp = { enabled: true, thresholdCredits: 15, amountCredits: 25 }
const previewCaps = {
  seats: 3,
  mailboxes: 2,
  storageGb: 5,
  jobsPerHour: 600,
  customApps: 2,
  auditDays: 45,
}
const BILLING_CONTACT = "billing@example.com"
const MAIL_DOMAIN = "mail.acme-audio.example"
const mailDomain = {
  id: "4dd369bc-aa82-4ff3-97de-514ae3000ee0",
  name: MAIL_DOMAIN,
  status: "pending",
  records: [
    {
      type: "MX",
      name: "send.mail",
      value: "feedback-smtp.example.net",
      priority: 10,
      ttl: "Auto",
    },
    { type: "TXT", name: "send.mail", value: "v=spf1 include:example.net ~all", ttl: "Auto" },
    {
      type: "TXT",
      name: "selector._domainkey.mail",
      value: "p=test-only-public-key",
      ttl: 3600,
    },
  ],
}
const usage = { seats: 4, storageBytes: 1_048_576, customApps: 0 }

export const moneyVectors = {
  cellBilling: {
    /** One valid envelope per cell-billing message type. */
    valid: {
      "billing.summary": cellMessage("billing.summary", {}),
      "billing.change_plan": cellMessage("billing.change_plan", { targetPlan: "pro", usage }),
      "billing.cancel": cellMessage("billing.cancel", {}),
      "billing.resume": cellMessage("billing.resume", {}),
      "billing.frame_session": cellMessage("billing.frame_session", {
        action: "confirm_invoice",
        invoiceId: INVOICE_ID,
      }),
      "billing.invoices": cellMessage("billing.invoices", {}),
      "billing.invoice_pdf": cellMessage("billing.invoice_pdf", { invoiceId: INVOICE_ID }),
      "billing.topup": cellMessage("billing.topup", { credits: 25 }),
      "billing.auto_topup_settings": cellMessage("billing.auto_topup_settings", autoTopUp),
      "billing.auto_topup_request": cellMessage("billing.auto_topup_request", {
        crossingId: "deduction:9f2c:15",
      }),
      "usage.report": cellMessage("usage.report", {
        day: "2026-11-01",
        rawCostUsd: "3.14159265",
        rows: 42,
      }),
      "apps.usage": cellMessage("apps.usage", {
        day: "2026-11-01",
        capsVersion: 2,
        rows: [
          {
            app: "shopify",
            executor: "workers",
            runs: 1200,
            bridgeCalls: 5400,
            wallMs: 98_000,
            cpuMs: 4100,
          },
          {
            app: "shopify",
            executor: "quickjs",
            runs: 3,
            bridgeCalls: 0,
            wallMs: 210,
            cpuMs: null,
          },
        ],
        computedAt: "2026-11-02T00:20:00.000Z",
      }),
      "storage.estimate": cellMessage("storage.estimate", {
        day: "2026-11-01",
        estimatedBytes: 12_884_901_888,
        capBytes: 10_737_418_240,
        over: true,
      }),
      "mail.domain_add": cellMessage("mail.domain_add", { domain: MAIL_DOMAIN }),
      "mail.domain_status": cellMessage("mail.domain_status", {}),
      "mail.domain_verify": cellMessage("mail.domain_verify", {}),
      "mail.domain_remove": cellMessage("mail.domain_remove", {}),
      "move.heartbeat": cellMessage("move.heartbeat", { transferId: TRANSFER_ID, phase: "frozen" }),
      "move.status": cellMessage("move.status", { transferId: TRANSFER_ID }),
    },
    /** One invalid envelope per type, with the issue path it must fail on. */
    invalid: {
      "billing.summary": {
        message: { ...cellMessage("billing.summary", {}), instanceId: "cell-1" },
        path: ["instanceId"],
      },
      "billing.change_plan": {
        message: cellMessage("billing.change_plan", {
          targetPlan: "pro",
          usage: { ...usage, seats: -1 },
        }),
        path: ["data", "usage", "seats"],
      },
      "billing.cancel": {
        message: cellMessage("billing.cancel", { requestId: "r-1" }),
        path: ["data", "requestId"],
      },
      "billing.resume": {
        message: cellMessage("billing.resume", { orgId: "acme" }),
        path: ["data", "orgId"],
      },
      "billing.frame_session": {
        message: cellMessage("billing.frame_session", { action: "topup" }),
        path: ["data", "credits"],
      },
      "billing.invoices": {
        message: { ...cellMessage("billing.invoices", {}), v: 1 },
        path: ["v"],
      },
      "billing.invoice_pdf": {
        message: cellMessage("billing.invoice_pdf", { invoiceId: "../etc/passwd" }),
        path: ["data", "invoiceId"],
      },
      "billing.topup": {
        message: cellMessage("billing.topup", { credits: 10.5 }),
        path: ["data", "credits"],
      },
      "billing.auto_topup_settings": {
        message: cellMessage("billing.auto_topup_settings", { ...autoTopUp, amountCredits: 0 }),
        path: ["data", "amountCredits"],
      },
      "billing.auto_topup_request": {
        message: cellMessage("billing.auto_topup_request", { crossingId: "" }),
        path: ["data", "crossingId"],
      },
      "usage.report": {
        message: cellMessage("usage.report", { day: "2026-11-01", rawCostUsd: "-1", rows: 1 }),
        path: ["data", "rawCostUsd"],
      },
      "apps.usage": {
        message: cellMessage("apps.usage", {
          day: "2026-11-01",
          capsVersion: 2,
          rows: [
            { app: "shopify", executor: "edge", runs: 1, bridgeCalls: 0, wallMs: 1, cpuMs: null },
          ],
        }),
        path: ["data", "rows", "0", "executor"],
      },
      "storage.estimate": {
        message: cellMessage("storage.estimate", {
          day: "2026-11-01",
          estimatedBytes: -1,
          capBytes: null,
          over: false,
        }),
        path: ["data", "estimatedBytes"],
      },
      "mail.domain_add": {
        message: cellMessage("mail.domain_add", { domain: "Mail.Example.COM" }),
        path: ["data", "domain"],
      },
      "mail.domain_status": {
        message: cellMessage("mail.domain_status", { domain: MAIL_DOMAIN }),
        path: ["data"],
      },
      "mail.domain_verify": {
        message: cellMessage("mail.domain_verify", { orgId: "acme" }),
        path: ["data", "orgId"],
      },
      "mail.domain_remove": {
        message: { ...cellMessage("mail.domain_remove", {}), v: 1 },
        path: ["v"],
      },
      "move.heartbeat": {
        message: cellMessage("move.heartbeat", { transferId: TRANSFER_ID, phase: "committed" }),
        path: ["data", "phase"],
      },
      "move.status": {
        message: cellMessage("move.status", { transferId: "transfer-1" }),
        path: ["data", "transferId"],
      },
    },
    /** Ok replies per type (the object under `{data: ...}`). */
    replies: {
      "billing.summary": [
        {
          ok: true,
          plan: "preview",
          status: "active",
          periodEnd: "2026-12-02T00:00:00.000Z",
          previewEndsAt: "2027-01-02T00:00:00.000Z",
          cancelAt: null,
          nextInvoice: { amountDisplay: "€1.23", date: "2026-12-02T00:00:00.000Z" },
          plans: [
            { id: "preview", priceDisplay: "€1.23", includedCredits: "40", caps: previewCaps },
            {
              id: "base",
              priceDisplay: "€4.56",
              includedCredits: "80",
              caps: { ...previewCaps, seats: null },
            },
          ],
          card: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 },
          topUp: { minCredits: 7, unitPriceCents: 123, currency: "EUR" },
          autoTopUp: {
            ...autoTopUp,
            lastFailure: { code: "card_declined", at: "2026-11-01T08:00:00.000Z" },
          },
          paymentAction: { invoiceId: INVOICE_ID, amountDisplay: "€1.23" },
          openInvoice: {
            invoiceId: INVOICE_ID,
            amountDisplay: "€1.23",
            dueAt: "2026-11-02T00:00:00.000Z",
          },
        },
      ],
      "billing.change_plan": [
        { ok: true, result: "changed", effectiveAt: "2026-11-02T10:00:00.000Z" },
        { ok: true, result: "scheduled", effectiveAt: "2026-12-02T00:00:00.000Z" },
        {
          ok: true,
          result: "requires_action",
          effectiveAt: "2026-11-02T10:00:00.000Z",
          invoiceId: INVOICE_ID,
        },
      ],
      "billing.cancel": [{ ok: true, cancelAt: "2026-12-02T00:00:00.000Z" }],
      "billing.resume": [{ ok: true }],
      "billing.frame_session": [
        {
          ok: true,
          token: "bdlNE7hoLgw-eHKX_GJE19OHUWhN-BuTjLMebflbXoo",
          expiresAt: "2026-11-02T00:08:00.000Z",
        },
      ],
      "billing.invoices": [
        {
          ok: true,
          invoices: [
            {
              id: INVOICE_ID,
              number: "TEST-0001",
              kind: "invoice",
              issuedAt: "2026-11-02T00:00:00.000Z",
              amountDisplay: "€1.23",
              status: "paid",
            },
            {
              id: "cn_test_d4e5",
              number: null,
              kind: "credit_note",
              issuedAt: "2026-11-03T00:00:00.000Z",
              amountDisplay: "-€1.23",
              status: "void",
            },
          ],
          hasMore: false,
        },
      ],
      "billing.invoice_pdf": [
        {
          ok: true,
          filename: "TEST-0001.pdf",
          contentType: "application/pdf",
          base64: "aGVsbG8=",
          sha256: HELLO_SHA256,
        },
      ],
      "billing.topup": [
        { ok: true, result: "paid", invoiceId: INVOICE_ID, credits: 25 },
        { ok: true, result: "requires_action", invoiceId: INVOICE_ID },
      ],
      "billing.auto_topup_settings": [{ ok: true, autoTopUp }],
      "billing.auto_topup_request": [{ ok: true, invoiceId: INVOICE_ID, credits: 25 }],
      "usage.report": [{ ok: true }],
      "apps.usage": [{ ok: true }],
      "storage.estimate": [{ ok: true }],
      "mail.domain_add": [{ ok: true, domain: mailDomain }],
      "mail.domain_status": [
        { ok: true, domain: { ...mailDomain, status: "verified" } },
        { ok: true, domain: null },
      ],
      "mail.domain_verify": [{ ok: true, domain: { ...mailDomain, status: "verified" } }],
      "mail.domain_remove": [{ ok: true }],
      "move.heartbeat": [
        { ok: true, state: "frozen", leaseUntil: "2026-11-01T09:00:15.000Z" },
        { ok: true, state: "aborted", leaseUntil: null },
      ],
      "move.status": [
        { ok: true, state: "committed", leaseUntil: null },
        { ok: true, state: "frozen", leaseUntil: "2026-11-01T09:00:15.000Z" },
      ],
    },
    /** One uniform error per documented code. */
    errors: [
      { ok: false, code: "billing_unavailable", retryAfterSeconds: 60 },
      { ok: false, code: "not_trusted" },
      { ok: false, code: "invalid_request" },
      { ok: false, code: "not_implemented" },
      { ok: false, code: "caps_exceeded", caps: ["seats", "mailboxes"] },
      { ok: false, code: "auto_topup_limited" },
      { ok: false, code: "pdf_too_large" },
      { ok: false, code: "not_found" },
      { ok: false, code: "no_card" },
      { ok: false, code: "below_minimum" },
      { ok: false, code: "payment_failed" },
      { ok: false, code: "authentication_required" },
      { ok: false, code: "same_plan" },
      { ok: false, code: "plan_not_offered" },
      { ok: false, code: "change_pending" },
      { ok: false, code: "no_subscription" },
      { ok: false, code: "rate_limited", retryAfterSeconds: 3600 },
      { ok: false, code: "payment_required" },
      { ok: false, code: "org_suspended" },
      { ok: false, code: "domain_limit" },
      { ok: false, code: "domain_invalid" },
      { ok: false, code: "domain_taken" },
    ],
  },
  /** Control→cell bodies (§3.4) with an invalid body and the replies. */
  controlToCell: {
    "billing push": {
      body: {
        orgId: ORG_ID,
        version: 3,
        plan: "preview",
        status: "active",
        periodEnd: "2026-12-02T00:00:00.000Z",
        includedCredits: "40",
        caps: previewCaps,
        nextPlan: { id: "base", caps: { ...previewCaps, seats: null } },
        previewEndsAt: "2027-01-02T00:00:00.000Z",
        autoTopUp,
        accessUntil: null,
        closedAt: null,
        billingContact: BILLING_CONTACT,
      },
      invalid: {
        body: {
          orgId: ORG_ID,
          version: 3,
          plan: "preview",
          status: "active",
          periodEnd: "2026-12-02",
          includedCredits: "40",
          caps: previewCaps,
          previewEndsAt: null,
          autoTopUp,
        },
        path: ["periodEnd"],
      },
      replies: [
        { ok: true, applied: true, version: 3 },
        { ok: true, applied: false, version: 4 },
      ],
    },
    /** The last push of a tenant closed for non-payment. */
    "billing push closed": {
      body: {
        orgId: ORG_ID,
        version: 9,
        plan: "base",
        status: "closed",
        periodEnd: "2026-12-02T00:00:00.000Z",
        includedCredits: "80",
        caps: previewCaps,
        previewEndsAt: null,
        autoTopUp: { enabled: false, thresholdCredits: 0, amountCredits: 25 },
        accessUntil: "2027-01-16T10:00:00.000Z",
        closedAt: "2027-01-16T10:00:00.000Z",
        billingContact: BILLING_CONTACT,
      },
      invalid: {
        body: {
          orgId: ORG_ID,
          version: 9,
          plan: "base",
          status: "deleted",
          periodEnd: "2026-12-02T00:00:00.000Z",
          includedCredits: "80",
          caps: previewCaps,
          previewEndsAt: null,
          autoTopUp: { enabled: false, thresholdCredits: 0, amountCredits: 25 },
          accessUntil: null,
          closedAt: "2027-01-16T10:00:00.000Z",
          billingContact: BILLING_CONTACT,
        },
        path: ["status"],
      },
      replies: [{ ok: true, applied: true, version: 9 }],
    },
    "credit grant": {
      body: { orgId: ORG_ID, grantId: INVOICE_ID, credits: "25", kind: "topup" },
      invalid: {
        body: { orgId: ORG_ID, grantId: INVOICE_ID, credits: 25, kind: "topup" },
        path: ["credits"],
      },
      replies: [{ ok: true, grantId: INVOICE_ID }],
    },
    "credit rate": {
      body: { rate: "1.75", unitPrices: { webCall: "0.04", dictationMinute: "0.3" }, version: 2 },
      invalid: {
        body: { rate: "1.75", unitPrices: { webCall: "0.04", dictationMinute: "0.3" }, version: 0 },
        path: ["version"],
      },
      replies: [{ ok: true, applied: true, version: 2 }],
    },
    lookup: {
      body: { email: "owner@example.com" },
      invalid: { body: { email: "owner" }, path: ["email"] },
      replies: [
        { ok: true, orgs: [{ slug: "acme-audio", name: "Acme Audio" }] },
        { ok: true, orgs: [] },
      ],
    },
    /** `DELETE /api/cloud/orgs/:id`: one reply per state, one error per refusal. */
    "delete org": {
      body: { orgId: ORG_ID, timerId: "delete:7d1f3a52" },
      invalid: { body: { orgId: ORG_ID, timerId: "" }, path: ["timerId"] },
      replies: [
        { ok: true, state: "queued" },
        { ok: true, state: "running" },
        { ok: true, state: "done" },
        { ok: true, state: "failed" },
      ],
      errors: [
        { ok: false, code: "not_closed" },
        { ok: false, code: "closed_too_recently" },
        { ok: false, code: "operator_org" },
        { ok: false, code: "export_running" },
      ],
    },
    /** `PUT /api/cloud/orgs/:id/mail-sender`. The key is a placeholder, not a real key. */
    "mail sender": {
      body: {
        orgId: ORG_ID,
        version: 2,
        sender: {
          domain: MAIL_DOMAIN,
          fromAddress: "support@mail.acme-audio.example",
          key: "test-sending-key-placeholder",
        },
      },
      invalid: {
        body: {
          orgId: ORG_ID,
          version: 2,
          sender: {
            domain: "https://mail.acme-audio.example",
            fromAddress: "x@y.example",
            key: "k",
          },
        },
        path: ["sender", "domain"],
      },
      replies: [
        { ok: true, applied: true, version: 2 },
        { ok: true, applied: false, version: 3 },
      ],
    },
  },
  /** The managed `GET /api/billing/state` reply. */
  managedBillingState: {
    mode: "managed",
    plan: "base",
    tier: "team",
    status: "past_due",
    periodEnd: "2026-12-02T00:00:00.000Z",
    includedCredits: "80",
    previewEndsAt: null,
    autoTopUp: { enabled: false, thresholdCredits: 0, amountCredits: 25 },
    accessUntil: null,
    billingContact: BILLING_CONTACT,
  },
} as const
