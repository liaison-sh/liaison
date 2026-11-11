// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Workers parity fixture (executor-parity.test.ts). No imports: the same
// source is the QuickJS bundle and the Worker module.

type Ctx = any

class ToolError extends Error {
  safe = true
  code: string
  retryable = false
  constructor(message: string, code: string) {
    super(message)
    this.name = "ToolError"
    this.code = code
  }
}

export async function create(p: { title: string }, ctx: Ctx) {
  const row = await ctx.db.insert("items", { title: p.title })
  return { title: row.title, hasId: typeof row.id === "string" }
}

export async function list(_p: unknown, ctx: Ctx) {
  const rows = await ctx.db.findMany("items", {})
  return { titles: rows.map((r: { title: string }) => r.title).sort() }
}

export async function atomicFail(p: { title: string }, ctx: Ctx) {
  await ctx.db.insert("items", { title: p.title })
  throw new Error("atomic tool failed after its write")
}

export async function hop(p: { v: string }, ctx: Ctx) {
  return ctx.executeTool("wparityb:echo", { v: p.v })
}

export async function fetchOutside(_p: unknown, ctx: Ctx) {
  try {
    await ctx.fetch("https://not-allowed.example.net/x", { method: "GET" })
    return { refused: false }
  } catch (e) {
    return { refused: true, message: String((e as Error)?.message ?? e) }
  }
}

export async function fetchAuth(_p: unknown, ctx: Ctx) {
  const res = await ctx.fetch("https://api.carrier.test/echo", {
    method: "GET",
    auth: { connection: "carrier", scheme: "header:X-Api-Key", fields: ["key"] },
  })
  return { status: res.status, body: res.body }
}

export async function limited(p: { ms?: number; connection?: string }, ctx: Ctx) {
  let paused: unknown
  try {
    paused = await ctx.limiter.pause(p.connection ?? "carrier", p.ms ?? 300)
  } catch (err) {
    return { refused: (err as { code?: string }).code ?? String(err) }
  }
  const started = Date.now()
  const res = await ctx.fetch("https://api.carrier.test/echo", {
    method: "GET",
    auth: { connection: "carrier", scheme: "header:X-Api-Key", fields: ["key"] },
  })
  return {
    paused: typeof paused === "number" && paused > 0,
    status: res.status,
    held: Date.now() - started >= 200,
  }
}

export async function stamp(p: { marker: string }, ctx: Ctx) {
  await ctx.logger.info("stamping", { marker: p.marker })
  await ctx.emit({
    entity: "items",
    action: "stamped",
    entityId: p.marker,
    data: { marker: p.marker },
  })
  return { stamped: p.marker }
}

export async function bulk(p: { url: string }, ctx: Ctx) {
  const blob = await ctx.bulk.fetchToBlob(p.url)
  if (!blob?.blobId) return { noBlob: blob ?? null }
  const seen: unknown[] = []
  for await (const batch of ctx.bulk.iterateJsonl(blob.blobId, { batchSize: 2 })) {
    seen.push(...(Array.isArray(batch) ? batch : [batch]))
  }
  await ctx.bulk.deleteBlob(blob.blobId)
  return { sizeBytes: blob.sizeBytes, rows: seen }
}

export async function approvalEcho(_p: unknown, ctx: Ctx) {
  return { approval: ctx.approval ?? null, truthy: !!ctx.approval }
}

export async function fail() {
  const e = new Error("bad input for fail") as Error & { status: number; code: string }
  e.status = 422
  e.code = "bad_input"
  throw e
}

export async function toolFail() {
  throw new ToolError("the carrier refused the parcel", "carrier_refused")
}

export async function slow(p: { ms: number }, ctx: Ctx) {
  const until = Date.now() + p.ms
  let n = 0
  while (Date.now() < until) {
    await ctx.db.count("items", {})
    n++
  }
  return { n }
}

export async function configSecret(p: { value: string }, ctx: Ctx) {
  await ctx.config.setSecret("carrierAppSecret", p.value)
  try {
    return { read: await ctx.config.get("carrierAppSecret") }
  } catch (e) {
    const err = e as { code?: string; status?: number }
    return { refused: true, code: err?.code ?? null, status: err?.status ?? null }
  }
}

// ctx.sql / ctx.accounts / ctx.kernel.findByIds: the generic platform reads.
export async function platformReads(p: { n: number; userIds: string[] }, ctx: Ctx) {
  const q = await ctx.sql.query("warehouse", { sql: "SELECT $1::int AS n", params: [p.n] })
  const capped = await ctx.sql.query("warehouse", {
    sql: "SELECT generate_series(1, 20) AS n",
    maxRows: 5,
  })
  const refused = await ctx.sql.query("carrier", { sql: "SELECT 1" })
  const accounts = await ctx.accounts.list("carrier")
  const users = await ctx.kernel.findByIds("users", p.userIds)
  return {
    rows: q.rows,
    cappedRows: capped.rows.length,
    cappedTruncated: capped.truncated,
    refused: refused.error.code,
    accounts: accounts.map((a: { identifier: string; ownerType: string }) => [
      a.identifier,
      a.ownerType,
    ]),
    users: users.length,
  }
}

