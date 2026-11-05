// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Name synthesis for inbound MCP — the four identifiers a server-provided
// tool maps onto across our stack (spec §3.6):
//
//   (slug, server tool)   →  registryKey   = [orgId, "mcp", "<slug>:<sanitized>"]
//                            sdkName       = "mcp__<slug>_<sanitized>"  (AI SDK regex-safe)
//                            scopeString   = "mcp:<slug>:<sanitized>"   (gate string)
//                            projectedName = "<slug>:<sanitized>"       (UI label)

import { createHash } from "node:crypto"

const SLUG_RE = /^[a-z0-9-]{1,32}$/

export function isValidSlug(s: string): boolean {
  return SLUG_RE.test(s)
}

export function sanitizeToolName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
}

/**
 * Sanitization is lossy: `get-user`, `get_user`, and `get.user` all collapse to
 * `get_user`. If two distinct server tool names collapse to the same sanitized
 * form, the registry key collides and one tool silently overwrites the other —
 * a gated/destructive tool could be shadowed by a benign-named one.
 *
 * This resolves a batch of server tool names to a collision-free map of
 * `serverToolName -> sanitized segment`:
 *   - A name that is ALREADY in canonical sanitized form (`sanitize(name) ===
 *     name`) always keeps its clean segment. This protects kernel-injected
 *     synthetic tools (e.g. `resource_read`) whose canonical name other code
 *     references directly — an upstream `resource-read` can never steal it.
 *   - Among the remaining (lossy) names, the first occurrence keeps the clean
 *     segment and each later collision gets a short, stable hash suffix derived
 *     from its ORIGINAL name, so every tool stays distinctly reachable.
 * The assignment is deterministic for a given input order (callers sort first).
 *
 * NOTE: this keys by raw `serverToolName`, so it cannot represent two DISTINCT
 * tool entries that share the same raw name (e.g. an upstream tool advertising
 * the exact raw name `resource_read` alongside the synthetic `resource_read`).
 * Callers that may receive such duplicates — the projector concatenates
 * upstream + synthetic sets — MUST use {@link resolveToolSegments}, which keys
 * per entry and gives the synthetic/canonical entry structural priority.
 */
export function resolveSanitizedNames(serverToolNames: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const taken = new Set<string>()

  const assign = (name: string): void => {
    if (out.has(name)) return // duplicate exact server name — already mapped.
    const candidate = pickSegment(name, taken)
    taken.add(candidate)
    out.set(name, candidate)
  }

  // Pass 1: already-canonical names claim their clean segment first.
  for (const name of serverToolNames) {
    if (sanitizeToolName(name) === name) assign(name)
  }
  // Pass 2: lossy names fill in, disambiguating against what's taken.
  for (const name of serverToolNames) {
    assign(name)
  }
  return out
}

/**
 * A tool entry as seen by the segment resolver. `synthetic` marks a
 * kernel-injected canonical tool (e.g. `resource_read`) whose clean segment
 * other code references directly.
 */
export interface ResolvableTool {
  name: string
  /**
   * Whether this entry is a kernel-injected synthetic/canonical tool. A
   * synthetic entry is given STRUCTURAL priority for the clean segment over any
   * upstream entry that happens to carry the same raw name, so a benign upstream
   * `resource_read` can never plant itself on the destructive synthetic's key.
   */
  synthetic?: boolean
}

/**
 * Per-ENTRY collision-free segment assignment. Unlike
 * {@link resolveSanitizedNames}, this returns one segment per input position
 * (parallel to `tools`), so two DISTINCT entries sharing the same raw name
 * (the upstream-tool-named-`resource_read`-vs-synthetic-`resource_read` case)
 * resolve to two DISTINCT segments instead of collapsing onto a single map key
 * — which previously let whichever entry was planted last silently overwrite
 * the other, bypassing the destructive-tool gate.
 *
 * Priority order (deterministic for a given input order; callers sort first):
 *   1. Synthetic/canonical entries claim their clean segment first. Among
 *      synthetics sharing a raw name, the first wins the clean segment and the
 *      rest are suffixed (should not happen — synthetics are unique by name).
 *   2. Upstream entries already in canonical form claim their clean segment
 *      next, UNLESS a synthetic already took it (structural priority).
 *   3. Remaining (lossy) upstream entries fill in, disambiguating against what
 *      is taken with a stable hash suffix off the original name.
 *
 * Every returned segment is unique, so `registryKeyFromSegment` never produces a
 * colliding key for two entries in the same batch.
 */
