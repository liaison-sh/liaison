// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Chained reads. An operation's `chain` names up to MAX_CHAIN_STEPS further
 * reads of the same adapter; each step's params are literals or `{field}`
 * references to one item of the previous step's PROJECTED output (never the
 * raw response). The values then go through the step's own params schema
 * (`render`), so an upstream value is typed, format-checked and encoded like
 * any caller param before it reaches a path, query or body.
 */
import type { ProjectedObject, ProjectedValue } from "./project"
import { CHAIN_REF_RE, type ChainStep, type Operation } from "./schema"

function valueAt(item: ProjectedObject, path: string): ProjectedValue | undefined {
  let cur: ProjectedValue | undefined = item
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined
    cur = Object.hasOwn(cur, seg) ? cur[seg] : undefined
  }
  return cur
}

/**
 * The params one item feeds into a chain step, or null when the item lacks a
 * referenced field (a contact with no company): that item is not followed.
 * A number feeds a string param as its digits, and a numeric string feeds a
 * number or integer param as a number; anything else is passed as it is and
 * left to the step's params schema.
 */
export function chainStepParams(
  step: ChainStep,
  target: Pick<Operation, "params">,
  item: ProjectedObject,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  for (const [name, template] of Object.entries(step.params)) {
    const ref = typeof template === "string" ? CHAIN_REF_RE.exec(template) : null
    if (!ref) {
      out[name] = template
      continue
    }
    const v = valueAt(item, ref[1] ?? "")
    if (v === undefined || v === null || v === "" || typeof v === "object") return null
    const type = target.params.properties[name]?.type
    if (type === "string" && typeof v === "number") out[name] = String(v)
    else if (
      (type === "number" || type === "integer") &&
      typeof v === "string" &&
      /^-?\d+(\.\d+)?$/.test(v)
    )
      out[name] = Number(v)
    else out[name] = v
  }
  return out
}

/** The distinct param sets a step follows: the first MAX fan-out items that feed it, in order. */
export function chainStepCalls(
  step: ChainStep,
  target: Pick<Operation, "params">,
  items: readonly ProjectedObject[],
  maxFanout: number,
): Record<string, unknown>[] {
  const seen = new Set<string>()
  const calls: Record<string, unknown>[] = []
  for (const item of items) {
    if (calls.length >= maxFanout) break
    const params = chainStepParams(step, target, item)
    if (!params) continue
    const key = JSON.stringify(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)))
    if (seen.has(key)) continue
    seen.add(key)
    calls.push(params)
  }
  return calls
}
