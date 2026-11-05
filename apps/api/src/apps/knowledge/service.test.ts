// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  assertCanReadDocumentRow,
  assertCanWriteDocumentRow,
  canEditDocumentRow,
  expandSensitivityGrant,
  type KnowledgeActor,
  KnowledgeError,
  knowledgeActorFromContext,
  knowledgeDisplayTitle,
  knowledgeHttpStatus,
  normalizeRunningDocTitle,
  runningDocTitleTokens,
} from "./service"

// BL-275 — the running-doc PREFIX fallback normalizes titles so a SHORTENED create ("Dealer Price Watch")
// redirects to the seeded fuller running doc ("Dealer Price Watch — Kestrel 6 (RAL-44)") instead of
// spawning a duplicate. Pin the normalization (the prefix relationship the fallback keys on).
describe("normalizeRunningDocTitle", () => {
  it("lowercases + strips punctuation/dashes to a single-spaced word stream", () => {
    expect(normalizeRunningDocTitle("Dealer Price Watch — Kestrel 6 (RAL-44)")).toBe(
      "dealer price watch kestrel 6 ral 44",
    )
    expect(normalizeRunningDocTitle("  Competitor Price & SKU Watch  ")).toBe(
      "competitor price sku watch",
    )
  })

  it("makes the SHORTENED form a true space-anchored PREFIX of the fuller title", () => {
    const full = normalizeRunningDocTitle("Dealer Price Watch — Kestrel 6 (RAL-44)")
    const short = normalizeRunningDocTitle("Dealer Price Watch")
    expect(full.startsWith(`${short} `)).toBe(true)
    // A different doc is NOT a prefix (the one-directional guard) — "watcher" is not "watch ".
    const other = normalizeRunningDocTitle("Dealer Price Watcher Pro")
    expect(other.startsWith(`${short} `)).toBe(false)
  })
})

// BL-275 — the running-doc CONTAINMENT match keys on the SIGNIFICANT token SET (stopwords + dates
// stripped), so a re-ordered / shortened title variant of the same running doc still redirects. Pin the
// token extraction (the subset relationship the fallback keys on).
describe("runningDocTitleTokens", () => {
  it("drops glue/cadence stopwords + dates, keeps distinctive domain tokens", () => {
    expect([...runningDocTitleTokens("Dealer Price Watch — Kestrel 6 (RAL-44)")].sort()).toEqual([
      "dealer",
      "kestrel",
      "price",
      "ral",
      "watch",
    ])
    // "Weekly" + the date are stripped; "watch" / "price" / "dealer" are kept (distinctive).
    expect(
      [...runningDocTitleTokens("Kestrel 6 Weekly Dealer Price Watch - 2026-07-04")].sort(),
    ).toEqual(["dealer", "kestrel", "price", "watch"])
  })

  it("makes a re-ordered / shortened variant a SUBSET of the canonical running doc's tokens", () => {
    const canonical = runningDocTitleTokens("Dealer Price Watch — Kestrel 6 (RAL-44)")
    // Re-ordered variant ("Kestrel 6 Dealer Price Watch") — every token is in the canonical set.
    const reordered = runningDocTitleTokens("Kestrel 6 Dealer Price Watch")
    expect([...reordered].every((t) => canonical.has(t))).toBe(true)
    // Shortened variant ("Dealer Price Watch") — also a subset, ≥3 significant tokens.
    const shortened = runningDocTitleTokens("Dealer Price Watch")
    expect([...shortened].every((t) => canonical.has(t))).toBe(true)
    expect(shortened.size).toBeGreaterThanOrEqual(3)
    // A genuinely-distinct title has an EXTRA distinctive token NOT in the canonical → NOT a subset.
    const distinct = runningDocTitleTokens("Dealer Onboarding Checklist")
    expect([...distinct].every((t) => canonical.has(t))).toBe(false)
  })
})

