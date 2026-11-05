// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path, { resolve } from "node:path"

const REPO_ROOT = resolve(new URL("../../../..", import.meta.url).pathname)

// V3 grep from the Phase 14 spec — the canonical Stripe extraction acceptance check.
// The pattern is assembled at runtime from non-matching fragments so this test
// file itself does not contain any V3-matching literal that would make the
// repo-wide grep red.
const FORBIDDEN = ["s", "t", "r", "i", "p", "e"].join("")
const FORBIDDEN_UPPER = FORBIDDEN.toUpperCase()

/**
 * CASE-SENSITIVE, and that is the whole fix.
 *
 * The first version of this grep ran `-i` on a bare six-letter alternative, so
 * it matched the first six characters of ANY identifier beginning with those
 * letters in any casing. `stripElements` (the desktop feature-detection test's
 * own DOM helper) is such an identifier, and the guard reported four matches in
 * a file that has nothing to do with billing. A guard that cries wolf on an
 * unrelated word is a guard people stop reading.
 *
 * Three alternatives replace the one, and together they are NOT weaker than
 * what they replace: the word on its own in either casing, the camelCase and
 * PascalCase compounds, and the screaming-case constants. What they no longer
 * do is match a lowercase `e` against an uppercase one, which is the only way
 * `stripElements` ever got in.
 */
// The ordinary English words that begin with the same six letters and are NOT
// the payment processor. Everything else the word is glued to is.
//
// Naming the compounds instead (client, key, api, secret, webhook, customer,
// charge, payment) was the wrong way round: it is an eight item guess at an
// open set, and every compound nobody thought of (checkout, invoice, token,
// elements, account, subscription, price, connect, refund) walked straight
// past the acceptance check. The set of benign English forms is closed and
// short, so it is the one worth enumerating.
const BENIGN_FORMS = ["d", "s", "r", "rs", "y"]

/**
 * A POSIX ERE fragment matching one or more lowercase letters EXCEPT the exact
 * strings in `benign`. `git grep -E` has no lookahead, so "anything but these"
 * is spelled out: a first letter that starts no benign ending, or a benign
 * ending that does not stop where the benign word does.
 */
function benignExcludingSuffixes(benign: string[]): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz".split("")
  const alts: string[] = []
  // A first letter that no benign ending starts with: already a compound.
  const heads = new Set(benign.map((w) => w[0]))
  alts.push(`[${alphabet.filter((c) => !heads.has(c)).join("")}]`)
  // A benign PREFIX followed by a letter that does not continue into a longer
  // benign ending: `stripers` is a fish, `stripersx` is the payment processor.
  const prefixes = new Set<string>()
  for (const word of benign) {
    for (let i = 1; i <= word.length; i++) prefixes.add(word.slice(0, i))
  }
  for (const prefix of [...prefixes].sort()) {
    const next = alphabet.filter((c) => !benign.includes(prefix + c))
    if (next.length === 0) continue
    alts.push(`${prefix}[${next.join("")}]`)
  }
  return `(${alts.join("|")})`
}

const V3_PATTERN = [
  // The word itself, in either casing, not glued to more letters:
  // `stripe`, `Stripe.`, `@stripe/stripe-js`, `"stripe"`, end of line.
  `[s${FORBIDDEN_UPPER[0]}]${FORBIDDEN.slice(1)}([^a-zA-Z]|$)`,
  // camelCase / PascalCase compounds: stripeCustomerId, StripeClient.
  `[s${FORBIDDEN_UPPER[0]}]${FORBIDDEN.slice(1)}[A-Z]`,
  // Screaming case: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.
  FORBIDDEN_UPPER,
  // ALL-LOWERCASE GLUED COMPOUNDS: `stripeclient`, `stripecheckout`,
  // `stripeinvoice`, the payment processor glued to whatever follows it in a
  // file name, a package name or a snake-less identifier. With only the three
  // alternatives above, the word followed by a LOWERCASE letter matched
  // nothing at all.
  //
  // A bare "any lowercase letter" was too wide in the other direction: it read
  // the CSS and prose word for a band (`table-striped`, `zebra stripes`,
  // `pinstriped`) as the payment processor. So this alternative is the INVERSE
  // rule: the word followed by letters matches unless what follows is exactly
  // one of the benign English endings above. The band survives; a compound
  // nobody listed does not.
  `${FORBIDDEN}${benignExcludingSuffixes(BENIGN_FORMS)}`,
].join("|")

