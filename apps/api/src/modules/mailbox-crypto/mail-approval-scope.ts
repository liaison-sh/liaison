// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which approval requests belong to a mailbox, for the two statements that
// strip them (the plaintext purge and the mailbox reset). Both read the rows
// under the alias `ar`.

import { sql as drizzleSql } from "drizzle-orm"
import { schemaRef } from "~/db/schema-ref"

const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)

/**
 * Mail approvals that act on one of these mailboxes, sealed or not, whoever
 * requested them. `tool_name` is the canonical `app:tool` (`canonicalToolName`),
 * never the SDK's `mail__tool`. The target's ids stay in clear in both payload
 * shapes (`accountId`, `conversationId`, `messageId`, `draftId`), which is what
 * ties the approval to a mailbox.
 */
export function mailApprovalScope(orgId: string, accountIds: string[]) {
  const ids = drizzleSql.join(
    accountIds.map((id) => drizzleSql`${id}::uuid`),
    drizzleSql.raw(", "),
  )
  const param = (key: string) =>
    drizzleSql`coalesce(ar.tool_params ->> ${key}, ar.current_payload ->> ${key})`
  return drizzleSql`
    ar.org_id = ${orgId}::uuid
    AND ar.tool_name LIKE 'mail:%'
    AND (
      ${param("accountId")} IN (SELECT id::text FROM ${MAIL}.accounts WHERE id IN (${ids}))
      OR ${param("conversationId")} IN (
        SELECT id::text FROM ${MAIL}.conversations WHERE account_id IN (${ids}))
      OR ${param("messageId")} IN (
        SELECT id::text FROM ${MAIL}.messages WHERE account_id IN (${ids}))
      OR ${param("draftId")} IN (
        SELECT id::text FROM ${MAIL}.drafts WHERE account_id IN (${ids}))
    )`
}

/** The row holds a sealed draft. Never NULL, so it can be negated. */
export const SEALED_MAIL_APPROVAL = drizzleSql`(
  coalesce(ar.tool_params ->> 'mailboxSealed', '') = 'true'
  OR coalesce(ar.current_payload ->> 'mailboxSealed', '') = 'true')`
