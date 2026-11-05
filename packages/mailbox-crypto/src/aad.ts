// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Additional authenticated data for every AES-GCM operation in this package.
//
//     aad = header_bytes || 0x00 || context_string          (spec section 3.4)
//
// `header_bytes` is the two-byte `version || key_id` prefix of the blob, so the
// version and the key id are covered by the tag and a version-2 downgrade
// cannot be applied silently.
//
// The eleven context strings are spelled out here, once, and reached only
// through the builders below, so that a ciphertext cannot be relocated between
// columns, rows or tenants and no call site can invent a context.
//
// This is NOT `apps/api/src/lib/crypto.ts`. That module is server-held-key
// encryption at rest and shares nothing with this one but the idea of binding a
// context. Confusing the two is the most damaging mistake available here.

import { type Bytes, concatBytes, utf8, ZERO_BYTE } from "./bytes"

/**
 * One sealed object's binding. `context` goes into the AAD (section 3.4);
 * `fieldName` and `entityId` are the D5 inputs (section 3.6) that give the
 * object its own subkey, so no key ever encrypts two plaintexts.
 */
export interface MailboxAadContext {
  readonly context: string
  readonly fieldName: string
  readonly entityId: string
}

function ctx(context: string, fieldName: string, entityId: string): MailboxAadContext {
  return { context, fieldName, entityId }
}

export const mailboxAad = {
  messageTextBody: (messageId: string) =>
    ctx(`mail.message:text_body:${messageId}`, "message.text_body", messageId),
  messageHtmlBody: (messageId: string) =>
    ctx(`mail.message:html_body:${messageId}`, "message.html_body", messageId),
  messageSubject: (messageId: string) =>
    ctx(`mail.message:subject:${messageId}`, "message.subject", messageId),
  messageSnippet: (messageId: string) =>
    ctx(`mail.message:snippet:${messageId}`, "message.snippet", messageId),
  messageHeaders: (messageId: string) =>
    ctx(`mail.message:headers:${messageId}`, "message.headers", messageId),
  conversationSubject: (conversationId: string) =>
    ctx(`mail.conversation:subject:${conversationId}`, "conversation.subject", conversationId),
  conversationSnippet: (conversationId: string) =>
    ctx(`mail.conversation:snippet:${conversationId}`, "conversation.snippet", conversationId),
  attachment: (fileId: string) => ctx(`mail.attachment:${fileId}`, "attachment", fileId),
  draftBody: (draftId: string) => ctx(`mail.draft:body:${draftId}`, "draft.body", draftId),
  draftSubject: (draftId: string) => ctx(`mail.draft:subject:${draftId}`, "draft.subject", draftId),
  index: (userId: string, shardId: string) =>
    ctx(`mail.index:${userId}:${shardId}`, "index", `${userId}:${shardId}`),
} as const

/** Every builder name, so a test can assert the list is complete. */
export const MAILBOX_AAD_BUILDERS = [
  "messageTextBody",
  "messageHtmlBody",
  "messageSubject",
  "messageSnippet",
  "messageHeaders",
  "conversationSubject",
  "conversationSnippet",
  "attachment",
  "draftBody",
  "draftSubject",
  "index",
] as const satisfies readonly (keyof typeof mailboxAad)[]

export type MailboxAadBuilderName = (typeof MAILBOX_AAD_BUILDERS)[number]

/** `header || 0x00 || utf8(context)`. */
export function buildAad(header: Bytes, context: MailboxAadContext): Bytes {
  return concatBytes(header, ZERO_BYTE, utf8(context.context))
}

/**
 * The AAD for wrapping an identity keyring's private halves under the Account
 * Key (spec section 3.1). It is deliberately NOT one of the eleven section 3.4
 * contexts and not part of `MAILBOX_AAD_BUILDERS`: those bind mail content,
 * this one binds key material. It lives here anyway so that every context
 * string in the design is written in exactly one file.
 */
export function keyringWrapAad(
  userId: string,
  keyId: number,
  part: "ecdh" | "sign",
): MailboxAadContext {
  return ctx(
    `liaison.mailbox.keyring:${userId}:${keyId}:${part}`,
    `keyring.${part}`,
    `${userId}:${keyId}`,
  )
}
