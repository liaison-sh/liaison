// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task 4.2e. The sandbox db bridge's copy of Invariant P.
//
// This layer is the readable-error layer, not the enforcement layer: the
// database trigger is what a bundle rollback cannot undo, and T-SEC-10
// (`tests/security/b18-mailbox-plaintext-invariant.test.ts`) is what proves it.
// What is asserted here is that the bridge agrees with the trigger, and that it
// is actually wired into both write paths.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import {
  GUARDED_PLAINTEXT_FIELDS,
  guardedColumnName,
  isMailboxGuardedEntity,
  MailboxPlaintextForbiddenError,
  suppliedPlaintextFields,
} from "~/modules/mailbox-crypto/plaintext-guard"

describe("mailbox plaintext guard predicate", () => {
  it("guards exactly the three content entities", () => {
    expect(isMailboxGuardedEntity("messages")).toBe(true)
    expect(isMailboxGuardedEntity("conversations")).toBe(true)
    expect(isMailboxGuardedEntity("drafts")).toBe(true)
    expect(isMailboxGuardedEntity("accounts")).toBe(false)
  })

  it("reports every supplied plaintext field, per entity", () => {
    expect(
      suppliedPlaintextFields("messages", {
        subject: "s",
        textBody: "t",
        htmlBody: "h",
        snippet: "n",
      }).sort(),
    ).toEqual(["htmlBody", "snippet", "subject", "textBody"])
    expect(suppliedPlaintextFields("conversations", { subject: "s", snippet: "n" }).sort()).toEqual(
      ["snippet", "subject"],
    )
    expect(
      suppliedPlaintextFields("drafts", { subject: "s", htmlBody: "h", textBody: "t" }).sort(),
    ).toEqual(["htmlBody", "subject", "textBody"])
  })

  it("checks only the SUPPLIED keys, which is what makes a partial update safe", () => {
    // The trigger needs distinctness logic because Postgres fills NEW with the
    // unchanged OLD values on a partial UPDATE. This layer needs none, because a
    // key the handler did not supply is simply not in `data`. A markRead is:
    expect(suppliedPlaintextFields("messages", { isRead: true })).toEqual([])
    // ... and so is an archive, a relabel, and a ciphertext-only write.
    expect(suppliedPlaintextFields("messages", { labels: ["x"] })).toEqual([])
    expect(
      suppliedPlaintextFields("messages", { subjectCiphertext: "AAA=", encVersion: 1 }),
    ).toEqual([])
  })

  it("treats an empty string and a null as absence, not content", () => {
    // Existing draft rows keep '' after the NOT NULL is dropped, and blanking a
    // field is exactly what a purge does.
    expect(suppliedPlaintextFields("drafts", { subject: "", htmlBody: "", textBody: "" })).toEqual(
      [],
    )
    expect(suppliedPlaintextFields("messages", { subject: null, textBody: undefined })).toEqual([])
  })

  it("ignores an entity outside the regime entirely", () => {
    expect(suppliedPlaintextFields("accounts", { subject: "s" })).toEqual([])
  })

  it("names the entity and every offending field in the error", () => {
    const err = new MailboxPlaintextForbiddenError("messages", ["subject", "textBody"])
    expect(err.message).toContain("mailbox_plaintext_forbidden")
    expect(err.message).toContain("messages")
    expect(err.message).toContain("subject")
    expect(err.message).toContain("textBody")
  })
})