describe("knowledgeHttpStatus", () => {
  it("maps SOURCE_NOT_ENABLED to 422 (client precondition), NOT 503 (server fault)", () => {
    // Regression: a not-enabled source used to 503, inflating the chaos
    // server-error rate for every seeded Drive/Notion/Linear pointer.
    expect(knowledgeHttpStatus("SOURCE_NOT_ENABLED")).toBe(422)
  })

  it("keeps SOURCE_UNAVAILABLE at 503 for genuine transient outages", () => {
    expect(knowledgeHttpStatus("SOURCE_UNAVAILABLE")).toBe(503)
  })

  it("maps the remaining codes to their canonical statuses", () => {
    expect(knowledgeHttpStatus("REVISION_CONFLICT")).toBe(409)
    expect(knowledgeHttpStatus("VALIDATION")).toBe(400)
    expect(knowledgeHttpStatus("NOT_FOUND")).toBe(404)
    expect(knowledgeHttpStatus("FORBIDDEN")).toBe(403)
  })
})

const orgId = "org-1"
const owner = "user-1"
const other = "user-2"

function actor(overrides: Partial<KnowledgeActor>): KnowledgeActor {
  return {
    orgId,
    userId: owner,
    scopes: [],
    dimensionGrants: {},
    ...overrides,
  }
}

