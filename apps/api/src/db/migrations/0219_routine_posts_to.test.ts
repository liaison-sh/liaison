// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0219: a routine's output thread pointed at a conversation becomes its
// report_thread_id (where it posts), and the output thread goes back to being
// its own, made on the next run. An existing report_thread_id wins, a routine
// whose owner is not in that conversation is left alone, a routine's own run
// thread is untouched, and a second run changes nothing.
//
// Everything runs in ONE transaction on one superuser connection and is rolled
// back, so tests sharing this database see nothing.

import { afterAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import postgres from "postgres"

const FILE = new URL("./0219_routine_posts_to.sql", import.meta.url).pathname

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const conn = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

afterAll(async () => {
  await conn.end()
})

class Rollback extends Error {}

type Row = { name: string; output: string | null; report: string | null }

describe("0219 routine posts to", () => {
  it("moves a conversation output thread to report_thread_id, once", async () => {
    const org = crypto.randomUUID()
    const owner = crypto.randomUUID()
    const other = crypto.randomUUID()
    const tag = org.slice(0, 8)
    const ids = {
      dm: crypto.randomUUID(),
      channel: crypto.randomUUID(),
      foreign: crypto.randomUUID(),
      own: crypto.randomUUID(),
      chosen: crypto.randomUUID(),
    }
    let after: Row[] = []
    let again: Row[] = []
    await conn
      .begin(async (tx) => {
        await tx`INSERT INTO kernel.organizations (id, name, slug)
          VALUES (${org}, 'Posts Org', ${`posts-org-${tag}`})`
        for (const [id, name] of [
          [owner, "Owner"],
          [other, "Other"],
        ] as const) {
          await tx`INSERT INTO kernel.users (id, org_id, email, name)
            VALUES (${id}, ${org}, ${`${name.toLowerCase()}-${tag}@example.com`}, ${name})`
        }
        const thread = async (id: string, type: string, seated: string) => {
          await tx`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
            VALUES (${id}, ${org}, ${`t-${id.slice(0, 8)}`}, ${type}, ${seated})`
          await tx`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
            VALUES (${id}, ${seated}, ${org})`
        }
        await thread(ids.dm, "agent_chat", owner)
        await thread(ids.channel, "thread", owner)
        await thread(ids.foreign, "thread", other)
        await thread(ids.own, "routine", owner)
        await thread(ids.chosen, "thread", owner)
        const routine = (name: string, output: string, report: string | null) =>
          tx`INSERT INTO kernel.routines
               (org_id, owner_user_id, name, description, kind, cron, timezone, prompt, scopes,
                output_thread_id, report_thread_id, created_by_user_id, created_by_actor_type)
             VALUES (${org}, ${owner}, ${name}, 'd', 'recurring', '0 9 * * *', 'UTC', 'p', '{}',
                     ${output}, ${report}, ${owner}, 'user')`
        await routine("to-dm", ids.dm, null)
        await routine("to-channel-chosen", ids.channel, ids.chosen)
        await routine("to-foreign", ids.foreign, null)
        await routine("own-thread", ids.own, null)

        const read = () =>
          tx<Row[]>`SELECT name, output_thread_id::text AS output, report_thread_id::text AS report
                      FROM kernel.routines WHERE org_id = ${org} ORDER BY name`
        await tx.unsafe(readFileSync(FILE, "utf8"))
        after = await read()
        await tx.unsafe(readFileSync(FILE, "utf8"))
        again = await read()
        throw new Rollback()
      })
      .catch((err) => {
        if (!(err instanceof Rollback)) throw err
      })

    expect(after).toEqual([
      { name: "own-thread", output: ids.own, report: null },
      { name: "to-channel-chosen", output: null, report: ids.chosen },
      { name: "to-dm", output: null, report: ids.dm },
      { name: "to-foreign", output: ids.foreign, report: null },
    ])
    expect(again).toEqual(after)
  })
})