export async function slowCreate(p: { ms: number; title: string }, ctx: Ctx) {
  const until = Date.now() + p.ms
  while (Date.now() < until) await ctx.db.count("items", {})
  await ctx.db.insert("items", { title: p.title })
  return { ok: true }
}

export async function onPing(payload: { title: string }, ctx: Ctx) {
  await ctx.db.insert("items", { title: payload.title })
  return { ok: true }
}

export async function verifyPing(req: { body: string }) {
  return { valid: true, replayKey: `ping:${req.body}` }
}

// ctx.store: one pass over every method, a version conflict included. Each
// executor uses its own collection `p.c`, so the answers compare as equal.
function stripTime(doc: { id: string; data: unknown; version: number } | null) {
  return doc ? { id: doc.id, data: doc.data, version: doc.version } : doc
}

async function storeErr(fn: () => Promise<unknown>) {
  try {
    await fn()
    return { thrown: false }
  } catch (e) {
    const err = e as { code?: unknown; status?: unknown; message?: unknown }
    return typeof e === "string"
      ? { thrown: true, message: e }
      : { thrown: true, code: err.code ?? null, status: err.status ?? null }
  }
}

export async function storeFlow(p: { c: string }, ctx: Ctx) {
  const c = p.c
  const missing = await ctx.store.get(c, "a")
  const a1 = await ctx.store.set(c, "a", { title: "A", n: 1 }, { ifVersion: 0 })
  const b1 = await ctx.store.set(c, "b", { title: "B", n: 2 })
  const got = await ctx.store.get(c, "a")
  const up = await ctx.store.update(c, "a", { n: 5 }, { ifVersion: a1.version })
  const conflict = await storeErr(() =>
    ctx.store.set(c, "a", { title: "stale" }, { ifVersion: a1.version }),
  )
  const q = await ctx.store.query(c, {
    where: { n: { gte: 2 } },
    orderBy: { field: "n", dir: "asc" },
  })
  const count = await ctx.store.count(c, { title: "B" })
  const total = await ctx.store.count(c)
  const del = await ctx.store.delete(c, "b", { ifVersion: b1.version })
  const after = await ctx.store.count(c)
  const badName = await storeErr(() => ctx.store.get("Bad-Name", "a"))
  return {
    missing,
    a1: stripTime(a1),
    got: stripTime(got),
    up: stripTime(up),
    conflict,
    q: q.items.map((i: { id: string; data: { n: number }; version: number }) => ({
      id: i.id,
      n: i.data.n,
      version: i.version,
    })),
    nextCursor: q.nextCursor,
    count,
    total,
    del,
    after,
    badName,
  }
}

/** Each write, then a read: on a read-only run the writes refuse and the read answers. */
export async function storeWrites(p: { c: string }, ctx: Ctx) {
  return {
    set: await storeErr(() => ctx.store.set(p.c, "w", { title: "w" })),
    update: await storeErr(() => ctx.store.update(p.c, "w", { title: "w2" })),
    delete: await storeErr(() => ctx.store.delete(p.c, "w")),
    read: stripTime(await ctx.store.get(p.c, "w")),
  }
}

export async function storeGet(p: { c: string; id: string }, ctx: Ctx) {
  return stripTime(await ctx.store.get(p.c, p.id))
}

export async function storePut(
  p: { c: string; id: string; data: Record<string, unknown> },
  ctx: Ctx,
) {
  return stripTime(await ctx.store.set(p.c, p.id, p.data))
}

// A resumable job (ctx.steps.run): one page per chunk, `budgetMs: 1` so every
// run hands the rest to a continuation. Each page inserts one item.
export async function pages(p: { total: number; tag: string }, ctx: Ctx) {
  return ctx.steps.run(`pages-${p.tag}`, { budgetMs: 1 }, async (cursor: number | null) => {
    const page = cursor ?? 0
    await ctx.db.insert("items", { title: `${p.tag}-page-${page}` })
    return { done: page + 1 >= p.total, cursor: page + 1 }
  })
}

// A knowledge source kind (manifest `knowledgeSources.notes`): one note per
// page, the cursor is the next page; page 2 deletes the first note.
export async function syncNotes(
  input: { sourceId: string; cursor: number | null; config: { total: number; tag: string } },
  ctx: Ctx,
) {
  const page = input.cursor ?? 0
  const tag = input.config.tag
  await ctx.logger.info("sync page", { page })
  return {
    documents: {
      upsert: [
        { externalId: `${tag}-${page}`, title: `${tag} note ${page}`, body: `page ${page}` },
      ],
      delete: page === 2 ? [`${tag}-0`] : [],
    },
    nextCursor: page + 1,
    done: page + 1 >= input.config.total,
  }
}
