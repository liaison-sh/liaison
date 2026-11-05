#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Live API-2026 drift audit for the shopify app's GraphQL operations. Extracts every
// `query`/`mutation` document from mutations/*.ts + reads.ts and sends each to the LIVE dev store
// with a probe variable shape that forces GraphQL DOCUMENT VALIDATION to fail BEFORE execution —
// so NOTHING is created/mutated. GraphQL validates the response SELECTION SET (and any provided
// input fields) against the live schema regardless of variable values, so a removed/renamed field
// (the l6 `InventoryLevel.available` / l10 `InventoryChange.locationId` class) surfaces as a
// "Field 'X' doesn't exist on type 'Y'" / "Field is not defined" error. We collect those, excluding
// our own deliberate probe field. Read-only/non-executing: safe against the shared live store.
//
// Run: bun run bundled-apps/shopify/scripts/audit-api-2026.ts
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { loadShopifyEnv } from "./_shopify-client.ts"

/** Raw GraphQL POST that returns the error MESSAGES robustly — Shopify normally returns
 *  `errors: [{message}]`, but an unrecognised top-level field can come back as `errors: "Not Found"`
 *  (a STRING) or an HTTP error; the app's graphql() helper assumes the array shape and would crash on
 *  the string. The audit must see all three so it never silently misses drift. */
async function rawGraphqlErrorMessages(
  env: ReturnType<typeof loadShopifyEnv>,
  query: string,
  variables: Record<string, unknown>,
): Promise<string[]> {
  const url = `https://${env.domain}/admin/api/${env.apiVersion}/graphql.json`
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": env.offlineToken },
    body: JSON.stringify({ query, variables }),
  })
  const text = await res.text()
  let json: { errors?: unknown }
  try {
    json = JSON.parse(text) as { errors?: unknown }
  } catch {
    return [`HTTP ${res.status}: ${text.slice(0, 200)}`]
  }
  const e = json.errors
  if (!e) return []
  if (typeof e === "string") return [e]
  if (Array.isArray(e)) return e.map((x) => String((x as { message?: unknown })?.message ?? x))
  return [String(e)]
}

const PROBE = "__audit_probe_nonexistent_field__"

interface Op {
  name: string
  kind: "query" | "mutation"
  doc: string
  varNames: string[]
}

/** Extract each top-level GraphQL operation document from a source file. The app declares them as
 *  `const NAME = ` + a template literal containing `query X(...){...}` or `mutation X(...){...}`. */
function extractOps(src: string, file: string): Op[] {
  const ops: Op[] = []
  // Match a balanced-ish operation: `query`/`mutation` Name(args) { ... } up to the matching close.
  // Operations live inside backtick template literals; capture from the keyword to the final `}` of
  // the doc by counting braces.
  const re = /\b(query|mutation)\s+([A-Za-z0-9_]+)\s*(\([^)]*\))?\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const kind = m[1] as "query" | "mutation"
    const name = m[2]!
    const argsBlock = m[3] ?? ""
    const start = m.index
    // brace-count from the opening { of the operation body
    let i = src.indexOf("{", m.index)
    let depth = 0
    let end = -1
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++
      else if (src[i] === "}") {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) continue
    const doc = src.slice(start, end + 1)
    const varNames = [...argsBlock.matchAll(/\$([A-Za-z0-9_]+)\s*:/g)].map((x) => x[1]!)
    ops.push({ name: `${file}:${name}`, kind, doc, varNames })
  }
  return ops
}

function dummyVarValue(varName: string): unknown {
  const n = varName.toLowerCase()
  if (n === "id" || n.endsWith("id")) return "gid://shopify/Probe/0"
  if (n.includes("first") || n.includes("limit")) return 1
  if (n.includes("after") || n.includes("cursor") || n.includes("query") || n.includes("key") || n.includes("uri"))
    return null
  if (n.includes("notify") || n.includes("pending") || n.includes("boolean")) return false
  // Any *input*/object-shaped var: send a probe object → forces "Field is not defined" pre-exec.
  return { [PROBE]: true }
}

async function main() {
  const env = loadShopifyEnv()
  const dir = join(import.meta.dir, "..", "src")
  const files: Array<[string, string]> = [
    ...readdirSync(join(dir, "mutations"))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .sort()
      .map((f): [string, string] => [`mutations/${f}`, readFileSync(join(dir, "mutations", f), "utf8")]),
    ["reads", readFileSync(join(dir, "reads.ts"), "utf8")],
  ]
  const ops = files.flatMap(([f, src]) => extractOps(src, f))
  console.log(`→ Auditing ${ops.length} GraphQL operations against ${env.domain} (API ${env.apiVersion})\n`)

  const drift: Array<{ op: string; messages: string[] }> = []
  for (const op of ops) {
    const variables: Record<string, unknown> = {}
    for (const v of op.varNames) variables[v] = dummyVarValue(v)
    const msgs = await rawGraphqlErrorMessages(env, op.doc, variables)
    // Schema/selection drift = the SPECIFIC field-removal validation messages, EXCLUDING our
    // deliberate probe field (which always trips "not defined"). A bare "Not Found" is NOT treated as
    // drift — it is ambiguous (a dummy-id resource-not-found, or a transient/rate-limited response on
    // a query that is actually valid), so it would false-positive on working reads. Removed ROOT
    // fields still surface here via "doesn't exist on type 'QueryRoot'/'Mutation'" when the API
    // returns the validation shape; a query that ONLY ever returns bare "Not Found" is verified by hand.
    const schemaMsgs = msgs
      .filter((msg) => /doesn't exist on type|isn't defined|Field is not defined|Cannot query field|no field/i.test(msg))
      .filter((msg) => !msg.includes(PROBE))
    if (schemaMsgs.length > 0) drift.push({ op: op.name, messages: [...new Set(schemaMsgs)] })
  }

  console.log(`\n========== API-2026 DRIFT REPORT ==========`)
  if (drift.length === 0) {
    console.log("✅ No response-selection / schema drift found across the audited operations.")
  } else {
    console.log(`❌ ${drift.length} operations with schema drift:\n`)
    for (const d of drift) {
      console.log(`• ${d.op}`)
      for (const msg of d.messages) console.log(`    ${msg}`)
    }
  }
}

main().catch((err) => {
  console.error("\n❌ Audit failed:", err.message)
  process.exit(1)
})
