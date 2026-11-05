// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Static check: every testid a guided tour names (beat anchors, phone anchors
 * and every autoplay / phone autoplay step) exists in the web source, so a
 * renamed or deleted testid fails here instead of leaving a tour pointing at
 * nothing. Scans apps/web/src and bundled-apps/<app>/src (test files excluded).
 *
 * A testid counts when it appears as a literal in `data-testid=`, `testid=`,
 * `testId=` or an object key `testid:` / `testId:` / `"data-testid":` (quoted
 * or in a `${}`-free template), or as the prefix of a template whose tail is
 * interpolated (`mention-result-${item.type}` accepts `mention-result-user`). A
 * step's `prefix*` target needs a template whose static head is that prefix.
 *
 * Tier: an element carrying `data-tour-tier="phone"` or `"wide"` renders at
 * that width only. A beat's desktop anchor must not be a phone-only element,
 * and its phone anchor (`anchorPhone`, else `anchor`) must not be a wide-only
 * one, so each beat has something to spotlight at 1280 and at 390.
 *
 * Run: bun run scripts/tour-anchors-check.ts   (exit 1 and the list when missing)
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Glob } from "bun"
import { tourCatalogue } from "../packages/shared/src/tours/index"
import { type Tour, tourTestIds } from "../packages/shared/src/tours/schema"

const ROOT = join(import.meta.dir, "..")

export type TourTier = "phone" | "wide"

export interface TestIdIndex {
  literals: Set<string>
  /** Static heads of interpolated templates (`a-b-${x}` gives `a-b-`). */
  prefixes: Set<string>
  /**
   * Testids that render at one width only: the element carries
   * `data-tour-tier="phone"` (only the 390 shell renders it) or `"wide"` (only
   * desktop and tablet do) next to its literal `data-testid`.
   */
  tierOnly: Map<string, TourTier>
  /**
   * Static heads of interpolated testids whose element renders at one width
   * only (`data-testid={`activity-${id}`}` next to `data-tour-tier="wide"`):
   * every testid with that head is that width's.
   */
  tierPrefixes: Map<string, TourTier>
}

export function emptyIndex(): TestIdIndex {
  return { literals: new Set(), prefixes: new Set(), tierOnly: new Map(), tierPrefixes: new Map() }
}

/** The one width `testid` renders at, or undefined when it renders at both. */
export function tierOf(index: TestIdIndex, testid: string): TourTier | undefined {
  const literal = index.tierOnly.get(testid)
  if (literal) return literal
  let best: { head: string; tier: TourTier } | undefined
  for (const [head, tier] of index.tierPrefixes) {
    if (testid.startsWith(head) && testid.length > head.length) {
      if (!best || head.length > best.head.length) best = { head, tier }
    }
  }
  return best?.tier
}

// A testid prop, or a per-row one built by a function (`rowTestid={(o) => `rows-${o.id}`}`).
const KEY = String.raw`["']?(?:data-testid|testid|testId|[a-z]+Testid)["']?\s*[=:]\s*\{?\s*(?:\(\w*\)\s*=>\s*)?`
const QUOTED = new RegExp(`${KEY}(["'])([^"'\\n]+)\\1`, "g")
const TEMPLATE = new RegExp(`${KEY}\`([^\`]*)\``, "g")
/**
 * A testid built by an expression on its line: a per-row function
 * (`rowTestid={(o) => `rows-${o.id}`}`) or a choice
 * (`id === "memory" ? "profile-memory" : `page-tab-${id}``). Every template
 * and every kebab-case string in it may be the testid.
 */
