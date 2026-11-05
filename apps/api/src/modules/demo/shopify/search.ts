// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A small reader for Shopify's admin search syntax.
//
// The demo store has to answer the queries the REAL callers send, and they are
// not toys: Boxtal's worklist is
// `status:open AND (fulfillment_status:unfulfilled OR fulfillment_status:partial OR ...)`,
// Home's attention probe is
// `status:open AND fulfillment_status:unfulfilled AND created_at:<'...' AND created_at:>'...'`,
// and an agent types whatever it likes. A regex sweep over those (which is what
// the e2e harness does, deliberately, for three fixed orders) would answer the
// parenthesised OR wrong and quietly hand the operator the wrong worklist.
//
// So this is a real, tiny recursive descent parser over the documented grammar
// (shopify.dev/docs/api/usage/search-syntax): connectives AND / OR, NOT and a
// leading `-`, parenthesised subqueries, `field:value`, range prefixes
// `<`, `<=`, `>`, `>=`, quoted values, and bare terms that match free text.
//
// UNKNOWN FIELDS MATCH. A filter this module does not model returns everything
// rather than nothing, so an unmodelled filter shows a visitor too much data,
// never an empty screen they cannot tell from a broken one.

/** What a record exposes to the matcher: a field's value, or undefined if unmodelled. */
export type FieldValue = string | number | boolean | null | readonly string[]
export type FieldResolver = (field: string) => FieldValue | undefined

type Node =
  | { kind: "and"; left: Node; right: Node }
  | { kind: "or"; left: Node; right: Node }
  | { kind: "not"; inner: Node }
  | { kind: "term"; field: string | null; op: Op; value: string }
  | { kind: "true" }

type Op = "=" | "<" | "<=" | ">" | ">="

// ── tokenizer ────────────────────────────────────────────────────────────────

type Token =
  | { t: "(" }
  | { t: ")" }
  | { t: "and" }
  | { t: "or" }
  | { t: "not" }
  | { t: "term"; field: string | null; op: Op; value: string; negated: boolean }

const WORD = /[^\s():]+/y
const QUOTED = /'([^']*)'|"([^"]*)"/y

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < input.length) {
    const ch = input[i] as string
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    if (ch === "(") {
      tokens.push({ t: "(" })
      i += 1
      continue
    }
    if (ch === ")") {
      tokens.push({ t: ")" })
      i += 1
      continue
    }

    // A field-qualified or bare term, optionally negated by a leading `-`.
    let negated = false
    if (ch === "-") {
      negated = true
      i += 1
    }
    const { text: head, next: afterHead } = readWord(input, i)
    i = afterHead
    if (head === "") {
      // A stray character we cannot read: skip it rather than loop forever.
      i += 1
      continue
    }
    const upper = head.toUpperCase()
    if (!negated && (upper === "AND" || upper === "OR" || upper === "NOT")) {
      tokens.push({ t: upper.toLowerCase() as "and" | "or" | "not" })
      continue
    }
    if (input[i] === ":") {
      i += 1
      const { op, next: afterOp } = readOp(input, i)
      i = afterOp
      let valueNegated = negated
      if (input[i] === "-") {
        valueNegated = !valueNegated
        i += 1
      }
      const { text: value, next: afterValue } = readValue(input, i)
      i = afterValue
      tokens.push({ t: "term", field: head.toLowerCase(), op, value, negated: valueNegated })
      continue
    }
    tokens.push({ t: "term", field: null, op: "=", value: head, negated })
  }
  return tokens
}

function readWord(input: string, from: number): { text: string; next: number } {
  QUOTED.lastIndex = from
  const quoted = QUOTED.exec(input)
  if (quoted) return { text: quoted[1] ?? quoted[2] ?? "", next: QUOTED.lastIndex }
  WORD.lastIndex = from
  const word = WORD.exec(input)
  if (!word) return { text: "", next: from }
  return { text: word[0], next: WORD.lastIndex }
}

function readOp(input: string, from: number): { op: Op; next: number } {
  if (input.startsWith("<=", from)) return { op: "<=", next: from + 2 }
  if (input.startsWith(">=", from)) return { op: ">=", next: from + 2 }
  if (input[from] === "<") return { op: "<", next: from + 1 }
  if (input[from] === ">") return { op: ">", next: from + 1 }
  return { op: "=", next: from }
}

function readValue(input: string, from: number): { text: string; next: number } {
  return readWord(input, from)
}

// ── parser ───────────────────────────────────────────────────────────────────

