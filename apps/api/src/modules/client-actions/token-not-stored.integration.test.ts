// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A link's token exists only in the mail and in the mint call's memory. After a
// send, a code, a resend by rotation and a decision, no text or json column of
// any table in any schema holds the raw token, its code or its proof, and no
// Redis key or value does (job queues included). Nor after the link mail comes
// back through a synced mailbox and a reply quotes the link.
import { describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { redis } from "~/lib/redis"
import {
  call,
  codeFor,
  mailboxOf,
  mintTo,
  nextIp,
  syncedCopyOf,
  syncPage,
  useClientActionWorld,
} from "../../../test-support/client-actions-kit"

const kit = useClientActionWorld("storedocs")

async function columnsHolding(needles: string[]): Promise<string[]> {
  const cols = (await sql`
    SELECT table_schema AS s, table_name AS t, column_name AS c
      FROM information_schema.columns c
      JOIN information_schema.tables t USING (table_schema, table_name)
     WHERE t.table_type = 'BASE TABLE'
       AND table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
       AND data_type IN ('text', 'character varying', 'json', 'jsonb', 'ARRAY', 'bytea')
  `) as unknown as Array<{ s: string; t: string; c: string }>
  expect(cols.length).toBeGreaterThan(100)
  const hits: string[] = []
  for (const { s, t, c } of cols) {
    const ident = `"${s.replace(/"/g, '""')}"."${t.replace(/"/g, '""')}"`
    const col = `"${c.replace(/"/g, '""')}"`
    for (const needle of needles) {
      const rows = await sql.unsafe(
        `SELECT 1 FROM ${ident} WHERE position($1 in ${col}::text) > 0 LIMIT 1`,
        [needle],
      )
      if (rows.length > 0) hits.push(`${s}.${t}.${c}`)
    }
  }
  return hits
}

async function redisHolding(needles: string[]): Promise<string[]> {
  const hits: string[] = []
  let cursor = "0"
  do {
    const [next, keys] = await redis.scan(cursor, "COUNT", 500)
    cursor = next
    for (const raw of keys) {
      // Keys come back with the run's prefix; reads below add it again, so strip it.
      const prefix = redis.options.keyPrefix ?? ""
      const key = prefix && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw
      if (needles.some((n) => raw.includes(n))) hits.push(`key ${raw}`)
      const type = await redis.type(key)
      let value = ""
      if (type === "string") value = (await redis.get(key)) ?? ""
      else if (type === "hash") value = JSON.stringify(await redis.hgetall(key))
      else if (type === "list") value = JSON.stringify(await redis.lrange(key, 0, 200))
      else if (type === "zset") value = JSON.stringify(await redis.zrange(key, "0", "200"))
      else if (type === "set") value = JSON.stringify(await redis.smembers(key))
      else if (type === "stream")
        value = JSON.stringify(await redis.xrange(key, "-", "+", "COUNT", "200"))
      if (needles.some((n) => value.includes(n))) hits.push(`value ${raw}`)
    }
  } while (cursor !== "0")
  return hits
}

describe("a client action's token is never stored", () => {
  it("after a send no text or json column of any table holds the token", async () => {
    const first = await mintTo(kit)
    const ip = nextIp()
    const code = await codeFor(kit, first.token, ip, kit.w.clientA.email)
    const v = await call(
      "verify",
      { t: first.token, code, name: kit.w.clientA.name },
      { "x-bun-socket-ip": ip },
    )
    const { proof } = (await v.json()) as { proof: string }
    const decided = await call(
      "decide",
      { t: first.token, proof, decision: "sign", typed_name: kit.w.clientA.name },
      { "x-bun-socket-ip": ip },
    )
    expect(decided.status).toBe(200)
    // A second link, still open: its token is in the mail only.
    const second = await mintTo(kit, kit.w.clientA2)
    const needles = [first.token, code, proof, second.token]
    expect(await columnsHolding(needles)).toEqual([])
    expect(await redisHolding(needles)).toEqual([])
  }, 120_000)

  it("after a synced inbound mail quoting the link no text or json column holds the token", async () => {
    const sent = await mintTo(kit)
    const link = (sent.mail.text ?? "").match(/https?:\/\/\S*\/a#t=[A-Za-z0-9_-]+/)?.[0]
    expect(link).toBeDefined()
    const box = await mailboxOf(kit, kit.w.admin.userId, kit.w.admin.email)
    await syncPage(kit, box.accountId, kit.w.admin.userId, [
      // The link mail itself, synced back from the inbox it reached.
      syncedCopyOf(sent.mail),
      // The client's reply, quoting it in text and HTML.
      syncedCopyOf(
        {
          to: kit.w.admin.email,
          from: kit.w.clientA.email,
          subject: `Re: ${sent.mail.subject}`,
          text: `Done.\n> ${link}`,
          html: `<blockquote><a href="${link}">${link}</a></blockquote>`,
        },
        { headers: {} },
      ),
    ])
    expect(await columnsHolding([sent.token])).toEqual([])
    expect(await redisHolding([sent.token])).toEqual([])
  }, 120_000)
})
