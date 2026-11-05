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
      message: { ...envelope("deregister", {}), v: 2 },
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
  ],
} as const