function parse(tokens: Token[]): Node {
  let pos = 0
  const peek = (): Token | undefined => tokens[pos]

  function parseOr(): Node {
    let left = parseAnd()
    while (peek()?.t === "or") {
      pos += 1
      left = { kind: "or", left, right: parseAnd() }
    }
    return left
  }

  function parseAnd(): Node {
    let left = parseUnary()
    for (;;) {
      const token = peek()
      if (!token) break
      if (token.t === "and") {
        pos += 1
        left = { kind: "and", left, right: parseUnary() }
        continue
      }
      // Adjacency is an implicit AND, which is how every bare multi-word query
      // Shopify documents behaves.
      if (token.t === "(" || token.t === "term" || token.t === "not") {
        left = { kind: "and", left, right: parseUnary() }
        continue
      }
      break
    }
    return left
  }

  function parseUnary(): Node {
    const token = peek()
    if (!token) return { kind: "true" }
    if (token.t === "not") {
      pos += 1
      return { kind: "not", inner: parseUnary() }
    }
    if (token.t === "(") {
      pos += 1
      const inner = parseOr()
      if (peek()?.t === ")") pos += 1
      return inner
    }
    if (token.t === "term") {
      pos += 1
      const node: Node = { kind: "term", field: token.field, op: token.op, value: token.value }
      return token.negated ? { kind: "not", inner: node } : node
    }
    // A dangling connective or a stray `)`: consume it and keep going.
    pos += 1
    return { kind: "true" }
  }

  const tree = parseOr()
  return tree
}

// ── evaluation ───────────────────────────────────────────────────────────────

function asNumber(raw: string): number | null {
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function asTime(raw: string): number | null {
  const t = Date.parse(raw)
  return Number.isNaN(t) ? null : t
}

function compare(left: FieldValue, op: Op, raw: string): boolean {
  if (left === undefined || left === null) return false
  if (Array.isArray(left)) {
    if (op !== "=") return false
    return left.some((item) => String(item).toLowerCase() === raw.toLowerCase())
  }
  if (typeof left === "boolean") return String(left) === raw.toLowerCase()
  if (typeof left === "number") {
    const right = asNumber(raw)
    if (right === null) return false
    return applyOp(left, op, right)
  }

  const text = String(left)
  if (op === "=") {
    const lower = text.toLowerCase()
    const wanted = raw.toLowerCase()
    if (lower === wanted) return true
    // Shopify matches `name:1042` against `#1042`, and prefix-matches words.
    if (lower.replace(/^#/, "") === wanted.replace(/^#/, "")) return true
    return lower.includes(wanted)
  }
  // A range on a string field is a date range in every query the apps send.
  const leftTime = asTime(text)
  const rightTime = asTime(raw)
  if (leftTime !== null && rightTime !== null) return applyOp(leftTime, op, rightTime)
  const leftNum = asNumber(text)
  const rightNum = asNumber(raw)
  if (leftNum !== null && rightNum !== null) return applyOp(leftNum, op, rightNum)
  return false
}

function applyOp(left: number, op: Op, right: number): boolean {
  switch (op) {
    case "<":
      return left < right
    case "<=":
      return left <= right
    case ">":
      return left > right
    case ">=":
      return left >= right
    default:
      return left === right
  }
}

function evaluate(node: Node, resolve: FieldResolver, text: string): boolean {
  switch (node.kind) {
    case "true":
      return true
    case "and":
      return evaluate(node.left, resolve, text) && evaluate(node.right, resolve, text)
    case "or":
      return evaluate(node.left, resolve, text) || evaluate(node.right, resolve, text)
    case "not":
      return !evaluate(node.inner, resolve, text)
    case "term": {
      if (node.field === null) return text.toLowerCase().includes(node.value.toLowerCase())
      // `field:` with nothing after the colon filters on nothing, so it matches
      // nothing. Falling through to `compare` would substring-match the empty
      // string against every value and silently return the whole store.
      if (node.value === "") return false
      const value = resolve(node.field)
      // An unmodelled field is not a filter: match, so the screen fills.
      if (value === undefined) return true
      return compare(value, node.op, node.value)
    }
  }
}

/** Does `text` / `resolve` satisfy `query`? An empty query matches everything. */
export function matchesShopifySearch(
  query: string | null | undefined,
  resolve: FieldResolver,
  text = "",
): boolean {
  if (query === null || query === undefined || query.trim() === "") return true
  return evaluate(parse(tokenize(query)), resolve, text)
}
