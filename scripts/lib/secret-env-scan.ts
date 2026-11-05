// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The scanner behind scripts/backup-secrets.test.ts: which environment
// variables the product reads, and which of them key a cryptographic call.
// Pure functions over source text, so the guard's own tests can feed it the
// shapes a new key could hide behind.

export interface Source {
  path: string
  text: string
}

/** A variable name that may hold key material or a credential. */
export const SECRET_ISH = /(KEY|SECRET|TOKEN|PASSWORD|_PASS$|SALT|PEPPER|SIGNING)/

/** `process.env.X`, `process.env["X"]`, `Bun.env.X`, `import.meta.env.X`. */
const DIRECT_READ =
  /\b(?:process\.env|Bun\.env|import\.meta\.env)(?:\.([A-Z][A-Z0-9_]*)\b|\[\s*["'`]([A-Z][A-Z0-9_]*)["'`]\s*\])/g

/** `env.X` for a variable of the server's env schema (apps/api/src/lib/env.ts). */
const SCHEMA_READ = /\benv\.([A-Z][A-Z0-9_]*)\b/g

/**
 * A call that consumes key material: node:crypto (createHmac, createCipheriv,
 * createSecretKey, hkdf, pbkdf2, scrypt), WebCrypto (subtle.importKey, sign,
 * encrypt), jose (SignJWT().sign, jwtVerify, CompactEncrypt), and the product's
 * own wrappers (encryptSecret, verifyAccessToken, seal/open helpers).
 */
const KEYED_CALL =
  /\b([A-Za-z_$][\w$]*(?:hmac|cipher|secretkey|secret|hkdf|pbkdf2|scrypt|importkey|sign|verify|encrypt|decrypt|seal|jwt|jws|jwe)[\w$]*|sign|verify|encrypt|decrypt|seal|hkdf|pbkdf2|scrypt|importKey)\s*\(/gi

export function readsIn(text: string, schema: Set<string>): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(DIRECT_READ)) out.add((m[1] ?? m[2]) as string)
  for (const m of text.matchAll(SCHEMA_READ))
    if (schema.has(m[1] as string)) out.add(m[1] as string)
  return out
}

/** Every variable read anywhere in `sources`, with the files that read it. */
export function envReads(sources: Source[], schema: Set<string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const s of sources) {
    for (const v of readsIn(s.text, schema)) {
      const files = out.get(v) ?? new Set<string>()
      files.add(s.path)
      out.set(v, files)
    }
  }
  return out
}

/** Bindings whose value is computed from env reads: `const key = env.X ?? ...`. */
function bindings(text: string, schema: Set<string>, known: Map<string, Set<string>>) {
  const out = new Map(known)
  const decl =
    /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=([\s\S]*?)(?=\n\s*\n|;\s*\n|\n(?:export\s+)?(?:const|let|var|function|async|class)\s)/g
  // Twice, so a binding built from another binding resolves too.
  for (let pass = 0; pass < 2; pass++) {
    for (const m of text.matchAll(decl)) {
      const name = m[1] as string
      const expr = m[2] as string
      const vars = new Set(readsIn(expr, schema))
      for (const [id, idVars] of out) {
        if (id !== name && new RegExp(`\\b${id.replace(/\$/g, "\\$")}\\b`).test(expr))
          for (const v of idVars) vars.add(v)
      }
      if (vars.size > 0) out.set(name, vars)
    }
  }
  return out
}

/** The text of each argument list of a keyed call, parens balanced. */
function keyedArgs(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(KEYED_CALL)) {
    let depth = 1
    let i = (m.index ?? 0) + m[0].length
    const start = i
    while (i < text.length && depth > 0) {
      if (text[i] === "(") depth++
      else if (text[i] === ")") depth--
      i++
    }
    out.push(text.slice(start, i - 1))
  }
  return out
}

/**
 * Variables whose value reaches a keyed call, directly or through a binding in
 * the same file or an exported binding of `shared` (env.ts aliases such as
 * `byokEncryptionKey`). Only secret-ish variables count: a binding that also
 * reads NODE_ENV to pick a fallback does not make NODE_ENV a key.
 */
export function keyingVars(
  sources: Source[],
  schema: Set<string>,
  shared: Source[] = [],
): Map<string, Set<string>> {
  let exported = new Map<string, Set<string>>()
  for (const s of shared) exported = bindings(s.text, schema, exported)
  const out = new Map<string, Set<string>>()
  for (const s of sources) {
    const local = bindings(s.text, schema, exported)
    for (const args of keyedArgs(s.text)) {
      const vars = new Set(readsIn(args, schema))
      for (const [id, idVars] of local) {
        if (new RegExp(`\\b${id.replace(/\$/g, "\\$")}\\b`).test(args))
          for (const v of idVars) vars.add(v)
      }
      for (const v of vars) {
        if (!SECRET_ISH.test(v)) continue
        const files = out.get(v) ?? new Set<string>()
        files.add(s.path)
        out.set(v, files)
      }
    }
  }
  return out
}

export interface Classes {
  /** Keys stored data needs (deploy/backup.sh DATA_SECRETS_*). */
  data: Set<string>
  /** Carried configuration (deploy/backup.sh CARRIED_CONFIG). */
  config: Set<string>
  /** Per-host settings, name -> reason. */
  host: Record<string, string>
  /** Not deployment configuration at all (tests, dev tools), name -> reason. */
  allow: Record<string, string>
  /** Keyed but never protecting stored data (a live token compared per request), name -> reason.
   *  A carried configuration variable passes the keyed rule too: it travels anyway. */
  keyedNotStored: Record<string, string>
}

export interface Findings {
  unclassified: string[]
  keyedNotCarried: string[]
}

export function classify(
  sources: Source[],
  schema: Set<string>,
  shared: Source[],
  c: Classes,
): Findings {
  const names = new Set<string>([...schema, ...envReads(sources, schema).keys()])
  const known = (v: string) => c.data.has(v) || c.config.has(v) || v in c.host || v in c.allow
  const unclassified = [...names].filter((v) => SECRET_ISH.test(v) && !known(v)).sort()
  const keyedNotCarried = [...keyingVars(sources, schema, shared).keys()]
    .filter((v) => !c.data.has(v) && !c.config.has(v) && !(v in c.keyedNotStored))
    .sort()
  return { unclassified, keyedNotCarried }
}
