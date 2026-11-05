// SPDX-License-Identifier: FSL-1.1-ALv2
// Standing attention-RESOLUTION oracle (gestalt contract).
//
// The regression class it pins: an attention row is a FROZEN SNAPSHOT. The
// translator renders its summary once, at event time, writes it to
// kernel.attention_events, and never revisits it. A row therefore only ever
// leaves the feed two ways: a human clicks "Read", or the app declares a
// `resolveWhen` translation and emits the resolving event.
//
// When this oracle was written, 18 of 21 shipped translations declared NO
// resolution. The live feed consequently kept asserting state the apps had long
// since left: "New order #3330 (172.00 USD)" for an order shipped a week
// earlier, "Return requested" for a return already closed, "16 days past due"
// for an invoice already paid. Every one of those reads as a broken product
// even though each individual number was correct at the instant it was frozen
// (field report 2026-08-03: "all the collapsed items do not refresh properly
// according to the app's current state").
//
// So: any translation whose KIND describes a TRANSIENT condition -- something
// the app itself later ends -- must have a resolving counterpart. A kind that
// describes a permanent fact (a refund happened, a number was skipped) is a
// notification and legitimately has none.
//
// Adding a transient kind with no resolver is the finding. Fix it by declaring
// the resolving translation, or, if the kind really is a permanent record, add
// it to PERMANENT_KINDS below WITH a reason.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "../../../../..")
const MANIFEST_ROOTS = [resolve(REPO_ROOT, "apps/api/src/apps"), resolve(REPO_ROOT, "bundled-apps")]

interface Translation {
  event: string
  kind: string
  resolveWhen?: { always?: true; field?: string; equals?: unknown }
}

function findManifests(root: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry)
    if (!statSync(dir).isDirectory()) continue
    const manifest = join(dir, "app.manifest.json")
    try {
      if (statSync(manifest).isFile()) out.push(manifest)
    } catch {
      /* app without a manifest */
    }
  }
  return out
}

/**
 * Kinds that describe a PERMANENT record rather than a live condition. These
 * are FYIs: nothing the app does later makes them untrue, so there is nothing
 * to resolve and the operator dismisses them with "Read". Every entry needs a
 * reason — this list is the documented exception surface, not a mute button.
 */
const PERMANENT_KINDS: Record<string, string> = {
  "shopify:refund.created":
    "A manual refund HAPPENED. The event records a completed fact; nothing later un-refunds it.",
  "invoicing:numbering.skipped":
    "A number was skipped in the sequence. A permanent ledger anomaly, kept until acknowledged.",
  "invoicing:two_eyes_violated":
    "A four-eyes control was bypassed. An audit record; acknowledging it is the only closure.",
  "invoicing:order.cancelled": "The order WAS cancelled. Terminal by construction.",
  "invoicing:order.edited":
    "The order WAS edited downstream of its invoice. A reconciliation prompt about a past change.",
  "invoicing:contact.conflict":
    "Two contacts collide on the same identity. Resolved by a human merge, which has no event to key on; revisit if a merge event is ever emitted.",
  "invoicing:event.deferred":
    "An inbound event was parked for later replay. The deferred queue is its own surface.",
  "invoicing:customs.gap":
    "A shipped invoice lacked customs data. A historical compliance gap, not a live condition.",
  "invoicing:pdf.failed":
    "A PDF render failed. Retried via the documents surface; no success event is emitted to key on.",
  "invoicing:email.failed":
    "An outbound email failed. Same shape as pdf.failed: retry lives on the document, no success event.",
}

/**
 * A kind is TRANSIENT when its own words describe a state the app can leave.
 * Deliberately word-based rather than a hardcoded allow-list, so a NEW kind is
 * caught by default (fail closed) instead of slipping through unlisted.
 */
const TRANSIENT_MARKERS = [
  "pending",
  "requested",
  "overdue",
  "unfulfilled",
  "created",
  "awaiting",
  "stale",
  "risk",
  "due",
  "open",
]

function isTransientKind(kind: string): boolean {
  const tail = kind.slice(kind.indexOf(":") + 1).toLowerCase()
  return TRANSIENT_MARKERS.some((m) => tail.includes(m))
}

function hasResolution(t: Translation): boolean {
  const r = t.resolveWhen
  if (!r) return false
  return r.always === true || typeof r.field === "string"
}

describe("every transient attention kind declares a resolution", () => {
  const manifests = MANIFEST_ROOTS.flatMap(findManifests)

  it("finds the manifest corpus (guards against a silent glob regression)", () => {
    expect(manifests.length).toBeGreaterThanOrEqual(5)
  })

  for (const manifestPath of manifests) {
    const rel = relative(REPO_ROOT, manifestPath)
    it(`${rel}`, () => {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        attention?: { translations?: Translation[] }
      }
      const translations = manifest.attention?.translations ?? []
      if (translations.length === 0) return

      // Kinds that have at least one resolving translation somewhere in the app.
      const resolved = new Set(translations.filter(hasResolution).map((t) => t.kind))
      // Kinds that are RAISED (a translation that inserts rather than resolves).
      const raised = new Set(translations.filter((t) => !hasResolution(t)).map((t) => t.kind))

      const unresolvedTransient = [...raised].filter(
        (kind) => isTransientKind(kind) && !resolved.has(kind) && !(kind in PERMANENT_KINDS),
      )

      expect(
        unresolvedTransient,
        `${rel}: these kinds describe a transient condition but nothing ever resolves them, so their ` +
          `rows will sit in the attention feed asserting state the app has left. Declare a resolving ` +
          `translation (resolveWhen), or add the kind to PERMANENT_KINDS with a reason if it really is ` +
          `a permanent record.`,
      ).toEqual([])
    })
  }

  it("PERMANENT_KINDS entries all carry a real reason", () => {
    // The exception surface must stay documented, not become a mute list.
    for (const [kind, reason] of Object.entries(PERMANENT_KINDS)) {
      expect(reason.length, `${kind} needs a reason`).toBeGreaterThan(20)
    }
  })

  it("an unconditional resolver is never also an alerting translation", () => {
    // A translation that resolves on every occurrence of its event must not be
    // the same event that raises the row, or the row could never appear.
    for (const manifestPath of manifests) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        attention?: { translations?: Translation[] }
      }
      const translations = manifest.attention?.translations ?? []
      const alerting = new Set(translations.filter((t) => !hasResolution(t)).map((t) => t.event))
      for (const t of translations) {
        if (t.resolveWhen?.always === true) {
          expect(
            alerting.has(t.event),
            `${relative(REPO_ROOT, manifestPath)}: "${t.event}" both raises and unconditionally resolves`,
          ).toBe(false)
        }
      }
    }
  })
})
