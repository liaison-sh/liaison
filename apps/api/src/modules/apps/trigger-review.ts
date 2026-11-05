// SPDX-License-Identifier: FSL-1.1-ALv2
// Static review of an app-supplied PL/pgSQL trigger body.
//
// A trigger function is created by the registering role but RUNS as whoever writes
// the row, inside that request's RLS transaction. The RLS inputs
// (`app.current_org_id`, scopes, ...) are plain transaction GUCs that any SQL in the
// session can overwrite with `set_config`, and the writer's role can read the kernel
// schema, so an unreviewed body is a cross-tenant primitive (see the regression test,
// which proves it against the runtime role).
//
// The primary control is WHO may ship triggers (first-party or trusted-publisher
// signed only; see install-service). This review is defence in depth for the bodies
// that pass that gate: it keeps a body to the app's own tables, row-local logic and
// plain control flow. It is a deny-list on a closed grammar, deliberately
// conservative: dynamic SQL, session/role/GUC changes, anything outside the app's own
// schema, comments (which can hide tokens from a reviewer) and quoted-identifier
// tricks are all refused.
const MAX_TRIGGER_BODY_CHARS = 8_000

const FORBIDDEN: Array<{ re: RegExp; why: string }> = [
  { re: /set_config/i, why: "set_config" },
  // `UPDATE t SET col = ...` is fine; `SET [LOCAL|SESSION] <guc>` is not. A custom GUC
  // is always dotted (`app.current_org_id`); the bare ones that matter are listed.
  {
    re: /\bset\s+(?:local\s+|session\s+)?(?:role|session|search_path|constraints|transaction|row_security|statement_timeout|[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\s*(?:=|to\b))/i,
    why: "SET of a session/role/GUC setting",
  },
  { re: /\breset\b/i, why: "RESET" },
  { re: /\bexecute\b/i, why: "dynamic SQL (EXECUTE)" },
  { re: /\bperform\s+(?:pg_|lo_|dblink)/i, why: "system function call" },
  {
    re: /\b(?:copy|listen|notify|unlisten|call|grant|revoke|alter|drop|create|truncate|vacuum)\b/i,
    why: "DDL/utility statement",
  },
  {
    re: /\b(?:security\s+definer|session_user|current_user|authorization)\b/i,
    why: "role switching",
  },
  {
    re: /\b(?:pg_[a-z_]+|dblink[a-z_]*|lo_[a-z_]+|information_schema)\b/i,
    why: "system catalogue/function",
  },
  { re: /--|\/\*/, why: "SQL comment" },
  { re: /u&"/i, why: "unicode-escaped identifier" },
]

/** Schemas a trigger must never reference (the app's own schema is the only one allowed). */
const FOREIGN_SCHEMA = /(?:^|[^A-Za-z0-9_$."])"?(kernel|public|drizzle|app_[a-z0-9_]+)"?\s*\./gi

export class TriggerReviewError extends Error {
  readonly status = 400
  constructor(label: string, why: string) {
    super(`Trigger ${label} refused: ${why}`)
    this.name = "TriggerReviewError"
  }
}

/**
 * Words that may stand before a `(` without being a function call: SQL and PL/pgSQL
 * keywords and type names (`numeric(10,2)`).
 */
const PAREN_KEYWORDS = new Set([
  "if",
  "elsif",
  "while",
  "in",
  "values",
  "exists",
  "any",
  "all",
  "some",
  "array",
  "row",
  "cast",
  "extract",
  "and",
  "or",
  "not",
  "where",
  "when",
  "then",
  "else",
  "select",
  "from",
  "on",
  "conflict",
  "using",
  "returning",
  "return",
  "set",
  "by",
  "as",
  "is",
  "into",
  "case",
  "between",
  "like",
  "ilike",
  "distinct",
  "filter",
  "over",
  "coalesce",
  "nullif",
  "greatest",
  "least",
  "exception",
  "notice",
  "raise",
  "loop",
  "for",
  "foreach",
  "join",
  "lateral",
  "numeric",
  "decimal",
  "varchar",
  "char",
  "character",
  "timestamp",
  "timestamptz",
  "time",
  "interval",
  "bit",
  "float",
  "with",
  "do",
  "update",
])

/**
 * Functions a trigger body may call: row-local, side-effect free. Anything else (and
 * in particular every function that runs a query handed to it as text, like the
 * `query_to_xml` family, which no keyword check can see into) is refused.
 */
const SAFE_FUNCTIONS = new Set([
  "now",
  "clock_timestamp",
  "statement_timestamp",
  "transaction_timestamp",
  "current_date",
  "lower",
  "upper",
  "trim",
  "btrim",
  "ltrim",
  "rtrim",
  "length",
  "char_length",
  "octet_length",
  "substring",
  "substr",
  "replace",
  "concat",
  "concat_ws",
  "left",
  "right",
  "position",
  "strpos",
  "split_part",
  "regexp_replace",
  "regexp_match",
  "regexp_matches",
  "starts_with",
  "initcap",
  "lpad",
  "rpad",
  "repeat",
  "reverse",
  "md5",
  "encode",
  "decode",
  "to_char",
  "to_date",
  "to_timestamp",
  "to_number",
  "date_trunc",
  "date_part",
  "age",
  "make_interval",
  "abs",
  "round",
  "floor",
  "ceil",
  "ceiling",
  "mod",
  "sign",
  "trunc",
  "gen_random_uuid",
  "jsonb_build_object",
  "jsonb_build_array",
  "json_build_object",
  "to_jsonb",
  "jsonb_set",
  "jsonb_array_length",
  "jsonb_typeof",
  "jsonb_strip_nulls",
  "jsonb_extract_path_text",
  "array_length",
  "array_append",
  "array_prepend",
  "array_remove",
  "array_position",
  "array_to_string",
  "string_to_array",
  "cardinality",
  "unnest",
  "count",
  "sum",
  "max",
  "min",
  "avg",
  "bool_and",
  "bool_or",
  "string_agg",
  "array_agg",
  "jsonb_agg",
  "format",
  "quote_literal",
  "num_nonnulls",
  "num_nulls",
])

/** The body with its single-quoted string literals blanked out. */
function withoutStrings(body: string): string {
  return body.replace(/'(?:[^']|'')*'/g, "''")
}

/** Throws a TriggerReviewError unless the body passes the static review. */
export function reviewTriggerBody(body: string, ownSchema: string, label: string): void {
  if (body.length > MAX_TRIGGER_BODY_CHARS) {
    throw new TriggerReviewError(label, `body exceeds ${MAX_TRIGGER_BODY_CHARS} characters`)
  }
  for (const { re, why } of FORBIDDEN) {
    if (re.test(body)) throw new TriggerReviewError(label, `uses ${why}`)
  }
  // Quoted identifiers can spell any keyword or setting name past the checks above
  // (`SET "role"`), and a body that only touches its own tables never needs them.
  if (body.includes('"')) throw new TriggerReviewError(label, "uses a quoted identifier")
  const code = withoutStrings(body)
  // A setting is changed by a statement that starts with SET. The only legitimate
  // SET is the column list of an UPDATE in the same statement.
  for (const stmt of code.split(";")) {
    if (/\bset\b/i.test(stmt) && !/\bupdate\b[\s\S]*\bset\b/i.test(stmt)) {
      throw new TriggerReviewError(label, "uses a SET statement")
    }
  }
  // Every call must be a known row-local function, a keyword, or an object of the
  // app's own schema; an INSERT target's column list is not a call.
  const call = /([A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*([A-Za-z_][A-Za-z0-9_$]*))?\s*\(/g
  for (const m of code.matchAll(call)) {
    const qualifier = m[2] ? m[1].toLowerCase() : null
    const name = (m[2] ?? m[1]).toLowerCase()
    if (qualifier !== null) {
      if (qualifier === ownSchema.toLowerCase() || qualifier === "new" || qualifier === "old") {
        continue
      }
      throw new TriggerReviewError(label, `calls '${qualifier}.${name}'`)
    }
    if (PAREN_KEYWORDS.has(name) || SAFE_FUNCTIONS.has(name)) continue
    const before = code.slice(0, m.index).trimEnd()
    if (/\binto$/i.test(before)) continue
    throw new TriggerReviewError(label, `calls '${name}', which is not on the trigger allow-list`)
  }
  for (const m of body.matchAll(FOREIGN_SCHEMA)) {
    if (m[1].toLowerCase() !== ownSchema.toLowerCase()) {
      throw new TriggerReviewError(
        label,
        `references schema '${m[1]}' (only '${ownSchema}' is allowed)`,
      )
    }
  }
}
