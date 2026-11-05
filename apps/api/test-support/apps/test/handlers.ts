// SPDX-License-Identifier: FSL-1.1-ALv2
import { createHmac, timingSafeEqual } from "node:crypto"
import { eq } from "drizzle-orm"
import type { WebhookVerificationResult } from "~/modules/webhooks/verification"
import { items } from "./schema"

const WEBHOOK_MAX_AGE_SECONDS = 300

export async function listItems(params: any, ctx: any) {
  let query = ctx.db.select().from(items)
  if (params.status) {
    query = query.where(eq(items.status, params.status))
  }
  return query
}

export async function createItem(params: any, ctx: any) {
  const [item] = await ctx.db
    .insert(items)
    .values({
      orgId: ctx.orgId,
      title: params.title,
      team: params.team,
      status: params.status ?? "open",
      sensitivity: params.sensitivity ?? "public",
      createdBy: ctx.userId,
    })
    .returning()

  await ctx.emit({
    app: "test",
    entity: "items",
    action: "created",
    entityId: item.id,
    data: item,
    userId: ctx.userId,
    orgId: ctx.orgId,
  })

  return item
}

export async function riskyAction(params: any, ctx: any) {
  ctx.logger.info({ itemId: params.itemId, action: params.action }, "Risky action executed")
  return { executed: true }
}

export async function mockExternalSearch(_params: any, _ctx: any) {
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

export async function onItemCreated(_event: any) {
  // Subscriber for item:created events — just log for now
}

export async function processItemsBatch(_payload: any) {
  // Scheduled job — process items batch
}

export async function handleTestWebhook(payload: any, ctx: any) {
  ctx.logger.info({ payload }, "Test webhook received")
}

export async function verifyTestSignature(request: Request): Promise<WebhookVerificationResult> {
  const signature = request.headers.get("x-webhook-signature")
  const deliveryId = request.headers.get("x-webhook-delivery")
  const timestamp = request.headers.get("x-webhook-timestamp")
  if (!signature || !deliveryId || !timestamp) return { valid: false, status: 401 }

  const timestampSeconds = Number(timestamp)
  if (!Number.isInteger(timestampSeconds)) return { valid: false, status: 401 }
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds)
  if (ageSeconds > WEBHOOK_MAX_AGE_SECONDS) return { valid: false, status: 401 }

  const body = await request.text()
  const expected = createHmac("sha256", "test-webhook-secret")
    .update(`${timestamp}.${body}`)
    .digest("hex")

  try {
    if (!timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) {
      return { valid: false, status: 401 }
    }
    return {
      valid: true,
      replayKey: `delivery:${deliveryId}`,
      replayTtlSeconds: 24 * 60 * 60,
    }
  } catch {
    return { valid: false, status: 401 }
  }
}

export async function exportItems(ctx: any) {
  const allItems = await ctx.db.select().from(items)
  return JSON.stringify(allItems)
}
