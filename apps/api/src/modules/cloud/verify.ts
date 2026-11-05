// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The gate of the signed Control→cell API (`/api/cloud/*`). In order:
//  1. the signature (contract v2: `x-control-signature|ts|message-id` over
//     `<ts>.<messageId>.<METHOD>.<path>.<sha256(body)>`, ±300 s), keyed by the
//     Control→cell key derived from this instance's key;
//  2. the body parses as JSON, and an `orgId` in it equals the path's org;
//  3. the exact attempt (`messageId:ts`) was never seen (Redis, kept past the window);
//  4. the per-minute budget, counted only for verified requests (the route is
//     exempt from the per-IP limiter: Control is one address for every tenant).
// Anything refused before step 3 has no side effect at all. Every refusal is a
// `{ok:false, code}` body.

import {
  CLOUD_ERROR_CODES,
  type CloudErrorCode,
  CONTROL_REQUEST_WINDOW_SECONDS,
} from "@liaison/control-plane-contract"
import { deriveControlToCellKey, verifyControlRequest } from "@liaison/control-plane-contract/node"
import type { Context } from "hono"
import { createMiddleware } from "hono/factory"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { withSystemDb } from "~/db/privileged"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { decryptInstanceKey, readIdentity } from "~/modules/liaison-team/identity"

const log = rootLogger.child({ service: "cloud-api" })

/** Verified Control requests a cell accepts per minute. */
export const CLOUD_RATE_LIMIT_PER_MINUTE = 300

/** A replay key outlives every ts the window still accepts. */
const REPLAY_TTL_SECONDS = 2 * CONTROL_REQUEST_WINDOW_SECONDS + 60

const ORG_PATH = /^\/api\/cloud\/orgs\/([^/]+)(?:\/|$)/

export type CloudEnv = {
  Variables: {
    /** The parsed JSON body (undefined for an empty body). */
    cloudBody: unknown
    /** The verified `x-control-message-id`. */
    cloudMessageId: string
  }
}

export function cloudError(c: Context, status: ContentfulStatusCode, code: CloudErrorCode) {
  return c.json({ ok: false as const, code }, status)
}

/** The Control→cell key, or null when this instance holds no usable instance key. */
async function controlToCellKey(): Promise<string | null> {
  const identity = await withSystemDb("cloud-api-identity", (db) => readIdentity(db))
  if (!identity) return null
  const instanceKey = decryptInstanceKey(identity)
  return instanceKey ? deriveControlToCellKey(instanceKey) : null
}

export const verifyCloudRequest = createMiddleware<CloudEnv>(async (c, next) => {
  const unauthorized = () => cloudError(c, 401, CLOUD_ERROR_CODES.unauthorized)
  const raw = await c.req.text()

  const key = await controlToCellKey()
  if (!key) {
    log.error(
      { path: c.req.path },
      "Control request refused: this instance has no instance key (install the cell identity)",
    )
    return unauthorized()
  }
  const verified = verifyControlRequest(key, {
    method: c.req.method,
    path: c.req.path,
    body: raw,
    headers: c.req.raw.headers,
  })
  if (!verified.ok) {
    log.warn({ path: c.req.path, reason: verified.reason }, "Control request refused")
    return unauthorized()
  }

  let body: unknown
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw)
    } catch {
      return cloudError(c, 400, CLOUD_ERROR_CODES.invalidRequest)
    }
  }
  const pathOrg = ORG_PATH.exec(c.req.path)?.[1]
  const bodyOrg =
    body !== null && typeof body === "object" ? (body as { orgId?: unknown }).orgId : undefined
  if (pathOrg !== undefined && bodyOrg !== undefined && bodyOrg !== pathOrg) {
    log.warn({ path: c.req.path, messageId: verified.messageId }, "Control request org mismatch")
    return cloudError(c, 401, CLOUD_ERROR_CODES.orgMismatch)
  }

  try {
    const fresh = await redis.set(
      `cloud:replay:${verified.replayKey}`,
      "1",
      "EX",
      REPLAY_TTL_SECONDS,
      "NX",
    )
    if (fresh === null) {
      log.warn({ path: c.req.path, messageId: verified.messageId }, "Control request replayed")
      return unauthorized()
    }
    const minuteKey = `cloud:rate:${Math.floor(Date.now() / 60_000)}`
    const count = await redis.incr(minuteKey)
    if (count === 1) await redis.expire(minuteKey, 120)
    if (count > CLOUD_RATE_LIMIT_PER_MINUTE) {
      log.warn({ path: c.req.path, count }, "Control request budget spent for this minute")
      return cloudError(c, 429, CLOUD_ERROR_CODES.rateLimited)
    }
  } catch (err) {
    // Fail closed: without the replay set an attempt could be played twice.
    log.error({ err, path: c.req.path }, "Control request replay check failed")
    return cloudError(c, 503, CLOUD_ERROR_CODES.busy)
  }

  c.set("cloudBody", body)
  c.set("cloudMessageId", verified.messageId)
  await next()
})