describe("Knowledge document authorization", () => {
  it("allows only the owner to read personal documents", () => {
    const row = {
      orgId,
      documentScope: "personal" as const,
      ownerUserId: owner,
      createdBy: owner,
      orgAccess: "none" as const,
      archivedAt: null,
    }
    expect(() =>
      assertCanReadDocumentRow(row, actor({ userId: owner, scopes: ["knowledge:documents:read"] })),
    ).not.toThrow()
    expect(() =>
      assertCanReadDocumentRow(row, actor({ userId: other, scopes: ["knowledge:documents:read"] })),
    ).toThrow(KnowledgeError)
  })

  // Google-Drive-style sharing model (0002 migration): org-doc access is governed by `orgAccess` +
  // explicit `document_shares`, decoupled from the team/sensitivity dimension ladder (which now only
  // annotates a doc). This matrix pins every branch of assertCanReadDocumentRow / assertCanWriteDocumentRow
  // against a NON-owner, NON-creator third party — the case that actually exercises sharing.
  describe("org_access + explicit share matrix (non-owner, non-creator third party)", () => {
    const thirdParty = "user-3"
    function restrictedRow(
      orgAccess: "none" | "viewer" | "editor",
      editScope: string | null = null,
    ) {
      return {
        orgId,
        documentScope: "organization" as const,
        ownerUserId: owner,
        createdBy: owner,
        orgAccess,
        archivedAt: null,
        editScope,
      }
    }

    it("restricted (orgAccess='none') + NOT shared → read AND write forbidden", () => {
      const row = restrictedRow("none")
      const a = actor({ userId: thirdParty, scopes: ["knowledge:documents:read"] })
      expect(() => assertCanReadDocumentRow(row, a, null)).toThrow(KnowledgeError)
      const w = actor({
        userId: thirdParty,
        scopes: ["knowledge:documents:read", "knowledge:documents:update"],
      })
      expect(() => assertCanWriteDocumentRow(row, w, null)).toThrow(KnowledgeError)
    })

    it("restricted (orgAccess='none') + explicit VIEWER share → read ok, write forbidden", () => {
      const row = restrictedRow("none")
      const a = actor({ userId: thirdParty, scopes: ["knowledge:documents:read"] })
      expect(() => assertCanReadDocumentRow(row, a, "viewer")).not.toThrow()
      const w = actor({
        userId: thirdParty,
        scopes: ["knowledge:documents:read", "knowledge:documents:update"],
      })
      expect(() => assertCanWriteDocumentRow(row, w, "viewer")).toThrow(KnowledgeError)
    })

    it("restricted (orgAccess='none') + explicit EDITOR share → read AND write ok", () => {
      const row = restrictedRow("none")
      const a = actor({ userId: thirdParty, scopes: ["knowledge:documents:read"] })
      expect(() => assertCanReadDocumentRow(row, a, "editor")).not.toThrow()
      const w = actor({
        userId: thirdParty,
        scopes: ["knowledge:documents:read", "knowledge:documents:update"],
      })
      expect(() => assertCanWriteDocumentRow(row, w, "editor")).not.toThrow()
    })

    it("orgAccess='viewer' → any org member can read, but a non-owner/non-editor-share cannot write", () => {
      const row = restrictedRow("viewer")
      const a = actor({ userId: thirdParty, scopes: ["knowledge:documents:read"] })
      expect(() => assertCanReadDocumentRow(row, a, null)).not.toThrow()
      const w = actor({
        userId: thirdParty,
        scopes: ["knowledge:documents:read", "knowledge:documents:update"],
      })
      expect(() => assertCanWriteDocumentRow(row, w, null)).toThrow(KnowledgeError)
      // An explicit editor share on top of orgAccess='viewer' still unlocks write.
      expect(() => assertCanWriteDocumentRow(row, w, "editor")).not.toThrow()
    })

    it("orgAccess='editor' → any org member with update scope can read AND write", () => {
      const row = restrictedRow("editor")
      const a = actor({ userId: thirdParty, scopes: ["knowledge:documents:read"] })
      expect(() => assertCanReadDocumentRow(row, a, null)).not.toThrow()
      const w = actor({
        userId: thirdParty,
        scopes: ["knowledge:documents:read", "knowledge:documents:update"],
      })
      expect(() => assertCanWriteDocumentRow(row, w, null)).not.toThrow()
    })

    it("owner/creator always read+write regardless of orgAccess or shares", () => {
      const row = restrictedRow("none")
      const ownerActor = actor({
        userId: owner,
        scopes: ["knowledge:documents:read", "knowledge:documents:update"],
      })
      expect(() => assertCanReadDocumentRow(row, ownerActor, null)).not.toThrow()
      expect(() => assertCanWriteDocumentRow(row, ownerActor, null)).not.toThrow()

      const creatorRow = { ...row, ownerUserId: other, createdBy: thirdParty }
      const creatorActor = actor({
        userId: thirdParty,
        scopes: ["knowledge:documents:read", "knowledge:documents:update"],
      })
      expect(() => assertCanReadDocumentRow(creatorRow, creatorActor, null)).not.toThrow()
      expect(() => assertCanWriteDocumentRow(creatorRow, creatorActor, null)).not.toThrow()
    })

    // Team/sensitivity dimension grants are NO LONGER an access gate — a matching dimension grant with
    // no share and orgAccess='none' still denies; a non-matching grant with an editor share still allows.
    it("dimension grants (team/sensitivity) do not affect org-doc access either way", () => {
      const row = restrictedRow("none")
      const grantedButNotShared = actor({
        userId: thirdParty,
        scopes: ["knowledge:documents:read"],
        dimensionGrants: { team: ["*"], sensitivity: ["restricted"] },
      })
      expect(() => assertCanReadDocumentRow(row, grantedButNotShared, null)).toThrow(KnowledgeError)

      const noGrantButShared = actor({
        userId: thirdParty,
        scopes: ["knowledge:documents:read"],
        dimensionGrants: {},
      })
      expect(() => assertCanReadDocumentRow(row, noGrantButShared, "viewer")).not.toThrow()
    })

    // Scoped edit (0003 migration): a doc with orgAccess='viewer' + editScope='clevel' is readable by
    // everyone but writable only by a holder of the EXACT 'clevel' scope. Crucially, `*` (org admin) must
    // NOT bypass it — has_exact_scope in RLS, mirrored here by a literal actor.scopes.includes() check.
    describe("scoped edit (editScope)", () => {
      it("orgAccess='viewer' + editScope='clevel': a literal 'clevel' scope holder can write", () => {
        const row = restrictedRow("viewer", "clevel")
        const clevelActor = actor({
          userId: thirdParty,
          scopes: ["knowledge:documents:read", "knowledge:documents:update", "clevel"],
        })
        expect(() => assertCanReadDocumentRow(row, clevelActor, null)).not.toThrow()
        expect(() => assertCanWriteDocumentRow(row, clevelActor, null)).not.toThrow()
      })

      it("orgAccess='viewer' + editScope='clevel': an org admin holding only '*' (no literal 'clevel') CANNOT write, but CAN read", () => {
        const row = restrictedRow("viewer", "clevel")
        const adminActor = actor({
          userId: thirdParty,
          scopes: ["knowledge:documents:read", "knowledge:documents:update", "*"],
        })
        expect(() => assertCanReadDocumentRow(row, adminActor, null)).not.toThrow()
        expect(() => assertCanWriteDocumentRow(row, adminActor, null)).toThrow(KnowledgeError)
      })

      it("orgAccess='viewer' + editScope='clevel': the owner can still write without holding the scope", () => {
        const row = restrictedRow("viewer", "clevel")
        const ownerActor = actor({
          userId: owner,
          scopes: ["knowledge:documents:read", "knowledge:documents:update"],
        })
        expect(() => assertCanWriteDocumentRow(row, ownerActor, null)).not.toThrow()
      })

      it("orgAccess='viewer' + editScope='clevel': a plain member with only read/update scope (no 'clevel', no share) cannot write", () => {
        const row = restrictedRow("viewer", "clevel")
        const memberActor = actor({
          userId: thirdParty,
          scopes: ["knowledge:documents:read", "knowledge:documents:update"],
        })
        expect(() => assertCanReadDocumentRow(row, memberActor, null)).not.toThrow()
        expect(() => assertCanWriteDocumentRow(row, memberActor, null)).toThrow(KnowledgeError)
      })
    })
  })

  it("requires owner/admin write authority", () => {
    const row = {
      orgId,
      documentScope: "organization" as const,
      ownerUserId: owner,
      createdBy: owner,
      orgAccess: "editor" as const,
      archivedAt: null,
      editScope: null,
    }
    // Owner with update scope — allowed
    expect(() =>
      assertCanWriteDocumentRow(
        row,
        actor({ userId: owner, scopes: ["knowledge:documents:update"] }),
      ),
    ).not.toThrow()
    // Admin — allowed
    expect(() =>
      assertCanWriteDocumentRow(
        row,
        actor({
          userId: other,
          scopes: ["knowledge:documents:admin"],
        }),
      ),
    ).not.toThrow()
  })

  // Drive-style: a RESTRICTED (org_access='none') doc is writable ONLY by its
  // owner/creator or an explicit 'editor' share — org admins respect the
  // restriction (NO admin write bypass). Regression guard for the live bug where
  // a viewer/admin could re-write a restricted doc's sharing.
  it("does NOT let a non-owner admin write a RESTRICTED doc they aren't shared on; viewer-share can't write, editor-share can", () => {
    const restricted = {
      orgId,
      documentScope: "organization" as const,
      ownerUserId: owner,
      createdBy: owner,
      orgAccess: "none" as const,
      archivedAt: null,
      editScope: null,
    }
    // admin + update scope, not owner, not shared → DENIED (no admin bypass)
    expect(() =>
      assertCanWriteDocumentRow(
        restricted,
        actor({
          userId: other,
          scopes: ["knowledge:documents:admin", "knowledge:documents:update"],
        }),
        null,
      ),
    ).toThrow(KnowledgeError)
    // explicit VIEWER share → still DENIED for write
    expect(() =>
      assertCanWriteDocumentRow(
        restricted,
        actor({ userId: other, scopes: ["knowledge:documents:update"] }),
        "viewer",
      ),
    ).toThrow(KnowledgeError)
    // explicit EDITOR share → ALLOWED
    expect(() =>
      assertCanWriteDocumentRow(
        restricted,
        actor({ userId: other, scopes: ["knowledge:documents:update"] }),
        "editor",
      ),
    ).not.toThrow()
    // owner → ALLOWED even when restricted
    expect(() =>
      assertCanWriteDocumentRow(
        restricted,
        actor({ userId: owner, scopes: ["knowledge:documents:update"] }),
        null,
      ),
    ).not.toThrow()
  })

  // ORG docs default to orgAccess='editor' (preserving pre-sharing behavior) — SHARED, collaboratively-
  // maintained org knowledge. A member who can READ the doc and holds knowledge:documents:update may
  // MAINTAIN it, even when they are NOT its original owner_user_id. This unblocks a recurring routine that
  // RUNS AS the org admin maintaining a running org doc authored by a different user (the
  // competitor-price-and-spec-watch running-doc UPDATE).
  it("allows a same-org NON-OWNER with update scope to update an orgAccess='editor' ORG doc", () => {
    const row = {
      orgId,
      documentScope: "organization" as const,
      ownerUserId: owner,
      createdBy: owner,
      orgAccess: "editor" as const,
      archivedAt: null,
      editScope: null,
    }
    // Same-org NON-OWNER with update scope → ALLOWED (shared org doc, default editor audience).
    expect(() =>
      assertCanWriteDocumentRow(
        row,
        actor({ userId: other, scopes: ["knowledge:documents:update"] }),
      ),
    ).not.toThrow()
    // …but a non-owner LACKING update scope is still DENIED.
    expect(() =>
      assertCanWriteDocumentRow(
        row,
        actor({ userId: other, scopes: ["knowledge:documents:read"] }),
      ),
    ).toThrow(KnowledgeError)
  })

  it("still restricts PERSONAL-doc writes to the owner (the privacy boundary is unchanged)", () => {
    const personalRow = {
      orgId,
      documentScope: "personal" as const,
      ownerUserId: owner,
      createdBy: owner,
      orgAccess: "none" as const,
      archivedAt: null,
      editScope: null,
    }
    // A non-owner with update scope may NOT write someone else's PERSONAL doc — even same-org.
    expect(() =>
      assertCanWriteDocumentRow(
        personalRow,
        actor({
          userId: other,
          scopes: ["knowledge:documents:update", "knowledge:documents:read"],
        }),
      ),
    ).toThrow(KnowledgeError)
    // The personal-doc owner still can.
    expect(() =>
      assertCanWriteDocumentRow(
        personalRow,
        actor({ userId: owner, scopes: ["knowledge:documents:update"] }),
      ),
    ).not.toThrow()
  })
})

