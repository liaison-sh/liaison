// SPDX-License-Identifier: FSL-1.1-ALv2
// Test app sandbox handler bundle — TypeScript source, transpiled at load time for QuickJS
// No imports allowed — bridge methods are injected via ctx at runtime
// biome-ignore-all lint/correctness/noUnusedVariables: handlers are resolved by manifest export name inside the sandbox

interface TestAppCtx {
  getUserId(): string
  getOrgId(): string
  db_findMany(entity: string, optsJson: string): Promise<string>
  db_findOne(entity: string, id: string): Promise<string>
  db_insert(entity: string, dataJson: string): Promise<string>
  db_update(entity: string, id: string, dataJson: string): Promise<void>
  db_updateMany(entity: string, optsJson: string): Promise<string>
  db_delete(entity: string, id: string): Promise<void>
  emit(eventJson: string): Promise<void>
  log_info(msg: string, dataJson?: string): void
  approval_recordStarted(toolName: string): Promise<void>
  approval_recordSucceeded(toolName: string, externalRefJson?: string): Promise<void>
  approval_recordFailedNoEffect(toolName: string, errJson: string): Promise<void>
  approval_recordAmbiguous(toolName: string, errJson: string): Promise<void>
}

async function listItems(params: { status?: string }, ctx: TestAppCtx) {
  const rows = await ctx.db_findMany(
    "items",
    JSON.stringify(params.status ? { where: { status: params.status } } : {}),
  )
  return JSON.parse(rows)
}

async function createItem(
  params: { title: string; team?: string; status?: string; sensitivity?: string },
  ctx: TestAppCtx,
) {
  const inserted = await ctx.db_insert(
    "items",
    JSON.stringify({
      title: params.title,
      team: params.team,
      status: params.status || "open",
      sensitivity: params.sensitivity || "public",
      createdBy: ctx.getUserId(),
    }),
  )
  const item = JSON.parse(inserted)
  await ctx.emit(
    JSON.stringify({
      entity: "items",
      action: "created",
      entityId: item.id,
      data: item,
    }),
  )
  return item
}

function riskyAction(params: { itemId: string; action: string }, ctx: TestAppCtx) {
  ctx.log_info(
    "Risky action executed",
    JSON.stringify({ itemId: params.itemId, action: params.action }),
  )
  return { executed: true }
}

async function gatedEcho(params: { message: string }, ctx: TestAppCtx) {
  await ctx.approval_recordStarted("test:gatedEcho")
  await ctx.approval_recordSucceeded("test:gatedEcho", JSON.stringify({ synthetic: true }))
  return { echoed: params.message }
}

// gatedEcho with a six-hour approval window, for a pending approval that is not
// close to expiring (the feed's calm expiry tone).
async function gatedEchoLater(params: { message: string }, ctx: TestAppCtx) {
  await ctx.approval_recordStarted("test:gatedEchoLater")
  await ctx.approval_recordSucceeded("test:gatedEchoLater", JSON.stringify({ synthetic: true }))
  return { echoed: params.message }
}

// Gated tool that performs a REAL mutation (emits items:created through the
// RPC bridge) on decided execution. Used to prove the decided gated mutation's
// audit row carries the originating actorType (spec C7 / success criterion 7).
async function gatedCreateItem(params: { title: string; team?: string }, ctx: TestAppCtx) {
  await ctx.approval_recordStarted("test:gatedCreateItem")
  const inserted = await ctx.db_insert(
    "items",
    JSON.stringify({
      title: params.title,
      team: params.team,
      status: "open",
      sensitivity: "public",
      createdBy: ctx.getUserId(),
    }),
  )
  const item = JSON.parse(inserted)
  await ctx.emit(
    JSON.stringify({
      entity: "items",
      action: "created",
      entityId: item.id,
      data: item,
    }),
  )
  await ctx.approval_recordSucceeded("test:gatedCreateItem", JSON.stringify({ id: item.id }))
  return item
}

// Sequencing fixtures — gatedProduce yields a referenceable output; gatedConsume
// takes that output (threaded as `note` via an @ref token) plus a human-editable
// `label`. Together they prove the compound-approval bundle mechanism end to end.
async function gatedProduce(params: { seed: string }, ctx: TestAppCtx) {
  await ctx.approval_recordStarted("test:gatedProduce")
  await ctx.approval_recordSucceeded("test:gatedProduce")
  return { value: `produced-${params.seed}` }
}

async function gatedConsume(params: { note: string; label: string }, ctx: TestAppCtx) {
  await ctx.approval_recordStarted("test:gatedConsume")
  await ctx.approval_recordSucceeded("test:gatedConsume")
  return { consumed: params.note, label: params.label }
}

function mockExternalSearch(_params: unknown, _ctx: TestAppCtx) {
  return [
    { id: "1", name: "EU Alpha", market: "eu" },
    { id: "2", name: "EU Beta", market: "eu" },
    { id: "3", name: "EU Gamma", market: "eu" },
    { id: "4", name: "US Alpha", market: "us" },
    { id: "5", name: "US Beta", market: "us" },
    { id: "6", name: "US Gamma", market: "us" },
    { id: "7", name: "AP Alpha", market: "ap" },
    { id: "8", name: "AP Beta", market: "ap" },
    { id: "9", name: "AP Gamma", market: "ap" },
    { id: "10", name: "EU Delta", market: "eu" },
  ]
}

async function onItemCreated(event: { entityId?: string; data?: unknown }, ctx: TestAppCtx) {
  if (ctx?.db_insert && event?.entityId) {
    await ctx.db_insert(
      "event_log",
      JSON.stringify({
        eventType: "item:created",
        entityId: event.entityId,
        data: JSON.stringify(event.data || {}),
      }),
    )
  }
}

async function processItemsBatch(payload: { orgId?: string }, ctx: TestAppCtx) {
  if (ctx?.db_updateMany && payload?.orgId) {
    await ctx.db_updateMany(
      "items",
      JSON.stringify({
        where: { status: "pending" },
        data: { status: "processed" },
      }),
    )
  }
}

function handleTestWebhook(payload: unknown, ctx: TestAppCtx) {
  ctx.log_info("Test webhook received", JSON.stringify({ payload }))
}

function verifyTestSignature(request: { headers?: Record<string, string> }) {
  const signature = request.headers?.["x-webhook-signature"]
  if (!signature) return false
  const valid = typeof signature === "string" && signature.length === 64
  if (!valid) return false
  const deliveryId = request.headers?.["x-webhook-delivery"] || signature
  return { valid: true, replayKey: deliveryId, replayTtlSeconds: 300 }
}

async function exportItems(_params: unknown, ctx: TestAppCtx) {
  const items = await ctx.db_findMany("items", "{}")
  return JSON.parse(items)
}
