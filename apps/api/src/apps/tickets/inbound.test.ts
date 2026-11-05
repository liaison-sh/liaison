// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  extractTokens,
  inboundDropCountsByReason,
  processInboundMessage,
  resolveSyncedDirection,
  type TicketsServiceCtx,
} from "./inbound"

const selfInbox = { id: "inbox-1", org_id: "org-1", email_address: "support@fabrikam.example" }

const sent = { receivedVia: "gmail_api" as const, labelIds: ["SENT"] }
const gmailPass = (domain: string) => ({
  receivedVia: "gmail_api" as const,
  authenticationResults: [`mx.google.com; dmarc=pass (p=REJECT) header.from=${domain}`],
})

describe("resolveSyncedDirection", () => {
  it("classifies our own Sent copy (provider SENT label) as OUTBOUND", () => {
    expect(
      resolveSyncedDirection({ from: { email: "support@fabrikam.example" }, ...sent }, selfInbox),
    ).toBe("outbound")
  })

  it("is case-insensitive and trims the From address", () => {
    expect(
      resolveSyncedDirection(
        { from: { email: "  SUPPORT@Fabrikam.example " }, ...gmailPass("fabrikam.example") },
        selfInbox,
      ),
    ).toBe("outbound")
  })

  it("classifies a customer message as INBOUND", () => {
    expect(resolveSyncedDirection({ from: { email: "alice@cust.test" } }, selfInbox)).toBe(
      "inbound",
    )
  })

  it("treats an AUTHENTICATED address on the mailbox's own domain as OUTBOUND (a colleague)", () => {
    expect(
      resolveSyncedDirection(
        { from: { email: "alex@fabrikam.example" }, ...gmailPass("fabrikam.example") },
        selfInbox,
      ),
    ).toBe("outbound")
  })

  it("treats an UNAUTHENTICATED From on our own domain (or our own address) as INBOUND", () => {
    // The From header is whatever the sender typed: without the SENT label or a
    // provider pass it grants no staff authority.
    expect(resolveSyncedDirection({ from: { email: "alex@fabrikam.example" } }, selfInbox)).toBe(
      "inbound",
    )
    expect(resolveSyncedDirection({ from: { email: "support@fabrikam.example" } }, selfInbox)).toBe(
      "inbound",
    )
    expect(
      resolveSyncedDirection(
        {
          from: { email: "support@fabrikam.example" },
          receivedVia: "gmail_api",
          authenticationResults: ["mx.google.com; dmarc=fail header.from=fabrikam.example"],
        },
        selfInbox,
      ),
    ).toBe("inbound")
  })

  it("for a PUBLIC-provider mailbox, falls back to exact-address match (customers share the domain)", () => {
    // support@gmail.com shares gmail.com with every customer — the domain says
    // nothing, so only the exact mailbox address is self.
    const gmailInbox = { id: "i2", org_id: "org-1", email_address: "acme.support@gmail.com" }
    expect(
      resolveSyncedDirection({ from: { email: "acme.support@gmail.com" }, ...sent }, gmailInbox),
    ).toBe("outbound")
    expect(
      resolveSyncedDirection(
        { from: { email: "some.customer@gmail.com" }, ...gmailPass("gmail.com") },
        gmailInbox,
      ),
    ).toBe("inbound")
  })

  it("falls back to inbound when From is missing", () => {
    expect(resolveSyncedDirection({}, selfInbox)).toBe("inbound")
  })

  describe("a From on one of the org's configured mail domains", () => {
    const orgDomains = ["fabrikam-group.example"]
    const colleague = { email: "alex@fabrikam-group.example" }

    it("is staff when the provider's trusted verdict passes for that domain", () => {
      expect(
        resolveSyncedDirection(
          { from: colleague, ...gmailPass("fabrikam-group.example") },
          selfInbox,
          orgDomains,
        ),
      ).toBe("outbound")
    })

    it("is staff when it came through the Gmail API mailbox with the SENT label", () => {
      expect(resolveSyncedDirection({ from: colleague, ...sent }, selfInbox, orgDomains)).toBe(
        "outbound",
      )
    })

    it("stays a customer message when unverified", () => {
      expect(resolveSyncedDirection({ from: colleague }, selfInbox, orgDomains)).toBe("inbound")
    })

    it("is not staff on a SENT label that did not come from the Gmail API", () => {
      expect(
        resolveSyncedDirection(
          { from: colleague, receivedVia: "imap", labelIds: ["SENT"] },
          selfInbox,
          orgDomains,
        ),
      ).toBe("inbound")
    })

    it("reads only the topmost trusted verdict, never a sender-written one", () => {
      // A look-alike pass BELOW the provider's own header proves nothing.
      expect(
        resolveSyncedDirection(
          {
            from: colleague,
            receivedVia: "gmail_api",
            authenticationResults: [
              "mx.google.com; dmarc=none header.from=fabrikam-group.example",
              "mx.google.com; dmarc=pass (p=REJECT) header.from=fabrikam-group.example",
            ],
          },
          selfInbox,
          orgDomains,
        ),
      ).toBe("inbound")
      // Over IMAP with no configured authserv-id the topmost header may be the
      // sender's own, so even a pass there is not trusted.
      expect(
        resolveSyncedDirection(
          {
            from: colleague,
            receivedVia: "imap",
            authenticationResults: [
              "mx.google.com; dmarc=pass (p=REJECT) header.from=fabrikam-group.example",
            ],
          },
          selfInbox,
          orgDomains,
        ),
      ).toBe("inbound")
    })

    it("is a customer when the pass is for another domain than the From", () => {
      expect(
        resolveSyncedDirection(
          { from: colleague, ...gmailPass("attacker.example") },
          selfInbox,
          orgDomains,
        ),
      ).toBe("inbound")
    })

    it("never counts a public provider's domain as the org's own", () => {
      expect(
        resolveSyncedDirection(
          { from: { email: "someone@gmail.com" }, ...gmailPass("gmail.com") },
          selfInbox,
          ["gmail.com"],
        ),
      ).toBe("inbound")
    })
  })
})

