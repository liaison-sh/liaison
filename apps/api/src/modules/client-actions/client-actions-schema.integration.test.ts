// SPDX-License-Identifier: FSL-1.1-ALv2
//
// kernel.client_actions and its trail, on the real roles: what a member session
// reads, what it can never read, and the states the table refuses.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { insertSql } from "~/seed/factories/org/test-rows"
import {
  attempt,
  createDoorWorld,
  type DoorWorld,
  dropDoorWorld,
  insertClientAction,
  memberContext,
} from "~/tests/security/portal-doors/fixture"

let w: DoorWorld

beforeAll(async () => {
  w = await createDoorWorld()
})

afterAll(async () => {
  await dropDoorWorld(w)
})

const read = ["kernel:client_actions:read"]

describe("kernel.client_actions", () => {
  it("a decided action cannot be revoked and a revoked one cannot be decided", async () => {
    const decided = await insertClientAction(w, { company_id: w.companyA })
    await sql`UPDATE kernel.client_actions SET decided_at = now(), decision = 'signed' WHERE id = ${decided}`
    const revokeDecided = await sql`
      UPDATE kernel.client_actions SET revoked_at = now(), revoke_reason = 'withdrawn' WHERE id = ${decided}`.then(
      () => "updated",
      (err: { code?: string }) => err.code,
    )
    expect(revokeDecided).toBe("23514")

    const revoked = await insertClientAction(w, { company_id: w.companyA })
    await sql`UPDATE kernel.client_actions SET revoked_at = now(), revoke_reason = 'withdrawn' WHERE id = ${revoked}`
    const decideRevoked = await sql`
      UPDATE kernel.client_actions SET decided_at = now(), decision = 'signed' WHERE id = ${revoked}`.then(
      () => "updated",
      (err: { code?: string }) => err.code,
    )
    expect(decideRevoked).toBe("23514")
    // A decision without its time, or a time without its decision, is refused too.
    const half = await sql`
      UPDATE kernel.client_actions SET decided_at = now() WHERE id = ${await insertClientAction(w, { company_id: w.companyA })}`.then(
      () => "updated",
      (err: { code?: string }) => err.code,
    )
    expect(half).toBe("23514")
  })

  it("neither hash column is readable by a member session, every other column is", async () => {
    const id = await insertClientAction(w, { company_id: w.companyA })
    const results = await withRlsContext(memberContext(w, read), async (tx) => ({
      token: await attempt(tx, `SELECT token_hash FROM kernel.client_actions WHERE id = '${id}'`),
      prior: await attempt(
        tx,
        `SELECT prior_token_hashes FROM kernel.client_actions WHERE id = '${id}'`,
      ),
      star: await attempt(tx, `SELECT * FROM kernel.client_actions WHERE id = '${id}'`),
      plain: await attempt(
        tx,
        `SELECT id, invited_email, target_sha256, expires_at FROM kernel.client_actions WHERE id = '${id}'`,
      ),
    }))
    expect(results.token).toMatchObject({ code: "42501" })
    expect(results.prior).toMatchObject({ code: "42501" })
    expect(results.star).toMatchObject({ code: "42501" })
    expect(results.plain).toMatchObject({ rows: [{ id }] })
  })

  it("a member reads actions only with the read scope, a restricted one only when named, and writes none", async () => {
    const open = await insertClientAction(w, { company_id: w.companyA })
    const restricted = await insertClientAction(w, {
      company_id: w.companyA,
      visible_to: [w.admin.userId],
    })
    const ids = (scopes: string[]) =>
      withRlsContext(memberContext(w, scopes), async (tx) => {
        const r = await attempt(
          tx,
          `SELECT id FROM kernel.client_actions WHERE org_id = '${w.orgId}'`,
        )
        return "rows" in r ? r.rows.map((x) => x.id) : r
      })
    expect(await ids([])).toEqual([])
    const withScope = (await ids(read)) as string[]
    expect(withScope).toContain(open)
    expect(withScope).not.toContain(restricted)
    const write = await withRlsContext(memberContext(w, ["*"]), (tx) =>
      attempt(
        tx,
        `UPDATE kernel.client_actions SET invited_name = 'x' WHERE id = '${open}' RETURNING id`,
      ),
    )
    expect(write).toMatchObject({ code: "42501" })
  })

  it("the trail is append only, and its device rows need the portal log scope", async () => {
    const action = await insertClientAction(w, { company_id: w.companyA })
    const eventId = crypto.randomUUID()
    await sql.unsafe(
      insertSql("kernel.client_action_events", {
        id: eventId,
        org_id: w.orgId,
        action_id: action,
        event: "opened",
        actor_kind: "holder",
      }),
    )
    await sql.unsafe(
      insertSql("kernel.client_action_devices", {
        event_id: eventId,
        org_id: w.orgId,
        ip: "203.0.113.7",
        user_agent: "probe",
      }),
    )
    const change =
      await sql`UPDATE kernel.client_action_events SET event = 'decided' WHERE id = ${eventId}`.then(
        () => "updated",
        (err: Error) => err.message,
      )
    expect(change).toContain("immutable")
    const remove = await sql`DELETE FROM kernel.client_action_events WHERE id = ${eventId}`.then(
      () => "deleted",
      (err: Error) => err.message,
    )
    expect(remove).toContain("immutable_retention")
    const bad = await sql
      .unsafe(
        insertSql("kernel.client_action_events", {
          org_id: w.orgId,
          action_id: action,
          event: "token_shown",
          actor_kind: "holder",
        }),
      )
      .then(
        () => "inserted",
        (err: { code?: string }) => err.code,
      )
    expect(bad).toBe("23514")
    const seen = (scopes: string[]) =>
      withRlsContext(memberContext(w, scopes), async (tx) => ({
        events: await attempt(
          tx,
          `SELECT id FROM kernel.client_action_events WHERE id = '${eventId}'`,
        ),
        devices: await attempt(
          tx,
          `SELECT ip FROM kernel.client_action_devices WHERE event_id = '${eventId}'`,
        ),
      }))
    expect(await seen(read)).toEqual({ events: { rows: [{ id: eventId }] }, devices: { rows: [] } })
    expect(await seen([...read, "kernel:portal:logs"])).toEqual({
      events: { rows: [{ id: eventId }] },
      devices: { rows: [{ ip: "203.0.113.7" }] },
    })
    expect(await seen(["kernel:portal:logs"])).toEqual({
      events: { rows: [] },
      devices: { rows: [] },
    })
  })
})