// The app's Edit control reads this flag off the document; it must agree with
// what an update would allow, and say no rather than throw.
describe("canEditDocumentRow", () => {
  const row = {
    orgId,
    documentScope: "organization" as const,
    ownerUserId: owner,
    createdBy: owner,
    orgAccess: "viewer" as const,
    archivedAt: null,
    editScope: null,
    syncedSourceId: null,
  }
  const writer = actor({
    userId: "user-3",
    scopes: ["knowledge:documents:read", "knowledge:documents:update"],
  })

  it("is true for an editor share and false for a viewer share, as the update decides", () => {
    expect(canEditDocumentRow(row, writer, "editor")).toBe(true)
    expect(canEditDocumentRow(row, writer, "viewer")).toBe(false)
    expect(canEditDocumentRow(row, actor({ userId: "user-3", scopes: [] }), "editor")).toBe(false)
  })

  it("is false for a synced document, which only its source edits", () => {
    expect(canEditDocumentRow({ ...row, syncedSourceId: "src-1" }, writer, "editor")).toBe(false)
  })
})

describe("expandSensitivityGrant", () => {
  it("expands confidential to include public/internal/confidential but not restricted", () => {
    expect(expandSensitivityGrant("confidential")).toEqual(["public", "internal", "confidential"])
  })
  it("expands restricted to include the full ladder", () => {
    expect(expandSensitivityGrant("restricted")).toEqual([
      "public",
      "internal",
      "confidential",
      "restricted",
    ])
  })
  it("expands internal correctly", () => {
    expect(expandSensitivityGrant("internal")).toEqual(["public", "internal"])
  })
  it("expands public to just public", () => {
    expect(expandSensitivityGrant("public")).toEqual(["public"])
  })
  it("preserves wildcard", () => {
    expect(expandSensitivityGrant("*")).toEqual(["*"])
  })
})