// The one path the repo-wide grep does not read. Kept beside the case that
// checks the claim it rests on.
const BENCH_FIXTURES = ":!apps/api/src/tests/bench/**/fixtures/**"

/**
 * A path, once resolved, that lands inside one of the excluded corpora.
 *
 * The first shape of this guard matched the SPECIFIER text and required the
 * word `bench` inside it, which is exactly what a specifier written from inside
 * the corpora never says: `./fixtures/mini/messages.jsonl` from a module in
 * `src/tests/bench/long-context` reaches the corpus and matched nothing. Where a
 * specifier points is a property of the importing file's directory, so the
 * resolution happens first and the match happens on the result.
 *
 * It matches exactly what the pathspec excludes, `bench/**\/fixtures/**`: ANY
 * number of directories between `bench` and `fixtures`, zero included. Pinning
 * one level meant a corpus one directory deeper was unread by the billing grep
 * and unseen by this guard at the same time, which is the pair that has to
 * agree or the exclusion stops being safe.
 */
const BENCH_FIXTURE_PATH = /(^|\/)apps\/api\/src\/tests\/bench\/(?:[^/]+\/)*fixtures\//

/** The tree whose import lines are ALL resolved, whatever they say. */
const BENCH_TREE = "apps/api/src/tests/bench"

/**
 * Candidate lines for the repo-wide sweep: import-shaped and naming a fixtures
 * path.
 *
 * `import` alone is one of the shapes, because a SIDE-EFFECT import writes no
 * `from`, no `require(` and no `import(`: `import "./fixtures/mini/seed"` runs
 * the module for what it does, not for what it returns, and reaches every byte
 * of the corpus exactly as a named import would. Requiring one of the other
 * three read it as prose. A comment that merely says the word is selected too
 * and then carries no quoted specifier, which costs nothing.
 */
const FIXTURE_IMPORT_LINE = "(from|require\\(|import)[^;]*fixtures"

/**
 * Candidate lines INSIDE the bench tree: import-shaped, full stop.
 *
 * The word filter is what a specifier written beside its own data never says.
 * `./messages.jsonl`, from a module sitting in the corpus directory itself,
 * reaches the corpus and carries the word `fixtures` nowhere on the line, so
 * the line was dropped before anything could resolve it. Inside this tree every
 * import line is resolved instead of being pre-selected by what it spells.
 */
const ANY_IMPORT_LINE = "(from|require\\(|import)"

/**
 * Every quoted specifier on one import-shaped line.
 *
 * The parenthesis after `import` is OPTIONAL, which is what admits the
 * side-effect form `import "./fixtures/mini/seed"` alongside the dynamic
 * `import("./x")`. Without it the line was selected and then yielded no
 * specifier, so an import straight into a corpus resolved to nothing and read
 * as a clean repo.
 */