function fakeCtx(): TicketsServiceCtx {
  return {
    db: {
      execute: async () => ({ rows: [] }) as never,
      queueEvent: async () => {},
    } as never,
    orgId: "00000000-0000-0000-0000-000000000001",
  }
}

describe("processInboundMessage — auto-responder gate", () => {
  it("drops on Auto-Submitted: auto-replied", async () => {
    const ctx = fakeCtx()
    const r = await processInboundMessage(
      {
        messageId: "<m1@x.test>",
        from: { email: "a@x.test" },
        to: [{ email: "support@x.test" }],
        headers: { "auto-submitted": "auto-replied" },
      },
      {
        id: "inbox-1",
        org_id: ctx.orgId,
        email_address: "support@x.test",
      },
      ctx,
    )
    expect(r).toEqual({ outcome: "dropped", reason: "auto_responder" })
  })

  it("counts every automatic drop by reason, so a silently dropped sender is visible", async () => {
    const before = inboundDropCountsByReason().auto_responder ?? 0
    const ctx = fakeCtx()
    await processInboundMessage(
      {
        messageId: "<m-count@x.test>",
        from: { email: "a@x.test" },
        headers: { "auto-submitted": "auto-replied" },
      },
      { id: "inbox-1", org_id: ctx.orgId, email_address: "support@x.test" },
      ctx,
    )
    expect(inboundDropCountsByReason().auto_responder).toBe(before + 1)
  })

  it("drops on precedence: bulk", async () => {
    const ctx = fakeCtx()
    const r = await processInboundMessage(
      {
        messageId: "<m2@x.test>",
        from: { email: "a@x.test" },
        to: [{ email: "support@x.test" }],
        headers: { precedence: "bulk" },
      },
      { id: "inbox-1", org_id: ctx.orgId, email_address: "support@x.test" },
      ctx,
    )
    expect(r).toEqual({ outcome: "dropped", reason: "auto_responder" })
  })

  it("does not drop on benign headers", async () => {
    // We can't fully exercise without DB; just confirm gate doesn't fire.
    // Replace ctx.db.execute with a thrower to detect "didn't drop".
    let executed = 0
    const ctx: TicketsServiceCtx = {
      db: {
        execute: async () => {
          executed += 1
          throw new Error("DB called")
        },
        transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
          executed += 1
          return fn({
            execute: async () => {
              executed += 1
              throw new Error("DB called")
            },
            queueEvent: async () => {},
          })
        },
        queueEvent: async () => {},
      } as never,
      orgId: "00000000-0000-0000-0000-000000000002",
    }
    try {
      await processInboundMessage(
        {
          messageId: "<m3@x.test>",
          from: { email: "alice@cust.test" },
          to: [{ email: "support@x.test" }],
          headers: { "reply-to": "noreply@x.test" },
        },
        { id: "inbox-1", org_id: ctx.orgId, email_address: "support@x.test" },
        ctx,
      )
    } catch {
      // Will throw because we mocked DB to throw — but importantly, gate didn't drop pre-DB.
    }
    expect(executed).toBeGreaterThan(0)
  })
})

describe("extractTokens", () => {
  it("matches the minted upper-case token whatever case the address arrives in", () => {
    // Minted as base32 upper case; a client that lower-cases the address must
    // still thread by the reply token (the strong key), not fall to weaker ones.
    expect(extractTokens(["Support+TKT_ABC234@x.test"])).toContain("ABC234")
    expect(extractTokens(["support+tkt_abc234@x.test"])).toContain("ABC234")
    expect(extractTokens(["support@x.test"])).toEqual([])
  })
})
