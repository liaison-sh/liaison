// SPDX-License-Identifier: FSL-1.1-ALv2
import { randomUUID } from "node:crypto"
import { api, type WorkerEnv } from "@liaison/test-helpers"
import { expect } from "@playwright/test"
import { seedMailConversation } from "./mail-fixtures"

export interface AttachedConversation {
  conversationId: string
  subject: string
}

/**
 * An inbound conversation on `accountId` with the contact (its
 * `contact_id` backlink), one message long, for the EntityPreview-from-backlinks
 * tests.
 */
export async function attachMailToContact(
  env: WorkerEnv,
  orgId: string,
  contactId: string,
  accountId: string,
  subject: string,
): Promise<AttachedConversation> {
  const { conversationId } = await seedMailConversation(env, orgId, {
    accountId,
    subject,
    contactId,
    messages: [
      {
        direction: "inbound",
        from: { name: "Backlink Sender", email: "backlink-sender@e2e.test" },
        to: [],
        textBody: `${subject} body`,
      },
    ],
  })
  return { conversationId, subject }
}

/**
 * Convenience wrapper around POST /api/contacts/resolve so destructive-merge tests
 * use unique test-scoped identities instead of mutating worker-shared QA contacts.
 */
export async function seedContactPair(
  env: WorkerEnv,
  token: string,
  prefix: string,
): Promise<{
  primary: { id: string; name: string | null; email: string | null }
  duplicate: { id: string; name: string | null; email: string | null }
  searchPrefix: string
}> {
  const unique = `${prefix}-${randomUUID().slice(0, 8)}`
  const searchPrefix = `e2e-${unique}`
  const primaryRes = await api(env.serverUrl, "/api/contacts/resolve", {
    token,
    body: {
      email: `${searchPrefix}-primary@e2e.test`,
      name: `${searchPrefix} Primary`,
      company: "E2E Co",
      externalId: { e2e: `${unique}-primary` },
    },
  })
  expect(primaryRes.status, JSON.stringify(primaryRes.body)).toBe(200)
  const duplicateRes = await api(env.serverUrl, "/api/contacts/resolve", {
    token,
    body: {
      email: `${searchPrefix}-duplicate@e2e.test`,
      name: `${searchPrefix} Duplicate`,
      company: "E2E Co",
      externalId: { e2e: `${unique}-duplicate` },
    },
  })
  expect(duplicateRes.status, JSON.stringify(duplicateRes.body)).toBe(200)
  return {
    primary: primaryRes.body.data,
    duplicate: duplicateRes.body.data,
    searchPrefix,
  }
}

export async function resolveContact(
  env: WorkerEnv,
  token: string,
  body: Record<string, unknown>,
): Promise<{ id: string; name: string | null; email: string | null }> {
  const res = await api(env.serverUrl, "/api/contacts/resolve", { token, body })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data
}