describe("knowledgeActorFromContext", () => {
  it("pre-expands sensitivity ladder so service auth can match opaquely", () => {
    const ctx = knowledgeActorFromContext({
      orgId,
      userId: owner,
      scopes: ["knowledge:documents:read"],
      dimensionGrants: { sensitivity: ["confidential"] },
    })
    expect(ctx.dimensionGrants.sensitivity).toEqual(["public", "internal", "confidential"])
  })
  it("aliases `knowledge:team` / `knowledge:sensitivity` into bare team / sensitivity", () => {
    const ctx = knowledgeActorFromContext({
      orgId,
      userId: owner,
      scopes: ["knowledge:documents:read"],
      dimensionGrants: {
        "knowledge:team": ["sales"],
        "knowledge:sensitivity": ["internal"],
      },
    })
    expect(ctx.dimensionGrants.team).toEqual(["sales"])
    expect(ctx.dimensionGrants.sensitivity).toEqual(["public", "internal"])
  })

  // A global wildcard dimension grant ({ "*": ["*"] } — held by org admins) must authorize every
  // dimension at every value, mirroring the RLS `dimension_allows('*','*')` short-circuit. Without this,
  // the app-level team/sensitivity checks (which only read the `team`/`sensitivity` keys) would ignore the
  // wildcard and deny an admin rows RLS already returned.
  it("honors a global wildcard dimension grant ({ '*': ['*'] }) by expanding team + sensitivity to ['*']", () => {
    const ctx = knowledgeActorFromContext({
      orgId,
      userId: owner,
      scopes: ["knowledge:documents:read"],
      dimensionGrants: { "*": ["*"] },
    })
    expect(ctx.dimensionGrants.sensitivity).toContain("*")
    expect(ctx.dimensionGrants.team).toEqual(["*"])

    // Dimension grants (including the wildcard) no longer gate org-doc access — that's now orgAccess +
    // explicit shares. A wildcard-holding actor is STILL denied a restricted, non-shared org doc it
    // neither owns nor created; expanding the wildcard must not accidentally reopen dimension-based access.
    const restrictedRow = {
      orgId,
      documentScope: "organization" as const,
      ownerUserId: other,
      createdBy: other,
      orgAccess: "none" as const,
      archivedAt: null,
    }
    expect(() => assertCanReadDocumentRow(restrictedRow, ctx, null)).toThrow(KnowledgeError)
    // …but the same wildcard actor CAN read a broadly-shared org doc, same as any other member.
    const viewerRow = { ...restrictedRow, orgAccess: "viewer" as const }
    expect(() => assertCanReadDocumentRow(viewerRow, ctx, null)).not.toThrow()
  })

  // The `knowledge:*` alias form must behave identically to the bare `*` wildcard key.
  it("honors the `knowledge:*` alias form of the global wildcard grant", () => {
    const ctx = knowledgeActorFromContext({
      orgId,
      userId: owner,
      scopes: ["knowledge:documents:read"],
      dimensionGrants: { "knowledge:*": ["*"] },
    })
    expect(ctx.dimensionGrants.sensitivity).toContain("*")
    expect(ctx.dimensionGrants.team).toEqual(["*"])
  })
})

describe("knowledgeDisplayTitle", () => {
  it("strips a document extension and humanizes a raw import filename", () => {
    // The reported leak: "11-presets.md" rendered verbatim in Recently touched.
    expect(knowledgeDisplayTitle("11-presets.md")).toBe("11 presets")
    expect(knowledgeDisplayTitle("SUMMARY.md")).toBe("SUMMARY")
    expect(knowledgeDisplayTitle("getting_started.markdown")).toBe("getting started")
  })

  it("prefers the body's leading H1 heading over the filename", () => {
    expect(knowledgeDisplayTitle("11-presets.md", "# Preset Reference\n\nBody text")).toBe(
      "Preset Reference",
    )
    // Trailing closing hashes are trimmed.
    expect(knowledgeDisplayTitle("x.md", "# Title #\nmore")).toBe("Title")
  })

  it("ignores a non-heading first line and falls back to the humanized filename", () => {
    expect(knowledgeDisplayTitle("11-presets.md", "Just a paragraph, no heading")).toBe(
      "11 presets",
    )
  })

  it("leaves a real (non-filename) title verbatim", () => {
    expect(knowledgeDisplayTitle("Dealer Onboarding Guide")).toBe("Dealer Onboarding Guide")
  })
})
