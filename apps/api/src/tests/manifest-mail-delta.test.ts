// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const MAIL_MANIFEST_PATH = path.join(import.meta.dir, "..", "apps", "mail", "app.manifest.json")
const mf = JSON.parse(readFileSync(MAIL_MANIFEST_PATH, "utf8"))

describe("Mail manifest mail-tickets conversion delta", () => {
  it("declares cross-app tool dependencies", () => {
    expect(mf.dependencies?.tools).toEqual(
      expect.arrayContaining([
        "tickets:createFromMail",
        "tickets:deleteIfUnreferenced",
        "tickets:pullMailReply",
      ]),
    )
  })

  it("declares optional dependency on tickets for graceful conversion availability", () => {
    expect(mf.dependencies?.optional).toEqual(expect.arrayContaining(["tickets"]))
    expect(mf.dependencies?.required ?? []).not.toContain("tickets")
  })

  it("conversation status enum includes 'open', 'trashed', 'escalated'", () => {
    const status = mf.schema.conversations.fields.status
    expect(typeof status).toBe("object")
    expect(status.type).toBe("string")
    expect(status.enum).toEqual(expect.arrayContaining(["open", "trashed", "escalated"]))
  })

  it("conversation has nullable escalatedTicketId FK to tickets.tickets", () => {
    const f = mf.schema.conversations.fields.escalatedTicketId
    expect(f).toEqual({
      type: "uuid",
      required: false,
      references: {
        schema: "app_tickets",
        table: "tickets",
        column: "id",
        onDelete: "set null",
      },
    })
  })

  it("messages externalMessageId / externalProviderId are nullable", () => {
    for (const name of ["externalMessageId", "externalProviderId"]) {
      const f = mf.schema.messages.fields[name]
      if (typeof f === "string") {
        expect(f).toBe("string?")
      } else {
        expect(f).toMatchObject({ type: "string", required: false })
      }
    }
  })

  it("declares convertToTicket / createFromTicket / appendInboundMessage tools", () => {
    // A tool's scopes live in `requiredScopes` (refactor 90aacaec7); this test
    // still read the retired `scope` key and failed on main.
    expect(mf.tools.convertToTicket).toMatchObject({
      requiredScopes: ["mail:conversations:write"],
      trustBoundary: "user",
    })
    // BL-66: createFromTicket only READS the account and WRITES a conversation
    // (INSERT INTO conversations), so its scope is mail:conversations:write — the
    // same entity-write scope as its sibling appendInboundMessage and as the
    // symmetric forward tool tickets:createFromMail (tickets:tickets:write). It was
    // mis-scoped mail:accounts:write, which made tickets:convertToMail unusable by
    // support personas (they hold conversations:write but not accounts:write) →
    // the convert-misrouted-ticket-back-to-mail de-escalation was denied.
    expect(mf.tools.createFromTicket).toMatchObject({
      requiredScopes: ["mail:conversations:write"],
      trustBoundary: "internal",
      deferLoading: true,
    })
    expect(mf.tools.appendInboundMessage).toMatchObject({
      requiredScopes: ["mail:conversations:write"],
      trustBoundary: "internal",
      deferLoading: true,
    })
  })

  it("declares conversation:converted event emit", () => {
    expect(mf.events?.emits).toEqual(expect.arrayContaining(["conversation:converted"]))
  })
})

// ---------------------------------------------------------------------------
// Task 4.1. The additive ciphertext delta plus `encryption_state`.
//
// Read from the raw JSON on purpose: the manifest IS the delivery mechanism for
// this schema change (mail is an in-tree app, the schema hash recomputes and the
// ALTER path runs at registration), so what the file says is what ships.
// ---------------------------------------------------------------------------

const CIPHERTEXT_FIELDS: Record<string, string[]> = {
  messages: [
    "textBodyCiphertext",
    "htmlBodyCiphertext",
    "subjectCiphertext",
    "snippetCiphertext",
    "rawHeadersCiphertext",
    "contentKeyWrapped",
    "contentKeyEpk",
  ],
  conversations: ["subjectCiphertext", "snippetCiphertext", "contentKeyWrapped", "contentKeyEpk"],
  drafts: ["bodyCiphertext", "subjectCiphertext", "contentKeyWrapped", "contentKeyEpk"],
}

