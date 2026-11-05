// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, expect, test } from "bun:test"
import {
  createWorkerSchema,
  dropWorkerSchema,
  sweepOrphanSchemas,
} from "@liaison/test-helpers/worker-schema"

const cleanup: number[] = []
afterAll(async () => {
  for (const id of cleanup) {
    try {
      await dropWorkerSchema(id)
    } catch {
      // best-effort
    }
  }
})

test("auth-service can run in worker with zero orgs", async () => {
  const w = await createWorkerSchema(91)
  cleanup.push(91)
  try {
    const rows = await w.sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM organizations`
    expect(rows[0].count).toBe(0)
  } finally {
    await w.close()
  }
})

test("two workers see independent schema state", async () => {
  const a = await createWorkerSchema(92)
  const b = await createWorkerSchema(93)
  cleanup.push(92, 93)
  try {
    const beforeA = await a.sql<
      { count: number }[]
    >`SELECT COUNT(*)::int AS count FROM organizations`
    expect(beforeA[0].count).toBe(0)
    await b.sql`
      INSERT INTO organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'cross-worker-92', 'cross-worker-92')
    `
    const aAfter = await a.sql<
      { count: number }[]
    >`SELECT COUNT(*)::int AS count FROM organizations WHERE name = 'cross-worker-92'`
    expect(aAfter[0].count).toBe(0)
    const bAfter = await b.sql<
      { count: number }[]
    >`SELECT COUNT(*)::int AS count FROM organizations WHERE name = 'cross-worker-92'`
    expect(bAfter[0].count).toBeGreaterThanOrEqual(1)
  } finally {
    await a.close()
    await b.close()
  }
})

test("a worker handle keeps its search_path when its connection is replaced", async () => {
  // The handle's single connection closes when idle (another worker's clone
  // can take longer than the idle timeout) and postgres.js reconnects; the
  // worker's search_path must ride on every new connection, not only the first.
  const w = await createWorkerSchema(95)
  cleanup.push(95)
  try {
    // Outlast the handle's 10 s idle timeout so the next query opens a new one.
    await new Promise((resolve) => setTimeout(resolve, 11_500))
    const rows = await w.sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM organizations`
    expect(rows[0].count).toBe(0)
  } finally {
    await w.close()
  }
}, 60_000)

test("orphan schema sweep is a no-op when nothing is older than the cutoff", async () => {
  const w = await createWorkerSchema(94)
  cleanup.push(94)
  try {
    const dropped = await sweepOrphanSchemas({ olderThanMs: 60 * 60 * 1000 })
    expect(dropped.find((n) => n === "w94_public")).toBeUndefined()
  } finally {
    await w.close()
  }
}, 30000)
