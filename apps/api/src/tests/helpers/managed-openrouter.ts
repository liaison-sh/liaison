// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A managed cell's side calls on OpenRouter, for tests (S31): a stub OpenRouter
// that answers embeddings and chat completions with a reported cost, and a
// managed org with a billing state, a balance and a user. Neutral values only.
import { sql } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import {
  seedCreditBalance,
  seedOrgBillingState,
  setSystemConfig,
} from "~/seed/factories/billing/billing"
import { seedOrgRow, seedUserRows } from "~/seed/factories/org/rows"

/** The kernel schema, prefixed in a test lane (db/kernel-schema-literal.guard.test.ts). */
const K = () => sql(schemaRef("kernel"))

export interface RecordedOpenRouterRequest {
  path: string
  body: Record<string, unknown>
  authorization: string | null
}

export interface ManagedOpenRouterStub {
  /** The base URL to put in OPENROUTER_BASE_URL. */
  baseUrl: string
  requests: RecordedOpenRouterRequest[]
  stop(): void
}

/** The USD cost the stub reports for every call. */
export const STUB_CALL_COST_USD = 0.0004
/** The text a chat completion answers. */
export const STUB_ANSWER = "A cracked panel showing error E04."

/** A vector of `dims` numbers, distinct per input index. */
function vector(dims: number, seed: number): number[] {
  return Array.from({ length: dims }, (_, i) => ((i + seed) % 7) / 10)
}

export function startManagedOpenRouterStub(dims = 3072): ManagedOpenRouterStub {
  const requests: RecordedOpenRouterRequest[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
      requests.push({ path, body, authorization: req.headers.get("authorization") })
      if (path.endsWith("/embeddings")) {
        const input = Array.isArray(body.input) ? body.input : [body.input]
        return Response.json({
          object: "list",
          model: body.model,
          data: input.map((_, i) => ({
            object: "embedding",
            index: i,
            embedding: vector(dims, i),
          })),
          usage: {
            prompt_tokens: input.length * 5,
            total_tokens: input.length * 5,
            cost: STUB_CALL_COST_USD,
          },
        })
      }
      if (path.endsWith("/chat/completions")) {
        return Response.json({
          id: "gen-stub",
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: STUB_ANSWER },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 300,
            completion_tokens: 20,
            total_tokens: 320,
            cost: STUB_CALL_COST_USD,
          },
        })
      }
      return new Response("not found", { status: 404 })
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}/api/v1`,
    requests,
    stop: () => server.stop(true),
  }
}

/**
 * A managed org with a billing state (`status`), a credit balance, one user,
 * and a stored USD/EUR rate so a reported USD cost converts exactly.
 */
export async function seedManagedOrg(opts: {
  orgId: string
  userId: string
  status?: string
  balance?: string
}): Promise<void> {
  const { orgId, userId } = opts
  await seedOrgRow(
    {
      id: orgId,
      name: "Managed side calls",
      slug: `msc-${orgId.slice(-8)}`,
      tier: "team",
      settings: {},
    },
    { onConflict: "reset-settings" },
  )
  await seedUserRows(
    [{ id: userId, orgId, email: `msc-${orgId.slice(-8)}@test.com`, name: "Side Call User" }],
    { onConflict: "skip" },
  )
  await seedCreditBalance(
    orgId,
    { included: opts.balance ?? "100.00000000", purchased: "0" },
    { onConflict: "included" },
  )
  await setManagedOrgStatus(orgId, opts.status ?? "active")
  await setSystemConfig("usd_eur_rate", { rate: 1.25, fetchedAt: new Date().toISOString() })
}

export async function setManagedOrgStatus(orgId: string, status: string): Promise<void> {
  await seedOrgBillingState(
    orgId,
    { plan: "base", status, includedCredits: 100 },
    { onConflict: "status" },
  )
}

export async function cleanupManagedOrg(orgId: string): Promise<void> {
  await sql`DELETE FROM ${K()}.credit_transactions WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.credit_balances WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.org_billing_state WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.users WHERE org_id = ${orgId}`
  await sql`DELETE FROM ${K()}.organizations WHERE id = ${orgId}`
}