const EXPRESSION = /["']?(?:data-testid|testid|testId|[a-z]+Testid)["']?\s*=\s*\{([^\n]*)/g
const EXPR_TEMPLATE = /`([^`]*)`/g
const EXPR_QUOTED = /(["'])([a-z0-9]+(?:[-.][a-z0-9]+)+)\1/g

const TIER = /data-tour-tier=(["'])(phone|wide)\1/g
const TESTID_IN_TAG = /data-testid=(["'])([^"'\n]+)\1/
const TEMPLATE_TESTID_IN_TAG = /data-testid=\{\s*`([^`$]*)\$\{/

/** A prefix shorter than this would accept nearly anything. */
const MIN_PREFIX = 3

/** Add every testid literal and template prefix in `src` to `index`. */
export function scanSource(src: string, index: TestIdIndex): void {
  for (const m of src.matchAll(TIER)) {
    // The tier marks the element whose opening tag it sits in.
    const at = m.index ?? 0
    const tag = src.slice(src.lastIndexOf("<", at), at)
    const testid = tag.match(TESTID_IN_TAG)?.[2]
    if (testid) index.tierOnly.set(testid, m[2] as TourTier)
    const head = tag.match(TEMPLATE_TESTID_IN_TAG)?.[1]
    if (!testid && head && head.length >= MIN_PREFIX) index.tierPrefixes.set(head, m[2] as TourTier)
  }
  for (const m of src.matchAll(QUOTED)) {
    const value = m[2]
    if (value) index.literals.add(value)
  }
  const addTemplate = (body: string) => {
    const at = body.indexOf("${")
    if (at === -1) {
      if (body) index.literals.add(body)
    } else if (at >= MIN_PREFIX) {
      index.prefixes.add(body.slice(0, at))
    }
  }
  for (const m of src.matchAll(TEMPLATE)) addTemplate(m[1] ?? "")
  for (const m of src.matchAll(EXPRESSION)) {
    const expr = m[1] ?? ""
    for (const t of expr.matchAll(EXPR_TEMPLATE)) addTemplate(t[1] ?? "")
    for (const q of expr.matchAll(EXPR_QUOTED)) if (q[2]) index.literals.add(q[2])
  }
}

export function hasTestId(index: TestIdIndex, testid: string): boolean {
  // `rows-*` (a step targeting rows keyed by id) needs a template with that head.
  if (testid.endsWith("*")) return index.prefixes.has(testid.slice(0, -1))
  if (index.literals.has(testid)) return true
  for (const prefix of index.prefixes) {
    if (testid.length > prefix.length && testid.startsWith(prefix)) return true
  }
  return false
}

const SOURCE_GLOBS = ["apps/web/src/**/*.{ts,tsx}", "bundled-apps/*/src/**/*.{ts,tsx}"]

/**
 * Components that name their parts `<root>.<part>` from a root prop: the
 * component's source builds each part's testid with `tid("<part>")` (or
 * tid(`<part>-${…}`) for a per-row one), and a page passes the root as
 * `testId="<root>"` on the component's element. Every root a page gives it
 * counts with each of its parts (a task's `task-discussion.composer`, a
 * contact's `contact-discussion.composer`).
 */
const COMPOSED_TESTIDS: Record<string, string> = {
  EntityDiscussion: "apps/web/src/modules/threads/EntityDiscussion.tsx",
}

const TID_PART = /\btid\(\s*(["'`])([^"'`$]*)(\$\{)?/g

/** The parts a composed component names: literals, and heads of per-row templates. */
export function composedParts(src: string): { literals: string[]; prefixes: string[] } {
  const literals: string[] = []
  const prefixes: string[] = []
  for (const m of src.matchAll(TID_PART)) {
    const part = m[2] ?? ""
    if (m[3]) prefixes.push(part)
    else if (part) literals.push(part)
  }
  return { literals, prefixes }
}

/** The literal `testId` roots a source passes to `<component …>` elements. */
export function composedRoots(src: string, component: string): string[] {
  const roots: string[] = []
  const open = new RegExp(`<${component}\\b`, "g")
  for (const m of src.matchAll(open)) {
    const at = m.index ?? 0
    // Up to the element's self-closing end: a prop's arrow (`=>`) is no tag end.
    const end = src.indexOf("/>", at)
    const tag = src.slice(at, end === -1 ? undefined : end)
    const root = tag.match(/\btestId=(["'])([^"'\n]+)\1/)?.[2]
    if (root) roots.push(root)
  }
  return roots
}

/** Add `<root>.<part>` for each root given to a composed component in `sources`. */
export function addComposed(
  index: TestIdIndex,
  component: string,
  componentSrc: string,
  sources: readonly string[],
): void {
  const parts = composedParts(componentSrc)
  for (const src of sources) {
    for (const root of composedRoots(src, component)) {
      for (const part of parts.literals) index.literals.add(`${root}.${part}`)
      for (const head of parts.prefixes) index.prefixes.add(`${root}.${head}`)
    }
  }
}

function isTestFile(path: string): boolean {
  return /\.test\.tsx?$/.test(path) || /(^|\/)tests\//.test(path) || path.includes("__")
}

/** The index of every testid in the web and bundled-app sources. */
export function buildIndex(root: string = ROOT): TestIdIndex {
  const index = emptyIndex()
  const sources: string[] = []
  for (const pattern of SOURCE_GLOBS) {
    for (const rel of new Glob(pattern).scanSync({ cwd: root })) {
      if (isTestFile(rel)) continue
      const src = readFileSync(join(root, rel), "utf8")
      sources.push(src)
      scanSource(src, index)
    }
  }
  for (const [component, rel] of Object.entries(COMPOSED_TESTIDS)) {
    addComposed(index, component, readFileSync(join(root, rel), "utf8"), sources)
  }
  return index
}

export interface MissingAnchor {
  tourId: string
  testid: string
}

export function findMissing(tours: readonly Tour[], index: TestIdIndex): MissingAnchor[] {
  const missing: MissingAnchor[] = []
  for (const tour of tours) {
    for (const testid of tourTestIds(tour)) {
      if (!hasTestId(index, testid)) missing.push({ tourId: tour.id, testid })
    }
  }
  return missing
}

export interface TierMismatch {
  tourId: string
  beatId: string
  testid: string
  /** The width at which the beat's anchor is not rendered. */
  tier: TourTier
}

/**
 * Beats with nothing to spotlight at one of the two widths: the desktop anchor
 * (`anchor`) renders only on the phone, or the phone anchor (`anchorPhone`,
 * else `anchor`) renders only on desktop. "Take me there" then lands on a page
 * where the beat points at nothing.
 */
export function findTierMismatches(tours: readonly Tour[], index: TestIdIndex): TierMismatch[] {
  const out: TierMismatch[] = []
  for (const tour of tours) {
    for (const beat of tour.beats) {
      if (!beat.anchor) continue
      if (tierOf(index, beat.anchor) === "phone") {
        out.push({ tourId: tour.id, beatId: beat.id, testid: beat.anchor, tier: "wide" })
      }
      const phone = beat.anchorPhone ?? beat.anchor
      if (tierOf(index, phone) === "wide") {
        out.push({ tourId: tour.id, beatId: beat.id, testid: phone, tier: "phone" })
      }
    }
  }
  return out
}

if (import.meta.main) {
  const tours = tourCatalogue({ includeTestTours: true })
  const index = buildIndex()
  const missing = findMissing(tours, index)
  const mismatched = findTierMismatches(tours, index)
  if (missing.length > 0) {
    console.error(`Tour anchors missing from the web source (${missing.length}):`)
    for (const m of missing) console.error(`  ${m.tourId}: ${m.testid}`)
  }
  if (mismatched.length > 0) {
    console.error(`Tour beats with no anchor at one width (${mismatched.length}):`)
    for (const m of mismatched) {
      console.error(`  ${m.tourId} ${m.beatId}: ${m.testid} does not render at ${m.tier} width`)
    }
  }
  if (missing.length > 0 || mismatched.length > 0) process.exit(1)
  console.log(`All tour anchors exist (${tours.length} tours).`)
}
