// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invariant P, second line of defence: the sandbox db bridge.
//
// The database trigger is the enforcement point, and deliberately so: a bundle
// rollback restores plaintext-writing handlers, and only the database survives
// that. This layer exists so a handler bug fails with a readable error naming
// the field, instead of a bare `mailbox_plaintext_forbidden` from Postgres.
//
// It mirrors the trigger's semantics exactly and needs no distinctness logic:
// `validateFields` sees only the SUPPLIED keys, and a key that is not supplied
// is not checked, which is precisely what "raise only on a value the encryption
// regime owns" means at this layer.

/**
 * The columns the encryption regime owns, per entity, in manifest camelCase.
 *
 * This list and the inline SQL trigger bodies in `apps/mail/app.manifest.json`
 * are two statements of one fact, and the comment above promises they agree.
 * Nothing structural can make them agree (the trigger bodies are opaque strings
 * inside JSON), so `plaintext-guard.test.ts` PARSES those bodies and asserts the
 * column sets match this map exactly, in both directions. Exported for that
 * test: a future column added to one layer and not the other then fails the
 * build instead of silently un-guarding this one.
 */
export const GUARDED_PLAINTEXT_FIELDS: Record<string, readonly string[]> = {
  messages: ["subject", "textBody", "htmlBody", "snippet"],
  conversations: ["subject", "snippet"],
  drafts: ["subject", "htmlBody", "textBody"],
}

/** camelCase manifest field -> the snake_case column the trigger body names. */
export function guardedColumnName(field: string): string {
  return field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

/** True when this entity is one the mail encryption regime guards. */
export function isMailboxGuardedEntity(entity: string): boolean {
  return entity in GUARDED_PLAINTEXT_FIELDS
}

/**
 * The guarded plaintext fields this write actually supplies with content.
 * Empty string is absence, not content: existing draft rows keep `''` after the
 * NOT NULL is dropped, and blanking a field is how a purge looks.
 */
export function suppliedPlaintextFields(entity: string, data: Record<string, unknown>): string[] {
  const guarded = GUARDED_PLAINTEXT_FIELDS[entity]
  if (!guarded) return []
  return guarded.filter((field) => {
    const value = data[field]
    return typeof value === "string" && value !== ""
  })
}

/** The error the bridge raises. Named so the handler side can match on it. */
export class MailboxPlaintextForbiddenError extends Error {
  constructor(
    readonly entity: string,
    readonly fields: string[],
  ) {
    super(
      `mailbox_plaintext_forbidden: cannot write plaintext ${fields.join(", ")} on "${entity}" ` +
        "for a mailbox whose owner holds an active mailbox identity. Seal the value first.",
    )
    this.name = "MailboxPlaintextForbiddenError"
  }
}