// The guarded-column list is stated THREE times: this TS map, the inline SQL
// trigger body for messages/conversations in the manifest, and a second,
// differently shaped trigger body for drafts (NULLIF-based emptiness checks
// rather than IS NOT NULL). None is generated from another, so nothing but this
// test keeps plaintext-guard's promise that it "mirrors the trigger's semantics
// exactly" honest: add a column to one layer and the other two silently stop
// guarding it. The trigger still enforces, so a desync is a readability and
// diagnosis defect rather than a hole, which is exactly the kind that survives.
describe("the guard agrees with the manifest's trigger bodies", () => {
  const manifest = JSON.parse(
    readFileSync(
      path.join(import.meta.dir, "..", "..", "apps", "mail", "app.manifest.json"),
      "utf8",
    ),
  ) as {
    schema: Record<string, { triggers?: Record<string, { body: string }> }>
  }

  /** Every `NEW.<column>` the trigger body reads, deduplicated. */
  function columnsNamedByTrigger(body: string): string[] {
    return [...new Set([...body.matchAll(/NEW\.([a-z_]+)/g)].map((m) => m[1] as string))]
  }

  for (const entity of Object.keys(GUARDED_PLAINTEXT_FIELDS)) {
    it(`the ${entity} trigger guards exactly the columns the TS map declares`, () => {
      const body = manifest.schema[entity]?.triggers?.enforce_mailbox_plaintext_invariant?.body
      expect(body, `${entity} has no Invariant P trigger in the manifest`).toBeDefined()

      const named = columnsNamedByTrigger(body as string)
      // Non-vacuity: the regex really did find columns, so an empty match set
      // cannot make the comparison below pass by accident.
      expect(named.length).toBeGreaterThan(0)

      const expected = (GUARDED_PLAINTEXT_FIELDS[entity] as readonly string[])
        .map(guardedColumnName)
        .sort()
      // `raw_headers` and `account_id` are named by the messages trigger for
      // other purposes (the header allowlist and the arming lookup); they are
      // not plaintext content columns, so they are excluded from the comparison
      // rather than added to the map.
      const NON_CONTENT_COLUMNS = new Set(["raw_headers", "account_id"])
      const guardedByTrigger = named.filter((c) => !NON_CONTENT_COLUMNS.has(c)).sort()

      expect(guardedByTrigger).toEqual(expected)
    })
  }

  it("the messages and conversations triggers carry the raw_headers allowlist and drafts does not", () => {
    // The two bodies are shaped differently on purpose: drafts has no headers.
    // Pinning it stops a future "tidy-up" from copying one body over the other.
    const messages = manifest.schema.messages?.triggers?.enforce_mailbox_plaintext_invariant
      ?.body as string
    const drafts = manifest.schema.drafts?.triggers?.enforce_mailbox_plaintext_invariant
      ?.body as string
    expect(messages).toContain("mailbox_headers_forbidden")
    expect(drafts).not.toContain("mailbox_headers_forbidden")
    expect(drafts).not.toContain("raw_headers")
  })
})

describe("the guard is wired into the bridge write paths", () => {
  // The bridge is rpc-bridge.ts composing the per-capability factories in
  // sandbox/bridge/, so the guard reads all of them as one source.
  const sandboxDir = path.resolve(import.meta.dir, "../apps/sandbox")
  const source = [
    path.join(sandboxDir, "rpc-bridge.ts"),
    ...readdirSync(path.join(sandboxDir, "bridge"))
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => path.join(sandboxDir, "bridge", name)),
  ]
    .map((file) => readFileSync(file, "utf8"))
    .join("\n")

  it("every bridge write path calls it, and it is gated on the mail app", () => {
    // Non-vacuity: the file was found and is the bridge.
    expect(source).toContain("db_insert: async (entity: string, dataJson: string)")
    expect(source).toContain("db_update: async (entity: string, id: string, dataJson: string)")
    expect(source).toContain("db_updateMany: async (entity: string, optsJson: string)")
    // THREE call sites, one per write path that carries a `data` object.
    // `db_updateMany` was the gap: it writes an arbitrary `data` object over a
    // `where` clause and is reachable from the mail bundle, so a bulk rewrite of
    // `subject`/`snippet` surfaced as a bare Postgres `mailbox_plaintext_forbidden`
    // instead of the named, field-listing error this layer exists to produce.
    const calls = source.match(/await assertNoMailboxPlaintext\(/g) ?? []
    expect(calls.length).toBe(3)
    expect(source).toContain('if (appName !== "mail" || !isMailboxGuardedEntity(entity)) return')
    // Arming is resolved through the same SECURITY DEFINER helper the trigger
    // uses, never through `encryption_state`, so the two layers cannot disagree.
    expect(source).toContain("mailbox_invariant_armed")
    expect(source).not.toContain('encryption_state === "ready"')
  })
})