export function resolveToolSegments(tools: readonly ResolvableTool[]): string[] {
  const segments: Array<string | undefined> = new Array(tools.length).fill(undefined)
  const taken = new Set<string>()

  const claim = (i: number): void => {
    const candidate = pickSegment(tools[i].name, taken)
    taken.add(candidate)
    segments[i] = candidate
  }

  // Pass 1: synthetic/canonical entries claim their clean segment first.
  for (let i = 0; i < tools.length; i++) {
    if (tools[i].synthetic) claim(i)
  }
  // Pass 2: upstream entries already in canonical form claim next — but only if
  // a synthetic did not already take the clean segment (structural priority).
  for (let i = 0; i < tools.length; i++) {
    if (segments[i] !== undefined) continue
    if (sanitizeToolName(tools[i].name) === tools[i].name) claim(i)
  }
  // Pass 3: remaining (lossy, or canonical-but-shadowed) entries fill in.
  for (let i = 0; i < tools.length; i++) {
    if (segments[i] === undefined) claim(i)
  }
  // Every position is now claimed (Pass 3 fills any straggler), so the cast to
  // `string[]` is sound — the `| undefined` was only a build-up invariant.
  return segments as string[]
}

/**
 * Pick a collision-free sanitized segment for `name`, avoiding everything in
 * `taken`. Shared by both resolvers so canonical/suffix behavior stays in lock
 * step. Does NOT mutate `taken` — the caller records the result.
 */
function pickSegment(name: string, taken: ReadonlySet<string>): string {
  const base = sanitizeToolName(name)
  let candidate = base
  if (taken.has(candidate)) {
    // Stable 6-hex suffix off the original name disambiguates deterministically.
    const suffix = createHash("sha256").update(name).digest("hex").slice(0, 6)
    candidate = base ? `${base}_${suffix}` : `tool_${suffix}`
    // Extremely unlikely, but guard against a suffixed collision too.
    let n = 1
    while (taken.has(candidate)) {
      candidate = `${base}_${suffix}_${n++}`
    }
  }
  return candidate
}

// The `*FromSegment` variants take an already-sanitized (and, where needed,
// collision-disambiguated) name segment — produced by `resolveSanitizedNames`.
// The original-name variants re-sanitize and are kept for callers that hold a
// raw server tool name and don't need collision handling.

export function projectedNameFromSegment(slug: string, segment: string): string {
  return `${slug}:${segment}`
}

export function projectedToolName(slug: string, serverToolName: string): string {
  return projectedNameFromSegment(slug, sanitizeToolName(serverToolName))
}

export function registryKeyFromSegment(
  orgId: string,
  slug: string,
  segment: string,
): [string, string, string] {
  return [orgId, "mcp", projectedNameFromSegment(slug, segment)]
}

export function registryKey(
  orgId: string,
  slug: string,
  serverToolName: string,
): [string, string, string] {
  return registryKeyFromSegment(orgId, slug, sanitizeToolName(serverToolName))
}

/** AI SDK name — provider regex /^[a-zA-Z0-9_-]+$/, so `:` becomes `_`. */
export function sdkName(slug: string, serverToolName: string): string {
  return `mcp__${projectedToolName(slug, serverToolName).replace(/[^a-zA-Z0-9_-]/g, "_")}`
}

/** The scope that covers every tool a connection projects (`mcp:<slug>:<tool>`). */
export function connectionToolNamespace(slug: string): string {
  return `mcp:${slug}`
}

export function scopeStringFromSegment(slug: string, segment: string): string {
  return `mcp:${projectedNameFromSegment(slug, segment)}`
}

export function scopeString(slug: string, serverToolName: string): string {
  return scopeStringFromSegment(slug, sanitizeToolName(serverToolName))
}
