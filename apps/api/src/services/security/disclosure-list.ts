// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The disclosure list of a Share anyway message (spec-security.md D4) and the
// typed error its flow raises. Kept apart from share-anyway.ts so the message
// writer can validate a list without importing the rerun machinery.
//
// Every entry must be a real user uuid. withRlsContext maps a system or
// non-uuid actor to the NIL uuid, which the RLS clause would match, so NIL is
// refused here and by a CHECK constraint on the column (0062).

import { UUID_RE } from "~/lib/uuid"

const NIL_UUID = "00000000-0000-0000-0000-000000000000"

export type ShareAnywayErrorCode =
  | "E_SHARE_ANYWAY_NOT_REQUESTER"
  | "E_SHARE_ANYWAY_TURN_NOT_FOUND"
  | "E_SHARE_ANYWAY_AGENT_NOT_FOUND"
  | "E_SHARE_ANYWAY_AGENT_MISMATCH"
  | "E_SHARE_ANYWAY_SCOPE_WIDENED"
  | "E_SHARE_ANYWAY_NOT_PERSISTED"
  | "E_SHARE_ANYWAY_RERUN_FAILED"
  | "E_SCOPE_NOT_DISCLOSABLE"
  | "E_DISCLOSURE_INVALID_MEMBER"

export class ShareAnywayError extends Error {
  readonly code: ShareAnywayErrorCode
  constructor(code: ShareAnywayErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = "ShareAnywayError"
    this.code = code
  }
}

/**
 * Throws unless every id is a real user uuid. The NIL uuid is what
 * withRlsContext sets for a system or non-uuid actor, so a NIL entry would make
 * a disclosed message readable by every such actor.
 */
export function assertDisclosureUserIds(userIds: string[]): void {
  for (const id of userIds) {
    if (typeof id !== "string" || !UUID_RE.test(id) || id === NIL_UUID) {
      throw new ShareAnywayError(
        "E_DISCLOSURE_INVALID_MEMBER",
        `disclosure list entry ${JSON.stringify(id)} is not a real user id`,
      )
    }
  }
}
