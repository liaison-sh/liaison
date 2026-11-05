// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The attention feed's section count line ("1 ticket assigned") names the KIND
// of the rows it counts, through `kernel.homeKind.<kind>.<one|other>`. A kind
// with no catalog entry falls back to the English literal table in
// `attention-groups.ts`, which no locale can reach: a French reader got
// "1 ticket assigned" under ASSISTANCE because `ticket_assigned` had no entry.
//
// One missing entry is one untranslated line, so the guard is not a list of
// the kinds someone remembered: it ENUMERATES every kind the product can put
// in the feed, from the sources that declare them, and requires a singular and
// a plural in BOTH shipped locales.
//
// Out of scope by design: app-manifest kinds (`shopify:orders.unfulfilled`,
// `invoicing:pdf.failed`). Those arrive with a manifest-supplied English
// summary that no catalog translates either, so `kindShortLabel` falls back to
// the bare segment on purpose. `manifestKinds` is still collected below, to
// assert the scan reaches the manifests at all.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import en from "../../../../../packages/shared/src/i18n/locales/en/kernel.json"
import fr from "../../../../../packages/shared/src/i18n/locales/fr/kernel.json"

const REPO = join(import.meta.dirname, "../../../../..")

function readIfPresent(path: string): string {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return ""
  }
}

/** The `AttentionKind` union: the kinds the kernel's own types admit. The
 *  union is derived from the runtime `ATTENTION_KINDS` list, so the list is
 *  what is read. */
function unionKinds(): string[] {
  const src = readIfPresent(join(REPO, "packages/shared/src/types/attention.ts"))
  const body = src.slice(src.indexOf("export const ATTENTION_KINDS = ["))
  const end = body.indexOf("] as const")
  return [...body.slice(0, end).matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string)
}

/** Kinds written by the attention providers and the kernel's own translations.
 *  Only the files that BUILD attention rows are read (`attention.ts` per app,
 *  `kernel-translations.ts`): `kind:` is a common property name and a wider
 *  sweep collects inbox kinds, source kinds and message kinds that never reach
 *  the feed. Inside those files, `kind: "field" | "participants" | ...` is a
 *  recipient spec rather than a feed kind, and a kind carrying a colon is an
 *  app manifest kind (see the header). */
function providerKinds(): string[] {
  const roots = [
    join(REPO, "apps/api/src/apps"),
    join(REPO, "bundled-apps"),
    join(REPO, "apps/api/src/modules"),
  ]
  const files: string[] = []
  for (const root of roots) {
    let apps: string[]
    try {
      apps = readdirSync(root)
    } catch {
      continue
    }
    for (const app of apps) {
      for (const rel of ["attention.ts", "src/attention.ts", "kernel-translations.ts"]) {
        const path = join(root, app, rel)
        try {
          if (statSync(path).isFile()) files.push(path)
        } catch {
          // not every app declares attention rows
        }
      }
    }
  }
  const found = new Set<string>()
  for (const path of files) {
    const src = readFileSync(path, "utf8")
    for (const m of src.matchAll(/\bkind:\s*"([a-z][a-z_]+)"/g)) found.add(m[1] as string)
  }
  for (const spec of ["field", "participants", "mentions", "scope_holders", "actor"]) {
    found.delete(spec)
  }
  return [...found]
}

/** Kinds the standard (QA) world seeds into the feed. A seeded org reads the same Home.
 *  Only the `QA_ATTENTION` block counts: the same file seeds routines, whose `kind:`
 *  ("recurring", "scheduled") is a routine type, not a feed kind. */
function fixtureKinds(
  src: string = readIfPresent(join(REPO, "apps/api/src/seed/world/qa.ts")),
): string[] {
  // A moved or renamed block must fail the scan, not pass it with no kinds.
  const start = src.indexOf("export const QA_ATTENTION")
  if (start < 0) throw new Error("QA_ATTENTION block not found in apps/api/src/seed/world/qa.ts")
  const end = src.indexOf("\n]", start)
  if (end < 0) throw new Error("QA_ATTENTION block has no closing bracket")
  const kinds = [...src.slice(start, end).matchAll(/\bkind:\s*"([a-z][a-z_]+)"/g)].map(
    (m) => m[1] as string,
  )
  if (kinds.length === 0) throw new Error("QA_ATTENTION block declares no kinds")
  return kinds
}

/** `<app>:<thing>.<state>` kinds declared by app manifests. */
function manifestKinds(): string[] {
  const roots = [join(REPO, "bundled-apps"), join(REPO, "apps/api/src/apps")]
  const found = new Set<string>()
  for (const root of roots) {
    let apps: string[]
    try {
      apps = readdirSync(root)
    } catch {
      continue
    }
    for (const app of apps) {
      const raw = readIfPresent(join(root, app, "app.manifest.json"))
      if (!raw) continue
      const parsed = JSON.parse(raw) as {
        attention?: { translations?: Array<{ kind?: string }> }
      }
      for (const t of parsed.attention?.translations ?? []) {
        if (t.kind?.includes(":")) found.add(t.kind)
      }
    }
  }
  return [...found]
}

function catalogKinds(): string[] {
  const required = new Set<string>([...unionKinds(), ...providerKinds(), ...fixtureKinds()])
  return [...required].sort()
}

describe("attention feed kind catalog", () => {
  test("the scan actually finds the kinds it claims to enumerate", () => {
    expect(unionKinds()).toContain("dm_window_closing")
    expect(providerKinds()).toContain("sla_risk")
    expect(providerKinds()).not.toContain("scope_holders")
    expect(fixtureKinds()).toContain("ticket_assigned")
    expect(() => fixtureKinds("")).toThrow(/QA_ATTENTION/)
    expect(() => fixtureKinds("export const QA_ATTENTION = [\n]")).toThrow(/no kinds/)
    expect(manifestKinds().length).toBeGreaterThan(0)
    expect(catalogKinds().length).toBeGreaterThan(15)
  })

  test("every kind the feed can produce has a singular and a plural, in both locales", () => {
    const dicts = { en, fr } as Record<string, { homeKind?: Record<string, unknown> }>
    const missing: string[] = []
    for (const kind of catalogKinds()) {
      for (const locale of ["en", "fr"]) {
        const forms = dicts[locale]?.homeKind?.[kind] as
          | { one?: unknown; other?: unknown }
          | undefined
        if (typeof forms?.one !== "string" || typeof forms?.other !== "string") {
          missing.push(`${locale}:${kind}`)
        }
      }
    }
    expect(missing).toEqual([])
  })
})
