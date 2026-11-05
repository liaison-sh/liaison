// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHICH CLAUDE MODEL A NODE RUNS. The matcher the desktop page used (moved
// here unchanged from apps/web/src/lib/desktop-shell-contract.ts, which
// re-exports it) plus the explicit resolver the API checks a session with
// (D45, L18): a model the person NAMED runs as named or is refused; only a
// saved agent preference keeps the family fallback; nothing ever downgrades
// silently to the default.

import type { EffortLevel } from "./node-session-protocol"

/** A model a node offers. The desktop's `DesktopLocalModel` fits this shape. */
export interface OfferedNodeModel {
  id: string
  efforts?: EffortLevel[]
}

/** The model a local session prefers when the user picked none. */
export const DESKTOP_DEFAULT_LOCAL_MODEL = "claude-haiku-4-5"

/**
 * THE DEFAULT AMONG WHAT IS OFFERED. The preferred default when it is offered,
 * as is or as a dated snapshot of it (the SDK may name `claude-haiku-4-5` as
 * `claude-haiku-4-5-20251001`); otherwise the first Haiku offered, the
 * cheapest family, so a turn nobody chose a model for never lands on the most
 * expensive one; otherwise the first offered. The preferred id itself when
 * nothing is offered at all.
 */
export function defaultLocalModel(offered: readonly OfferedNodeModel[]): string {
  const preferred = offered.find(
    (model) =>
      model.id === DESKTOP_DEFAULT_LOCAL_MODEL ||
      model.id.startsWith(`${DESKTOP_DEFAULT_LOCAL_MODEL}-`),
  )
  if (preferred) return preferred.id
  const haiku = offered.find((model) => model.id.includes("haiku"))
  return (haiku ?? offered[0])?.id ?? DESKTOP_DEFAULT_LOCAL_MODEL
}

/** The family of a Claude model id (`claude-sonnet-5` gives "sonnet"), or null. */
export function localModelFamily(id: string): string | null {
  return /^claude-(fable|opus|sonnet|haiku)-/.exec(id)?.[1] ?? null
}

/** A Claude model id taken apart: its family and its version (`[major, minor]`). */
export interface ClaudeModelVersion {
  family: string
  major: number
  minor: number
}

/**
 * `claude-<family>-<major>[-<minor>][-<YYYYMMDD>][[<context>]]`, or null for
 * any other shape. A minor is one or two digits, so a dated snapshot's
 * 8-digit date is never read as a version (`claude-haiku-4-5-20251001` is
 * Haiku 4.5, `claude-opus-5` is Opus 5.0). The family is any word, so a family
 * the SDK adds later parses with no change here.
 */
export function parseClaudeModelId(id: string): ClaudeModelVersion | null {
  const parts = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[[^\]]*\])?$/.exec(id)
  if (!parts) return null
  return { family: parts[1] as string, major: Number(parts[2]), minor: Number(parts[3] ?? 0) }
}

function compareVersions(a: ClaudeModelVersion, b: ClaudeModelVersion): number {
  return a.major - b.major || a.minor - b.minor
}

/**
 * ONLY THE CURRENT MODEL OF EACH FAMILY, in the order given.
 *
 * The Agent SDK's `supportedModels()` lists every model a login may run,
 * pinned older versions included (`claude-opus-4-6` beside `claude-opus-5-5`),
 * and an agent offered that list picks from it. A family's current model is
 * its highest version, read from the ids themselves, so a newer SDK that
 * lists `claude-opus-6` offers it with no change here and no list to keep up
 * to date. Within that version the first listed wins (the SDK lists the
 * alias's resolved id first, before a dated snapshot or a `[1m]` variant). An
 * id of another shape is kept: it is not ours to judge.
 *
 * THIS FILTERS WHAT IS OFFERED, never what is accepted: pickers, the agent's
 * choices and refusal lists show this; a session that names any id the SDK
 * runs still starts (`resolveNodeModel`, the desktop's start checks).
 *
 * Read from the ids, not from the SDK's alias rows, because the list a node
 * publishes carries ids only: the desktop and the server then run this one
 * function on the same list and agree. Should an alias ever resolve below a
 * pinned version it also lists (a preview, say), the higher version is the one
 * offered; every answer seen so far resolves each alias to its family's
 * highest listed version.
 */
