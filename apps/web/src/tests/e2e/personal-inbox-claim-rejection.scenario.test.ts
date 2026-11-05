// SPDX-License-Identifier: FSL-1.1-ALv2
import { randomUUID } from "node:crypto"
import { api, type WorkerEnv } from "@liaison/test-helpers"
import { expect, test } from "./fixtures/test"
import { freshAccessToken } from "./helpers/fresh-token"
import { seedMailAccount, seedMailConversation } from "./helpers/mail-fixtures"

function ms(env: WorkerEnv) {
  return env.schemaPrefix ? `"${env.schemaPrefix}app_mail"` : "app_mail"
}

test("personal inbox: claim attempt rejected (422)", async ({ env, world, qa }) => {
  // A personal mailbox of the admin's with one conversation on it.
  const { accountId } = await seedMailAccount(env, world.org.id, {
    userId: qa.admin.id,
    email: `personal-claim-${randomUUID().slice(0, 8)}@e2e.test`,
  })
  const { conversationId } = await seedMailConversation(env, world.org.id, {
    accountId,
    subject: "Personal claim attempt",
    messages: [],
  })

  // Re-issue the admin's token to dodge permission_version drift from earlier
  // tests in the same worker (role/scope mutations bump the version, which
  // would 401 here with the cached `qa.admin.token`).
  const adminToken = await freshAccessToken(env.serverUrl, qa.admin.email, "12345678")
  const res = await api(env.serverUrl, `/api/mail/conversations/${conversationId}`, {
    method: "PATCH",
    token: adminToken,
    body: { assignedTo: qa.amina.id },
  })

  expect(res.status, JSON.stringify(res.body)).toBe(422)
  const message = String(res.body?.error?.message ?? res.body?.message ?? "")
  expect(message.toLowerCase()).toContain("personal")

  const rows = (await env.db.sql.unsafe(
    `SELECT assigned_to FROM ${ms(env)}.conversations WHERE id = $1`,
    [conversationId],
  )) as Array<{ assigned_to: string | null }>
  expect(rows[0]?.assigned_to ?? null).toBeNull()
})