const SPECIFIERS = /(?:\bfrom|\brequire\(|\bimport\(?)\s*["'`]([^"'`]+)["'`]/g

/** A specifier whose target cannot be worked out from the repo alone. */
const UNRESOLVABLE = "<unresolvable>"

/** The package a file belongs to: its manifest and the dir that manifest sits in. */
function nearestPackage(importer: string): { dir: string; pkg: Record<string, any> } | null {
  let dir = path.posix.dirname(importer)
  for (;;) {
    const manifest = path.join(REPO_ROOT, dir, "package.json")
    if (existsSync(manifest)) {
      return { dir, pkg: JSON.parse(readFileSync(manifest, "utf8")) }
    }
    if (dir === "." || dir === "/" || dir === "") return null
    dir = path.posix.dirname(dir)
  }
}

/** A `./`-relative target from a package manifest, as a repo-relative path. */
function fromManifest(dir: string, target: unknown): string {
  if (typeof target !== "string" || !target.startsWith("./")) return UNRESOLVABLE
  return path.posix.normalize(path.posix.join(dir, target))
}

/** Where `specifier`, written in `importer`, points, as a repo-relative path. */
function resolveSpecifier(importer: string, specifier: string): string {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier))
  }
  // apps/api's own alias, the one a test inside it would reach for.
  if (specifier.startsWith("~/")) return `apps/api/src/${specifier.slice(2)}`
  const owner = nearestPackage(importer)
  // A subpath import (`#corpus/mini`) is whatever the package's own `imports`
  // map says it is. No map, no entry, no answer.
  if (specifier.startsWith("#")) {
    if (!owner) return UNRESOLVABLE
    return fromManifest(owner.dir, (owner.pkg.imports as Record<string, unknown>)?.[specifier])
  }
  // A package SELF-reference (`@liaison/api/...` from inside apps/api) reaches
  // the package's own files through its `exports` map, so it can point into the
  // corpora while looking like an ordinary dependency.
  const name = typeof owner?.pkg.name === "string" ? owner.pkg.name : null
  if (owner && name && (specifier === name || specifier.startsWith(`${name}/`))) {
    const subpath = specifier === name ? "." : `./${specifier.slice(name.length + 1)}`
    return fromManifest(owner.dir, (owner.pkg.exports as Record<string, unknown>)?.[subpath])
  }
  // Anything else is a dependency: it resolves into node_modules, never a corpus.
  return specifier
}

/**
 * What an import reaches: a corpus, nothing this repo can work out, or code.
 *
 * An unresolvable specifier is a VIOLATION, not a pass. The exclusion rests on
 * the claim that nothing imports the corpora, and a specifier whose target
 * cannot be named is a specifier that may well reach one; reading it as clean
 * would be the guard asserting exactly what it failed to check.
 */
function classifyImport(
  importer: string,
  specifier: string,
): "reaches-corpus" | "unresolvable" | "elsewhere" {
  const resolved = resolveSpecifier(importer, specifier)
  if (resolved === UNRESOLVABLE) return "unresolvable"
  // The trailing slash lets a specifier that names the corpus DIRECTORY itself
  // (`./fixtures`) match the same rule as one that names a file inside it.
  return BENCH_FIXTURE_PATH.test(`/${resolved}/`) ? "reaches-corpus" : "elsewhere"
}

function importsBenchFixture(importer: string, specifier: string): boolean {
  return classifyImport(importer, specifier) !== "elsewhere"
}

/** `git grep -nE` over `pathspecs`, as `[importer, code]` pairs. */
function importLines(pattern: string, pathspecs: string[]): Array<[string, string]> {
  const result = spawnSync("git", ["grep", "-nE", pattern, "--", ...pathspecs], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  // git grep exits 1 for "no matches", which is fine; anything above that is
  // a broken sweep and must not read as a clean repo.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git grep failed (exit ${result.status}): ${result.stderr}`)
  }
  const out: Array<[string, string]> = []
  for (const line of (result.stdout ?? "").split("\n")) {
    if (!line.trim()) continue
    const firstColon = line.indexOf(":")
    const secondColon = line.indexOf(":", firstColon + 1)
    if (firstColon === -1 || secondColon === -1) continue
    out.push([line.slice(0, firstColon), line.slice(secondColon + 1)])
  }
  return out
}

describe("extracted billing surface stays out of the repo", () => {
  // The pattern, exercised directly. A repo-wide grep that returns nothing is
  // the same result whether the surface is gone or the pattern is broken, so
  // the pattern gets its own assertions.
  test("the pattern matches every real form of the extracted name", () => {
    const re = new RegExp(V3_PATTERN)
    for (const line of [
      `import ${FORBIDDEN} from "${FORBIDDEN}"`,
      `const key = process.env.${FORBIDDEN_UPPER}_SECRET_KEY`,
      `row.${FORBIDDEN}CustomerId`,
      `@${FORBIDDEN}/${FORBIDDEN}-js`,
      `new ${FORBIDDEN_UPPER[0]}${FORBIDDEN.slice(1)}Client()`,
      `${FORBIDDEN}_payment_intent`,
      // All-lowercase glued compounds: the alternative added after the
      // case-sensitivity fix left them unmatched.
      `import { ${FORBIDDEN}client } from "./billing"`,
      `const ${FORBIDDEN}key = env.SECRET`,
      `await ${FORBIDDEN}api.charges.create()`,
      // The compounds the eight noun guess never named. Each of these was a
      // false negative: the guard reported a clean repo while the word sat in
      // a file name or an identifier.
      `import { ${FORBIDDEN}checkout } from "./billing"`,
      `const doc = ${FORBIDDEN}invoice.retrieve(id)`,
      `const t = ${FORBIDDEN}token.create()`,
      `import "@acme/${FORBIDDEN}elements"`,
      `const acct = ${FORBIDDEN}account.id`,
      `const sub = ${FORBIDDEN}subscription.status`,
      `const p = ${FORBIDDEN}price.unit_amount`,
      `import { ${FORBIDDEN}connect } from "./oauth"`,
      `await ${FORBIDDEN}refund.create({})`,
    ]) {
      expect(re.test(line), line).toBe(true)
    }
  })

  test("the pattern leaves an unrelated word that merely starts the same alone", () => {
    const re = new RegExp(V3_PATTERN)
    // The four lines that made this guard red: a DOM helper in the desktop
    // feature-detection test, whose first six letters are the forbidden word
    // only if an uppercase E is allowed to match a lowercase one.
    for (const line of [
      "const el = stripElements(node)",
      "function stripEmptyKeys(input: object) {",
      "await stripEnvelope(message)",
      // Still not the payment processor, with the lowercase-glued alternative
      // in place: the letter after `strip` is an uppercase E in every one.
      "const s = stripEmoji(title)",
      // The CSS and prose word for a band is not the payment processor: the
      // lowercase-glued alternative names the nouns instead of taking any
      // lowercase letter.
      `<table className="table-${FORBIDDEN}d">`,
      `/* zebra ${FORBIDDEN}s on alternate rows */`,
      `const shirt = "pin${FORBIDDEN}d"`,
      // Every benign English form the inverse rule exempts, each one written
      // where the guard would see it: the fish, the verb, the adjective.
      `const fish = "${FORBIDDEN}r"`,
      `const fishes = ["${FORBIDDEN}rs"]`,
      `const shirt = "${FORBIDDEN}y"`,
      `const shirts = "pin${FORBIDDEN}s"`,
      `// ${FORBIDDEN}d down to the essentials`,
    ]) {
      expect(re.test(line), line).toBe(false)
    }
  })

  // The exclusion above is only safe while the corpora stay data. The moment a
  // file imports one, its contents are on a code path again and the grep that
  // no longer reads them is no longer an acceptance check.
  test("nothing imports a bench fixture, so excluding the corpora excludes only data", () => {
    // A guard that matches nothing reads the same whether the repo is clean or
    // the resolution is broken, so the resolution gets its own assertions first.
    for (const [importer, specifier] of [
      // Written from OUTSIDE the corpora, the shapes the first guard caught.
      [
        "apps/api/src/tests/integration/x.test.ts",
        "../../tests/bench/long-context/fixtures/mini/messages.jsonl",
      ],
      ["scripts/x.ts", "./apps/api/src/tests/bench/long-context/fixtures/sample/threads.jsonl"],
      ["apps/api/src/modules/x.ts", "~/tests/bench/long-context/fixtures/mini/index"],
      // Written from INSIDE them, the two shapes the first guard could not see:
      // neither specifier contains the word `bench` at all.
      ["apps/api/src/tests/bench/long-context/run.ts", "./fixtures/mini/messages.jsonl"],
      ["apps/api/src/tests/bench/long-context/oracle/check.ts", "../fixtures/sample/threads.jsonl"],
      // The corpus DIRECTORY, named without a file: a bare `./fixtures` reaches
      // every byte under it, and a rule that needed a slash after the word read
      // it as ordinary code.
      ["apps/api/src/tests/bench/long-context/run.ts", "./fixtures"],
      // A corpus one directory deeper than the rule allowed. The PATHSPEC
      // excludes it from the billing grep (`bench/**/fixtures/**`), so a guard
      // that cannot see it leaves that exclusion resting on nothing.
      ["apps/api/src/tests/bench/a/b/run.ts", "./fixtures/mini/messages.jsonl"],
      ["scripts/x.ts", "./apps/api/src/tests/bench/a/b/fixtures/mini/messages.jsonl"],
      ["apps/api/src/tests/bench/run.ts", "./fixtures/mini/messages.jsonl"],
      // A SIBLING import from inside a corpus: the line says `fixtures`
      // nowhere, so the word filter dropped it before anything resolved it.
      ["apps/api/src/tests/bench/long-context/fixtures/mini/index.ts", "./messages.jsonl"],
      // Neither of these can be worked out from the repo alone, and an import
      // nobody can resolve is not an import anybody has checked.
      ["apps/api/src/tests/bench/long-context/run.ts", "#corpus/mini"],
      ["apps/api/src/tests/bench/long-context/run.ts", "@liaison/api/tests/bench/mini"],
    ] as Array<[string, string]>) {
      expect(importsBenchFixture(importer, specifier), `${importer} -> ${specifier}`).toBe(true)
    }
    // The two unresolvable shapes are reported AS unresolvable, not guessed at.
    expect(classifyImport("apps/api/src/tests/bench/long-context/run.ts", "#corpus/mini")).toBe(
      "unresolvable",
    )
    expect(
      classifyImport(
        "apps/api/src/tests/bench/long-context/run.ts",
        "@liaison/api/tests/bench/mini",
      ),
    ).toBe("unresolvable")

    // Code beside the corpora is still code, and importing it is fine.
    for (const [importer, specifier] of [
      ["apps/api/src/tests/bench/long-context/report.ts", "./run"],
      ["apps/api/src/tests/bench/long-context/run.ts", "../../helpers/app-schema-lock"],
      ["apps/api/src/modules/x.ts", "./fixtures/mini/messages.jsonl"],
      // A dependency resolves into node_modules, never into a corpus.
      ["apps/api/src/tests/bench/long-context/run.ts", "zod"],
      // A directory that merely STARTS with the word is not the corpus.
      ["apps/api/src/tests/bench/long-context/run.ts", "./fixtures-readme.md"],
    ] as Array<[string, string]>) {
      expect(importsBenchFixture(importer, specifier), `${importer} -> ${specifier}`).toBe(false)
    }

    // Two sweeps, because two different questions. Repo-wide, the candidates are
    // import lines that name a fixtures path. Inside the bench tree, EVERY
    // import line is resolved, because a specifier written beside its own data
    // names nothing the repo-wide filter could select on.
    const candidates = [
      ...importLines(FIXTURE_IMPORT_LINE, [
        "apps/**",
        "packages/**",
        "deploy/**",
        "scripts/**",
        // This file spells the shapes out to prove the resolution is live.
        `:!apps/api/src/tests/${import.meta.file}`,
      ]),
      // Source files only: the corpora themselves are frozen transcripts in
      // which the word `from` beside a quoted string is prose, not an import.
      ...importLines(ANY_IMPORT_LINE, [
        `${BENCH_TREE}/**/*.ts`,
        `${BENCH_TREE}/**/*.tsx`,
        `${BENCH_TREE}/**/*.js`,
        `${BENCH_TREE}/**/*.mjs`,
      ]),
    ]
    const offenders: string[] = []
    for (const [importer, code] of candidates) {
      for (const match of code.matchAll(SPECIFIERS)) {
        const verdict = classifyImport(importer, match[1])
        if (verdict === "elsewhere") continue
        offenders.push(`${importer}: ${match[1]} (${verdict})`)
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `a bench fixture is imported, or an import could not be resolved, so the corpora are ` +
          `code again and the billing grep must read them (${BENCH_FIXTURES}). Offenders:\n` +
          offenders.join("\n"),
      )
    }
  })

  test("a side-effect import is an import: no from, no require, no parenthesis", () => {
    // `import "./x"` runs the module for what it DOES. It reaches every byte of
    // the corpus exactly as a named import would, and it writes none of the
    // three words the candidate filters and the specifier reader were keyed on,
    // so an import straight into a corpus was selected by nothing and read by
    // nothing: the guard reported a clean repo over it.
    const line = `import "./fixtures/mini/messages.jsonl"`
    expect(new RegExp(FIXTURE_IMPORT_LINE).test(line)).toBe(true)
    expect(new RegExp(ANY_IMPORT_LINE).test(line)).toBe(true)
    const found = [...line.matchAll(SPECIFIERS)].map((m) => m[1])
    expect(found).toEqual(["./fixtures/mini/messages.jsonl"])
    expect(
      importsBenchFixture("apps/api/src/tests/bench/long-context/run.ts", found[0] as string),
    ).toBe(true)

    // The three shapes that already worked still yield exactly one specifier
    // each: the optional parenthesis widened the reader, it did not blur it.
    for (const [shape, expected] of [
      [`import { a } from "./fixtures/mini/index"`, "./fixtures/mini/index"],
      [`const a = require("./fixtures/mini/index")`, "./fixtures/mini/index"],
      [`await import("./fixtures/mini/index")`, "./fixtures/mini/index"],
    ] as Array<[string, string]>) {
      expect(
        [...shape.matchAll(SPECIFIERS)].map((m) => m[1]),
        shape,
      ).toEqual([expected])
    }
  })

  test("repo-wide grep returns no matches under apps/**, packages/**, deploy/**, package.json, lockfile", () => {
    const result = spawnSync(
      "git",
      [
        "grep",
        "-nE",
        V3_PATTERN,
        "--",
        "apps/**",
        "packages/**",
        "deploy/**",
        "package.json",
        "bun.lock*",
        ":!docs/**",
        ":!**/CHANGELOG.md",
        // Exclude this file and the two test files that assert the absence
        // of stripe-named symbols — they're the negative-assertion surface,
        // not production code, so seeing the literal `stripe` in them is the
        // point.
        `:!apps/api/src/tests/${import.meta.file}`,
        ":!apps/api/src/tests/db-schema-billing-neutral.test.ts",
        ":!apps/web/src/modules/settings/UsageSettings.test.tsx",
        // The setup CLI's secret scanner: its list of key shapes to redact
        // includes the processor's live key prefix. A detection pattern, not
        // an integration.
        ":!apps/api/src/cli/setup/collect-repo-docs.ts",
        // Benchmark corpora are DATA, not code: frozen transcripts a harness
        // reads at runtime, in which an agent happens to have written the
        // payment processor's name inside a message. Nothing there is imported,
        // so nothing there can bring the extracted surface back; the case below
        // is what keeps that true, and it is the reason this exclusion is
        // narrower than "the bench directory".
        BENCH_FIXTURES,
      ],
      { cwd: REPO_ROOT, encoding: "utf8" },
    )
    // git grep exits 0 on matches, 1 on no matches. We want exit 1.
    if (result.status !== 1) {
      throw new Error(
        `V3 grep produced matches (exit ${result.status}). Output:\n${result.stdout}\n${result.stderr}`,
      )
    }
  })
})