export function currentNodeModels<T extends OfferedNodeModel>(models: readonly T[]): T[] {
  const best = new Map<string, { version: ClaudeModelVersion; index: number }>()
  models.forEach((model, index) => {
    const version = parseClaudeModelId(model.id)
    if (!version) return
    const seen = best.get(version.family)
    if (!seen || compareVersions(version, seen.version) > 0) {
      best.set(version.family, { version, index })
    }
  })
  return models.filter((model, index) => {
    const version = parseClaudeModelId(model.id)
    return !version || best.get(version.family)?.index === index
  })
}

/**
 * WHAT A SAVED CHOICE RUNS ON AMONG WHAT IS OFFERED, or null when nothing
 * stands for it. The id itself when offered; else its dated snapshot
 * (`claude-haiku-4-5` as `claude-haiku-4-5-20251001`); else the first offered
 * model of the same family, which is the newest because the SDK lists a
 * family's alias row first (a saved `claude-sonnet-5` the SDK dropped runs on
 * its newest Sonnet, not on the global Haiku default).
 */
export function offeredLocalModelFor(
  chosen: string,
  offered: readonly OfferedNodeModel[],
): string | null {
  const exact = exactOfferedModel(chosen, offered)
  if (exact) return exact
  const family = localModelFamily(chosen)
  if (!family) return null
  return offered.find((model) => localModelFamily(model.id) === family)?.id ?? null
}

/**
 * A REQUESTED MODEL AMONG WHAT IS OFFERED: the id itself, else its dated
 * snapshot (`<id>-YYYYMMDD`), else null. No family fallback: a request for
 * `claude-opus-9` never runs on `claude-opus-5-5` (K2).
 */
export function exactOfferedModel(
  requested: string,
  offered: readonly OfferedNodeModel[],
): string | null {
  if (offered.some((model) => model.id === requested)) return requested
  const dated = offered.find(
    (model) =>
      model.id.startsWith(`${requested}-`) && /^\d{8}$/.test(model.id.slice(requested.length + 1)),
  )
  return dated?.id ?? null
}

export type NodeModelResolution =
  | { ok: true; model: string }
  | { ok: false; reason: "model_unavailable"; offered: string[] }

/**
 * THE MODEL A SESSION RUNS ON (D45). `offered` is EVERY model the node's SDK
 * runs, pinned older versions included: what a session may run on. Only its
 * current models (`currentNodeModels`) are ever chosen for it or listed back.
 *
 * A requested model must be among them (exactly or as its dated snapshot) or
 * the session is refused, so a session that names an older version the SDK
 * still runs (a retry, a routine, a dispatch) starts as named, and creation
 * and claim, which both resolve here, give the same answer. With none
 * requested, the agent's saved preference as named when the node runs it,
 * else the current model of its family; else the node's default among its
 * current models. A refusal lists the current models only, so nobody is told
 * to pick a legacy one. Nothing offered refuses with an empty list.
 */
export function resolveNodeModel(input: {
  requested?: string | null
  agentPreference?: string | null
  offered: readonly OfferedNodeModel[]
}): NodeModelResolution {
  const { requested, agentPreference, offered } = input
  const current = currentNodeModels(offered)
  const refuse = (): NodeModelResolution => ({
    ok: false,
    reason: "model_unavailable",
    offered: current.map((model) => model.id),
  })
  if (offered.length === 0) return refuse()
  if (requested) {
    const model = exactOfferedModel(requested, offered)
    return model ? { ok: true, model } : refuse()
  }
  const preferred = agentPreference
    ? (exactOfferedModel(agentPreference, offered) ??
      offeredLocalModelFor(agentPreference, current))
    : null
  return { ok: true, model: preferred ?? defaultLocalModel(current) }
}
