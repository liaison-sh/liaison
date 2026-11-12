// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Calculated values (map.expr, a measure's expr): a small arithmetic grammar parsed by hand,
// never evaluated as code.
//
//   expr    = term (("+" | "-") term)*
//   term    = unary (("*" | "/") unary)*
//   unary   = "-" unary | primary
//   primary = number | name | name "(" expr ("," expr)* ")" | "(" expr ")"
//
// Names are values the block computed (map.values, other measures); functions are min, max,
// abs and round(x[, decimals]). A missing value, a division by zero or a non-finite result is
// null: the figure shows as "no value", never as a wrong number.

export const MAX_EXPR_LENGTH = 300
const MAX_DEPTH = 32
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/
export const EXPR_NAME = NAME

export class ExprError extends Error {}

type Node =
  | { k: "num"; v: number }
  | { k: "name"; name: string }
  | { k: "neg"; x: Node }
  | { k: "bin"; op: "+" | "-" | "*" | "/"; a: Node; b: Node }
  | { k: "call"; fn: "min" | "max" | "abs" | "round"; args: Node[] }

const FUNCTIONS = new Set(["min", "max", "abs", "round"])

type Token = { t: "num"; v: number } | { t: "name"; v: string } | { t: "op"; v: string }

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === " " || c === "\t") {
      i++
      continue
    }
    const num = /^(\d+(\.\d+)?|\.\d+)/.exec(src.slice(i))
    if (num) {
      out.push({ t: "num", v: Number(num[0]) })
      i += num[0].length
      continue
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))
    if (name) {
      out.push({ t: "name", v: name[0] })
      i += name[0].length
      continue
    }
    if ("+-*/(),".includes(c)) {
      out.push({ t: "op", v: c })
      i++
      continue
    }
    throw new ExprError(`unexpected '${c}' at ${i + 1}: use numbers, names, + - * / and ( )`)
  }
  return out
}

/** Parses `src`; throws ExprError naming the problem. */
export function parseExpr(src: string): Node {
  if (src.length > MAX_EXPR_LENGTH) {
    throw new ExprError(`an expression is at most ${MAX_EXPR_LENGTH} characters`)
  }
  const tokens = tokenize(src)
  let pos = 0
  const peek = () => tokens[pos]
  const isOp = (v: string) => {
    const t = peek()
    return t?.t === "op" && t.v === v
  }
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExprError(`expected '${v}'`)
    pos++
  }
  const expr = (depth: number): Node => {
    if (depth > MAX_DEPTH) throw new ExprError("the expression nests too deep")
    let a = term(depth)
    while (isOp("+") || isOp("-")) {
      const op = (tokens[pos++] as { v: "+" | "-" }).v
      a = { k: "bin", op, a, b: term(depth) }
    }
    return a
  }
  const term = (depth: number): Node => {
    let a = unary(depth)
    while (isOp("*") || isOp("/")) {
      const op = (tokens[pos++] as { v: "*" | "/" }).v
      a = { k: "bin", op, a, b: unary(depth) }
    }
    return a
  }
  const unary = (depth: number): Node => {
    if (isOp("-")) {
      pos++
      return { k: "neg", x: unary(depth + 1) }
    }
    return primary(depth)
  }
  const primary = (depth: number): Node => {
    const t = peek()
    if (!t) throw new ExprError("the expression ends too early")
    if (t.t === "num") {
      pos++
      return { k: "num", v: t.v }
    }
    if (t.t === "name") {
      pos++
      if (isOp("(")) {
        if (!FUNCTIONS.has(t.v)) {
          throw new ExprError(`unknown function '${t.v}': min, max, abs, round`)
        }
        pos++
        const args = [expr(depth + 1)]
        while (isOp(",")) {
          pos++
          args.push(expr(depth + 1))
        }
        expect(")")
        const fn = t.v as "min" | "max" | "abs" | "round"
        if (fn === "abs" && args.length !== 1) throw new ExprError("abs takes one value")
        if (fn === "round" && args.length > 2)
          throw new ExprError("round takes a value and decimals")
        return { k: "call", fn, args }
      }
      if (!NAME.test(t.v)) throw new ExprError(`'${t.v}' is not a name`)
      return { k: "name", name: t.v }
    }
    if (t.v === "(") {
      pos++
      const inner = expr(depth + 1)
      expect(")")
      return inner
    }
    throw new ExprError(`unexpected '${t.v}'`)
  }
  if (tokens.length === 0) throw new ExprError("the expression is empty")
  const root = expr(0)
  if (pos < tokens.length) {
    const t = tokens[pos]!
    throw new ExprError(`unexpected '${String(t.v)}' after the end of the expression`)
  }
  return root
}

/** The names an expression reads. */
export function exprNames(src: string): string[] {
  const out = new Set<string>()
  const walk = (n: Node) => {
    switch (n.k) {
      case "name":
        out.add(n.name)
        return
      case "neg":
        walk(n.x)
        return
      case "bin":
        walk(n.a)
        walk(n.b)
        return
      case "call":
        for (const a of n.args) walk(a)
        return
      case "num":
        return
    }
  }
  walk(parseExpr(src))
  return [...out]
}

/** The problems of an expression over `known` names (empty: it is fine). */
export function exprProblems(src: string, known: readonly string[]): string[] {
  try {
    const unknown = exprNames(src).filter((n) => !known.includes(n))
    return unknown.map(
      (n) => `'${n}' is not a value of this block (${known.length ? known.join(", ") : "none"})`,
    )
  } catch (err) {
    if (err instanceof ExprError) return [err.message]
    throw err
  }
}

function evalNode(n: Node, values: Readonly<Record<string, number | null>>): number | null {
  switch (n.k) {
    case "num":
      return n.v
    case "name":
      return values[n.name] ?? null
    case "neg": {
      const x = evalNode(n.x, values)
      return x === null ? null : -x
    }
    case "bin": {
      const a = evalNode(n.a, values)
      const b = evalNode(n.b, values)
      if (a === null || b === null) return null
      switch (n.op) {
        case "+":
          return a + b
        case "-":
          return a - b
        case "*":
          return a * b
        case "/":
          return b === 0 ? null : a / b
      }
      return null
    }
    case "call": {
      const args = n.args.map((a) => evalNode(a, values))
      if (args.some((a) => a === null)) return null
      const nums = args as number[]
      switch (n.fn) {
        case "min":
          return Math.min(...nums)
        case "max":
          return Math.max(...nums)
        case "abs":
          return Math.abs(nums[0]!)
        case "round": {
          const d = Math.max(0, Math.min(6, Math.trunc(nums[1] ?? 0)))
          const f = 10 ** d
          return Math.round(nums[0]! * f) / f
        }
      }
    }
  }
}

/** The value of `src` over `values`, rounded to 6 decimals; null when it cannot be computed. */
export function evaluateExpr(
  src: string,
  values: Readonly<Record<string, number | null>>,
): number | null {
  const out = evalNode(parseExpr(src), values)
  if (out === null || !Number.isFinite(out)) return null
  return Math.round(out * 1e6) / 1e6
}
