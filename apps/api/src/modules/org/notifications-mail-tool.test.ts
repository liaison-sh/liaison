// SPDX-License-Identifier: FSL-1.1-ALv2
// kernel:notifications_email_send: an app's customer mail through the org's notifications sender
// (its `email.from`), with files the caller can read, inline images and a Reply-To.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { type RlsClient, sql } from "~/db"
import { type EmailMessage, type EmailProvider, setEmailProvider } from "~/infra/email"
import { handleNotificationsEmailSend } from "~/modules/org/notifications-mail-tool"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

class CaptureProvider implements EmailProvider {
  sent: EmailMessage[] = []
  async send(m: EmailMessage): Promise<void> {
    this.sent.push(m)
  }
  async verify(): Promise<boolean> {
    return true
  }
}

const PDF = "11111111-1111-4111-8111-111111111111"
const LOGO = "22222222-2222-4222-8222-222222222222"
const files = [
  {
    id: PDF,
    filename: "INV-1.pdf",
    mimeType: "application/pdf",
    sizeBytes: 4,
    storageKey: "k/pdf",
  },
  { id: LOGO, filename: "logo.png", mimeType: "image/png", sizeBytes: 3, storageKey: "k/logo" },
]
/** The caller's context: it sees the files listed (as its RLS context would), nothing else. */
function callerDb(visible: typeof files): RlsClient {
  return { execute: async () => visible } as unknown as RlsClient
}
const bytes = async (key: string) => new TextEncoder().encode(key === "k/pdf" ? "%PDF" : "png")

async function orgWithEmail(email?: { from?: string; replyTo?: string }): Promise<string> {
  const { orgId } = await ensureOrg({
    slug: `notif-mail-${crypto.randomUUID().slice(0, 12)}`,
    name: "NotifMailOrg",
  })
  if (email) {
    await sql`UPDATE kernel.organizations
      SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('email', ${JSON.stringify(email)}::jsonb)
      WHERE id = ${orgId}::uuid`
  }
  return orgId
}

let provider: CaptureProvider

describe("kernel:notifications_email_send", () => {
  test("sends from the org's email.from, HTML with the inline logo, the PDF attached, Reply-To the caller's", async () => {
    provider = new CaptureProvider()
    setEmailProvider(provider)
    const orgId = await orgWithEmail({ from: "Shop <notifications@shop.example>" })
    const r = await handleNotificationsEmailSend(
      {
        to: "buyer@example.com",
        subject: "Thank you",
        textBody: "Thanks",
        htmlBody: '<img src="cid:issuer-logo">',
        replyTo: "hello@issuer.example",
        attachments: [PDF],
        inlineImages: [{ fileId: LOGO, contentId: "issuer-logo" }],
      },
      { orgId, db: callerDb(files) },
      { getObjectBuffer: bytes },
    )
    expect(r).toMatchObject({ sent: true, from: "Shop <notifications@shop.example>" })
    expect(provider.sent).toHaveLength(1)
    const m = provider.sent[0]!
    expect(m.from).toBe("Shop <notifications@shop.example>")
    expect(m.replyTo).toBe("hello@issuer.example")
    expect(m.html).toContain("cid:issuer-logo")
    expect(m.attachments?.map((a) => [a.filename, a.contentId ?? null])).toEqual([
      ["INV-1.pdf", null],
      ["logo.png", "issuer-logo"],
    ])
  })

  test("no Reply-To from the caller: the org's email.replyTo, else none", async () => {
    provider = new CaptureProvider()
    setEmailProvider(provider)
    const withReply = await orgWithEmail({ replyTo: "support@shop.example" })
    await handleNotificationsEmailSend(
      { to: "buyer@example.com", subject: "s", textBody: "t" },
      { orgId: withReply, db: callerDb([]) },
    )
    expect(provider.sent[0]?.replyTo).toBe("support@shop.example")
    const bare = await orgWithEmail()
    await handleNotificationsEmailSend(
      { to: "buyer@example.com", subject: "s", textBody: "t <b>" },
      { orgId: bare, db: callerDb([]) },
    )
    expect(provider.sent[1]?.replyTo).toBeUndefined()
    // A text-only mail still has an HTML part, escaped.
    expect(provider.sent[1]?.html).toContain("t &lt;b&gt;")
  })

  test("a file the caller cannot read refuses the mail, nothing is sent", async () => {
    provider = new CaptureProvider()
    setEmailProvider(provider)
    const orgId = await orgWithEmail()
    const r = await handleNotificationsEmailSend(
      { to: "buyer@example.com", subject: "s", textBody: "t", attachments: [PDF, LOGO] },
      { orgId, db: callerDb([files[0]!]) },
      { getObjectBuffer: bytes },
    )
    expect(r).toMatchObject({ error: { code: "file_not_found" } })
    expect(provider.sent).toHaveLength(0)
  })

  test("the same key sends once", async () => {
    provider = new CaptureProvider()
    setEmailProvider(provider)
    const orgId = await orgWithEmail()
    const p = { to: "buyer@example.com", subject: "s", textBody: "t", idempotencyKey: "sale-1" }
    await handleNotificationsEmailSend(p, { orgId, db: callerDb([]) })
    await handleNotificationsEmailSend(p, { orgId, db: callerDb([]) })
    expect(provider.sent).toHaveLength(1)
  })
})
