// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `ctx.effects.*`: the effect ledger (lib/effect-once.ts) for sandboxed apps
 * (S11, P3 M14).
 *
 * A function cannot cross the sandbox, so the guest runs the steps one by one
 * (the SDK's `appEffectOnce` helper, `@liaison/app-sdk/effects`): `claim` the key
 * before the outside call, `complete` it with the result after, `release` it
 * when the call threw and did not happen, and `settleUnknown` when a claim
 * came back `unknown` and the app asked the remote side what happened.
 * `markUnknown` turns the app's own claim `unknown` when its call was made and
 * the outcome is in doubt (a timeout), so the next run asks the remote side.
 *
 * Every key is prefixed `app:<appName>:` and scoped to the bridge's org, so an
 * app can neither read nor complete another app's keys (or the kernel's).
 * The claimer is this host process plus this bridge's own run id
 * (`<instance>:<run>`): the ledger's liveness rule reads the process (a claim
 * whose process died is `unknown` at once), and only the run that claimed a
 * key can complete, release or mark it, never a sibling run of the same app in
 * the same process. A guest's claim deadline is at least 30 s, so a guest
 * cannot make a sibling's live claim look stale.
 */
import { randomUUID } from "node:crypto"
import { INSTANCE_ID } from "~/infra/instance-id"
import {
  claimEffect,
  completeEffect,
  markUnknownEffect,
  noteUnknownEffect,
  releaseEffect,
  settleUnknownEffect,
} from "~/lib/effect-once"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"

const MAX_GUEST_KEY = 400
/** The shortest claim deadline a guest may ask for, and the longest. */
const MIN_GUEST_TTL_S = 30
const MAX_GUEST_TTL_S = 86_400

function scopedKey(appName: string, key: unknown): string {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_GUEST_KEY) {
    throw new Error(`ctx.effects: a key is a string of 1 to ${MAX_GUEST_KEY} characters`)
  }
  return `app:${appName}:${key}`
}

function parseJson(raw: unknown, what: string): unknown {
  if (raw === undefined || raw === null || raw === "") return null
  if (typeof raw !== "string") return raw
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`ctx.effects: ${what} is not JSON`)
  }
}

export function createEffectsMethods(ctx: Pick<BridgeContext, "appName" | "orgId">): {
  effects_claim: (key: string, optsJson?: string) => Promise<string>
  effects_complete: (key: string, resultJson?: string) => Promise<string>
  effects_release: (key: string) => Promise<string>
  effects_settleUnknown: (key: string, decisionJson: string) => Promise<string>
  effects_markUnknown: (key: string) => Promise<string>
} {
  const { appName, orgId } = ctx
  const claimer = `${INSTANCE_ID}:${randomUUID()}`
  return {
    effects_claim: async (key, optsJson) => {
      const opts = parseJson(optsJson, "the options") as { pendingTtlS?: unknown } | null
      const ttl = opts?.pendingTtlS
      const scoped = scopedKey(appName, key)
      const claim = await claimEffect(orgId, scoped, {
        claimer,
        ...(typeof ttl === "number" && ttl > 0 && ttl <= MAX_GUEST_TTL_S
          ? { pendingTtlS: Math.max(ttl, MIN_GUEST_TTL_S) }
          : {}),
      })
      // Counted where production watches it, whatever the app then decides.
      if (claim.state === "unknown") noteUnknownEffect(orgId, scoped, claim.claimedBy)
      // The claimer's instance id stays on the host side.
      if (claim.state === "done") return JSON.stringify({ state: "done", result: claim.result })
      return JSON.stringify({ state: claim.state })
    },
    effects_complete: async (key, resultJson) => {
      const outcome = await completeEffect(
        orgId,
        scopedKey(appName, key),
        parseJson(resultJson, "the result"),
        claimer,
      )
      return JSON.stringify({ ok: outcome === "ok" })
    },
    effects_release: async (key) => {
      await releaseEffect(orgId, scopedKey(appName, key), claimer)
      return JSON.stringify({ ok: true })
    },
    effects_markUnknown: async (key) => {
      const ok = await markUnknownEffect(orgId, scopedKey(appName, key), claimer)
      return JSON.stringify({ ok })
    },
    effects_settleUnknown: async (key, decisionJson) => {
      const decision = parseJson(decisionJson, "the decision") as {
        outcome?: unknown
        result?: unknown
      } | null
      if (decision?.outcome !== "done" && decision?.outcome !== "retry") {
        throw new Error('ctx.effects.settleUnknown: outcome is "done" or "retry"')
      }
      const ok = await settleUnknownEffect(
        orgId,
        scopedKey(appName, key),
        decision.outcome === "done"
          ? { outcome: "done", result: decision.result ?? null }
          : { outcome: "retry" },
        claimer,
      )
      return JSON.stringify({ ok })
    },
  }
}
