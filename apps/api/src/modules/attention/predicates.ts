// SPDX-License-Identifier: FSL-1.1-ALv2
export type Predicate =
  | { op: "eq"; path: string; value: unknown }
  | { op: "in"; path: string; values: unknown[] }
  | { op: "exists"; path: string }
  | { op: "and"; clauses: Predicate[] }
  | { op: "or"; clauses: Predicate[] }
  | { op: "not"; clause: Predicate }

function readPath(payload: unknown, path: string): unknown {
  const parts = path.split(".")
  let cur: unknown = payload
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

export function evaluatePredicate(pred: Predicate, payload: unknown): boolean {
  if (!pred || typeof pred !== "object" || typeof (pred as { op?: unknown }).op !== "string") {
    return false
  }
  switch (pred.op) {
    case "eq":
      return readPath(payload, pred.path) === pred.value
    case "in": {
      const value = readPath(payload, pred.path)
      return pred.values.some((v) => v === value)
    }
    case "exists": {
      const v = readPath(payload, pred.path)
      return v !== undefined && v !== null
    }
    case "and":
      return pred.clauses.every((c) => evaluatePredicate(c, payload))
    case "or":
      return pred.clauses.some((c) => evaluatePredicate(c, payload))
    case "not":
      return !evaluatePredicate(pred.clause, payload)
    default:
      return false
  }
}
