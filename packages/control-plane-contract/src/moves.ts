// SPDX-License-Identifier: FSL-1.1-ALv2
// Moving one org from one instance to another: the lease messages an instance
// sends the control plane during a move, and the codes an instance answers its
// own clients while one of its orgs is moving.
//
// The instance that drives a move heartbeats the control plane (`move.heartbeat`)
// and holds a lease; the control plane commits a move only while that lease is
// valid, and aborts it once the lease lapses. An instance that finds an org still
// frozen past its deadline asks the control plane what was decided
// (`move.status`). Both are messages of the signed `cell-billing` channel
// (`./money.ts` lists them with the other cell→Control types).
//
// No `node:*` import (the control plane bundles this file into a sandboxed app).
import { z } from "zod"

/** Every state of a move as the control plane records it, in phase order. */
export const MOVE_STATES = [
  "planned",
  "precopy",
  "draining",
  "frozen",
  "committed",
  "finalized",
  "aborted",
  "failed",
] as const

export const moveStateSchema = z.enum(MOVE_STATES)
export type MoveState = z.infer<typeof moveStateSchema>

/**
 * Phases an instance reports in a heartbeat: the ones before the commit. The
 * commit itself is the control plane's compare-and-set, never the instance's word.
 */
export const MOVE_AGENT_PHASES = ["planned", "precopy", "draining", "frozen"] as const

export const moveAgentPhaseSchema = z.enum(MOVE_AGENT_PHASES)
export type MoveAgentPhase = z.infer<typeof moveAgentPhaseSchema>

/** Seconds a heartbeat keeps the lease valid (the driving instance beats every 2 s). */
export const MOVE_LEASE_SECONDS = 15

/** The move's lease messages on the `cell-billing` channel. */
export const MOVE_MESSAGE_TYPES = ["move.heartbeat", "move.status"] as const
export type MoveMessageType = (typeof MOVE_MESSAGE_TYPES)[number]

/** Fields of every cell-billing message (kept identical to `./money.ts`). */
const requestFields = { requestId: z.uuid(), orgId: z.uuid() }

/** The data of each move message. `transferId` names the move. */
export const moveDataSchemas = {
  /** The driving instance is alive in `phase`; renews the lease. */
  "move.heartbeat": z
    .object({ ...requestFields, transferId: z.uuid(), phase: moveAgentPhaseSchema })
    .strict(),
  /** What the control plane decided for this move. */
  "move.status": z.object({ ...requestFields, transferId: z.uuid() }).strict(),
} as const satisfies Record<MoveMessageType, z.ZodType>

/**
 * Both replies: the control plane's state of the move and when the lease ends
 * (null when no lease is held, e.g. after an abort or a commit). A heartbeat
 * answered with `aborted` tells the instance to unfreeze.
 */
const moveStateReplySchema = z
  .object({
    ok: z.literal(true),
    state: moveStateSchema,
    leaseUntil: z.iso.datetime().nullable(),
  })
  .strict()

export const moveOkReplySchemas = {
  "move.heartbeat": moveStateReplySchema,
  "move.status": moveStateReplySchema,
} as const satisfies Record<MoveMessageType, z.ZodType>

// ── What an instance answers its own clients during a move ───────────────────

/**
 * The machine code of the 503 an instance answers for an org that is moving
 * (writes refused while frozen, new agent turns refused while draining, every
 * request once moved away), sent with `Retry-After: ORG_MOVING_RETRY_AFTER_SECONDS`.
 * It is also the reason of the websocket close below.
 */
export const ORG_MOVING_CODE = "org_moving"

/** Seconds a client waits before it retries a request refused with `org_moving`. */
export const ORG_MOVING_RETRY_AFTER_SECONDS = 2

/**
 * The websocket close code for an org that is moving (reason: `ORG_MOVING_CODE`).
 * Unlike the auth or suspension closes, the client reconnects: every
 * `ORG_MOVING_RETRY_AFTER_SECONDS` until the move is over.
 */
export const ORG_MOVING_WS_CLOSE = 4005

/** The `error` object of the 503 `org_moving` reply (`{ error: OrgMovingError }`). */
export const orgMovingErrorSchema = z
  .object({
    code: z.literal(ORG_MOVING_CODE),
    retryAfterSeconds: z.number().int().positive(),
    message: z.string().optional(),
  })
  .strict()

export type OrgMovingError = z.infer<typeof orgMovingErrorSchema>