describe("Mail manifest encryption delta", () => {
  it("is at 1.1.0 or later, which is the whole delivery mechanism", () => {
    // The bound is a FLOOR, not an equality. A manifest delta ships only
    // because the version moved, and later phases add fields of their own
    // (Phase 5 added `conversations.snippetSourceMessageId` at 1.2.0). Pinning
    // equality would force every such phase to choose between shipping its
    // schema and keeping this test, which is the wrong trade. A rollback below
    // 1.1.0, the failure this test exists to catch, still fails here.
    const [major, minor] = mf.version.split(".").map(Number)
    expect(major).toBeGreaterThanOrEqual(1)
    expect(major > 1 || (minor as number) >= 1, `mail manifest version ${mf.version}`).toBe(true)
  })

  it("declares every ciphertext column as nullable bytea", () => {
    let checked = 0
    for (const [entity, fields] of Object.entries(CIPHERTEXT_FIELDS)) {
      for (const name of fields) {
        expect(mf.schema[entity].fields[name], `${entity}.${name}`).toBe("bytea?")
        checked++
      }
    }
    // Non-vacuity: a typo'd entity name would otherwise check nothing at all.
    expect(checked).toBe(15)
  })

  it("declares the key id, the version and the purge marker", () => {
    for (const entity of ["messages", "conversations", "drafts"]) {
      expect(mf.schema[entity].fields.encKeyId).toBe("smallint?")
      expect(mf.schema[entity].fields.encVersion).toEqual({ type: "smallint", default: 0 })
    }
    expect(mf.schema.messages.fields.plaintextPurgedAt).toBe("date?")
  })

  it("declares encryption_state on accounts with the five spec states plus managed", () => {
    // `managed` is the server-managed (transparent) mode; `ready` stays the
    // zero-access (private) mode.
    expect(mf.schema.accounts.fields.encryptionState).toEqual({
      type: "string",
      default: "none",
      enum: ["none", "pending_enrollment", "ready", "blocked", "paused", "managed"],
    })
  })

  it("keeps every legacy plaintext column declared", () => {
    // The plaintext columns are NULLed per user at purge and dropped in a
    // separate later migration after the cool-down. Dropping them here would
    // destroy every not-yet-migrated mailbox.
    for (const name of ["subject", "textBody", "htmlBody", "snippet", "rawHeaders"]) {
      expect(mf.schema.messages.fields[name], `messages.${name}`).toBeDefined()
    }
    for (const name of ["subject", "snippet"]) {
      expect(mf.schema.conversations.fields[name], `conversations.${name}`).toBeDefined()
    }
  })

  it("makes the three draft plaintext columns nullable", () => {
    // They shipped `NOT NULL DEFAULT ''`. A sealed draft has no plaintext to
    // store, the Invariant P trigger must be able to see absence, and the purge
    // writes NULL. Migration 0035 does the physical work; this keeps the
    // manifest from reporting drift forever after.
    for (const name of ["subject", "htmlBody", "textBody"]) {
      expect(mf.schema.drafts.fields[name], `drafts.${name}`).toBe("string?")
    }
  })

  it("declares the Invariant P trigger on all three content tables", () => {
    for (const entity of ["messages", "conversations", "drafts"]) {
      const trigger = mf.schema[entity].triggers?.enforce_mailbox_plaintext_invariant
      expect(trigger, `${entity} carries no invariant trigger`).toBeDefined()
      expect(trigger.timing).toBe("BEFORE")
      expect(trigger.event).toEqual(["INSERT", "UPDATE"])
      expect(trigger.level).toBe("ROW")
      expect(trigger.language).toBe("plpgsql")
      // The DDL generator rejects any body carrying a dollar-quote tag, so the
      // body has to reach the same effect with format() + USING.
      expect(trigger.body).not.toMatch(/\$[A-Za-z0-9_]*\$/)
      // Arming goes through the SECURITY DEFINER helper, never an inline select
      // (which would fail OPEN under RLS), and never `encryption_state` (which
      // one row update could flip).
      expect(trigger.body).toContain("mailbox_invariant_armed")
      expect(trigger.body).toContain("mailbox_account_exists")
      expect(trigger.body).toContain("mailbox_account_unresolved")
      expect(trigger.body).not.toContain("encryption_state")
      // The predicate must be distinctness-aware on UPDATE, or every markRead on
      // a not-yet-backfilled row would raise and brick the mailbox.
      expect(trigger.body).toContain("IS DISTINCT FROM ")
      expect(trigger.body).toContain("OLD.")
    }
  })

  it("the messages trigger carries the section 5.2 header allowlist in full", () => {
    const body = mf.schema.messages.triggers.enforce_mailbox_plaintext_invariant.body
    const allowlist = [
      "message-id",
      "in-reply-to",
      "references",
      "date",
      "from",
      "to",
      "cc",
      "bcc",
      "return-path",
      "delivered-to",
      "content-type",
      "content-transfer-encoding",
      "list-unsubscribe",
      "list-id",
      "auto-submitted",
      "precedence",
    ]
    for (const header of allowlist) {
      expect(body, `allowlist is missing ${header}`).toContain(`'${header}'`)
    }
    expect(body).toContain("mailbox_headers_forbidden")
    // `subject` is content and must never be allowlisted back in.
    expect(body).not.toContain("'subject'")
  })

  it("the drafts trigger treats an empty string as absence", () => {
    // Existing draft rows keep '' after the NOT NULL is dropped, so a blank
    // draft field is not a violation.
    const body = mf.schema.drafts.triggers.enforce_mailbox_plaintext_invariant.body
    expect(body).toContain("NULLIF(NEW.subject, '')")
    expect(body).toContain("NULLIF(NEW.html_body, '')")
    expect(body).toContain("NULLIF(NEW.text_body, '')")
  })

  it("removes subject from the conversations timeline", () => {
    expect(mf.schema.conversations.timeline).not.toContain("subject")
    // Non-vacuity: the array is still there and still carries its other fields.
    expect(mf.schema.conversations.timeline).toContain("status")
  })
})
