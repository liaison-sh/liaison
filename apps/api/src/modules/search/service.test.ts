// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { withRlsContext } from "~/db/rls"
import * as searchClientModule from "~/infra/search/client"
import { entityRegistry } from "~/modules/apps/app-registries"
import { ExternalSearchHandlersTestAccess } from "~/modules/search/external-handlers"
import * as mentionSecondaryModule from "~/modules/search/mention-secondary"

const ORG = "11111111-1111-1111-1111-111111111111"
const USER_A = "22222222-2222-2222-2222-222222222222"

type MeiliSearchFn = (
  q: string,
  opts: { filter?: string; limit?: number; offset?: number },
) => Promise<{
  hits: any[]
  estimatedTotalHits: number
}>

const meiliSearch = mock<MeiliSearchFn>(async () => ({ hits: [], estimatedTotalHits: 0 }))

const spies: Array<{ mockRestore: () => void }> = []

beforeEach(() => {
  meiliSearch.mockClear()
  ExternalSearchHandlersTestAccess.reset()
  spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue("test_liaison_search"))
  spies.push(
    spyOn(searchClientModule, "getMeili").mockReturnValue({
      index: () => ({ search: meiliSearch }),
      // biome-ignore lint/suspicious/noExplicitAny: test mock
    } as any),
  )
  // Register a "tickets" searchable entity so the service authorises its read scope.
  entityRegistry.set([ORG, "tickets", "ticket"], {
    labelField: "subject",
    handlePrefix: "tk",
    searchable: true,
    tableName: "tickets",
    readScope: "tickets:tickets:read",
    indexFields: { title: "subject" },
    permissionFields: { readScope: "tickets:tickets:read", dimensionFields: [] },
  })
})

afterEach(() => {
  for (const s of spies) s.mockRestore()
  spies.length = 0
  entityRegistry.delete([ORG, "tickets", "ticket"])
})

async function importService() {
  return await import("./service")
}

describe("globalSearch", () => {
  it("returns USB ticket for user with tickets:tickets:read", async () => {
    meiliSearch.mockImplementationOnce(async () => ({
      hits: [
        {
          id: "tickets:ticket:1",
          app: "tickets",
          entity_type: "ticket",
          entity_id: "1",
          title: "USB detection bug",
        },
      ],
      estimatedTotalHits: 1,
    }))
    const { globalSearch } = await importService()
    const res = await withRlsContext(
      {
        actorType: "user",
        userId: USER_A,
        orgId: ORG,
        scopes: ["tickets:tickets:read", "kernel:threads:read"],
        dimensionGrants: {},
      },
      (_tx) =>
        globalSearch({
          orgId: ORG,
          userId: USER_A,
          scopes: ["tickets:tickets:read", "kernel:threads:read"],
          q: "USB",
          limit: 5,
        }),
    )
    expect(res.entities.map((e) => e.id)).toContain("1")
    expect(res.entities[0].source).toBe("internal")
  })

  it("denies user without any read scope (short-circuits Meili)", async () => {
    const { globalSearch } = await importService()
    const res = await withRlsContext(
      {
        actorType: "user",
        userId: USER_A,
        orgId: ORG,
        scopes: ["unrelated:scope"],
        dimensionGrants: {},
      },
      (_tx) =>
        globalSearch({
          orgId: ORG,
          userId: USER_A,
          scopes: ["unrelated:scope"],
          q: "USB",
          limit: 5,
        }),
    )
    expect(res.threads).toEqual([])
    expect(res.users).toEqual([])
    expect(res.contacts).toEqual([])
    expect(res.entities).toEqual([])
    expect(meiliSearch).not.toHaveBeenCalled()
  })

  it("participant narrowing emits filter that excludes non-participant threads", async () => {
    meiliSearch.mockImplementationOnce(async () => ({ hits: [], estimatedTotalHits: 0 }))
    const { globalSearch } = await importService()
    await withRlsContext(
      {
        actorType: "user",
        userId: USER_A,
        orgId: ORG,
        scopes: ["kernel:threads:read"],
        dimensionGrants: {},
      },
      (_tx) =>
        globalSearch({
          orgId: ORG,
          userId: USER_A,
          scopes: ["kernel:threads:read"],
          q: "Sprint",
          limit: 5,
        }),
    )
    expect(meiliSearch).toHaveBeenCalled()
    const callArg = meiliSearch.mock.calls[0][1]
    expect(callArg.filter).toContain(`participant_ids = "${USER_A}"`)
  })

  it("threads external cursor/limit/market into fanout and surfaces returned cursors (criterion #7)", async () => {
    meiliSearch.mockImplementationOnce(async () => ({ hits: [], estimatedTotalHits: 0 }))
    const { registerExternalSearchHandler } = await import("./external-handlers")
    const received: Array<{
      cursor?: string | null
      limit?: number
      marketContext?: string | null
    }> = []
    registerExternalSearchHandler(ORG, "shopify", async (p) => {
      received.push({ cursor: p.cursor, limit: p.limit, marketContext: p.marketContext })
      return {
        hits: [{ id: "o9", app: "shopify", entity_type: "order", title: "#1009" }],
        nextCursor: "g-next",
      }
    })
    const { globalSearch } = await importService()
    const res = await withRlsContext(
      {
        actorType: "user",
        userId: USER_A,
        orgId: ORG,
        scopes: ["*"],
        dimensionGrants: {},
      },
      (_tx) =>
        globalSearch({
          orgId: ORG,
          userId: USER_A,
          scopes: ["*"],
          q: "x",
          limit: 5,
          externalCursors: { shopify: "g-prev" },
          marketContext: "US",
        }),
    )
    expect(received).toEqual([{ cursor: "g-prev", limit: 5, marketContext: "US" }])
    expect(res.externalCursors).toEqual({ shopify: "g-next" })
  })

  it("filters out hits whose entity_type is not registered (defense vs stale docs)", async () => {
    meiliSearch.mockImplementationOnce(async () => ({
      hits: [
        {
          id: "stale:foo:1",
          app: "stale",
          entity_type: "foo",
          entity_id: "1",
          title: "Old doc",
        },
      ],
      estimatedTotalHits: 1,
    }))
    const { globalSearch } = await importService()
    const res = await withRlsContext(
      {
        actorType: "user",
        userId: USER_A,
        orgId: ORG,
        scopes: ["*"],
        dimensionGrants: {},
      },
      (_tx) =>
        globalSearch({
          orgId: ORG,
          userId: USER_A,
          scopes: ["*"],
          q: "Old",
          limit: 5,
        }),
    )
    expect(res.entities).toEqual([])
  })
})

describe("mentionSearch", () => {
  it("filters by is_mentionable, type=entity, returns ticket", async () => {
    meiliSearch.mockImplementationOnce(async () => ({
      hits: [
        {
          id: "tickets:ticket:1",
          app: "tickets",
          entity_type: "ticket",
          entity_id: "1",
          title: "USB detection bug",
          is_mentionable: true,
        },
      ],
      estimatedTotalHits: 1,
    }))
    const { mentionSearch } = await importService()
    const res = await withRlsContext(
      {
        actorType: "user",
        userId: USER_A,
        orgId: ORG,
        scopes: ["tickets:tickets:read"],
        dimensionGrants: {},
      },
      (_tx) =>
        mentionSearch({
          orgId: ORG,
          userId: USER_A,
          scopes: ["tickets:tickets:read"],
          q: "USB",
          type: "entity",
          limit: 10,
        }),
    )
    expect(res.find((m) => m.id === "1")).toBeTruthy()
    const callArg = meiliSearch.mock.calls[0][1]
    expect(callArg.filter).toContain(`is_mentionable = true`)
    expect(callArg.filter).toContain(`entity_type != "user"`)
  })

  it("type=user narrows to entity_type = user", async () => {
    meiliSearch.mockImplementationOnce(async () => ({ hits: [], estimatedTotalHits: 0 }))
    const { mentionSearch } = await importService()
    await withRlsContext(
      {
        actorType: "user",
        userId: USER_A,
        orgId: ORG,
        scopes: ["kernel:users:read"],
        dimensionGrants: {},
      },
      (_tx) =>
        mentionSearch({
          orgId: ORG,
          userId: USER_A,
          scopes: ["kernel:users:read"],
          q: "alice",
          type: "user",
          limit: 10,
        }),
    )
    const callArg = meiliSearch.mock.calls[0][1]
    expect(callArg.filter).toContain(`entity_type = "user"`)
  })

  // The member preset writes conversations but holds no kernel:users:read (a
  // directory scope). Its people pickers ("New message", "Add people", the @
  // composer) all ask for the addressable set, and the user documents are
  // indexed under kernel:users:read: a member found nobody, so a member could
  // neither start a DM nor add a colleague (demo, 2026-10-12).
  for (const type of ["addressable", "user"] as const) {
    it(`type=${type}: a member who may write conversations finds colleagues`, async () => {
      meiliSearch.mockImplementationOnce(async () => ({
        hits: [
          {
            id: "kernel:user:u2",
            app: "kernel",
            entity_type: "user",
            entity_id: "u2",
            title: "Matrix Recipient",
            is_mentionable: true,
          },
        ],
        estimatedTotalHits: 1,
      }))
      const member = ["kernel:threads:read", "kernel:threads:write", "kernel:contacts:read"]
      const { mentionSearch } = await importService()
      const res = await withRlsContext(
        { actorType: "user", userId: USER_A, orgId: ORG, scopes: member, dimensionGrants: {} },
        (_tx) =>
          mentionSearch({
            orgId: ORG,
            userId: USER_A,
            scopes: member,
            q: "matrix",
            type,
            limit: 10,
          }),
      )
      const filter = meiliSearch.mock.calls[0][1].filter as string
      expect(filter).toContain(`"kernel:users:read"`)
      expect(res.map((h) => h.id)).toContain("u2")
    })
  }

  it("a read-only caller (no kernel:threads:write) is not handed the member directory", async () => {
    meiliSearch.mockImplementationOnce(async () => ({ hits: [], estimatedTotalHits: 0 }))
    const viewer = ["kernel:threads:read", "kernel:contacts:read"]
    const { mentionSearch } = await importService()
    await withRlsContext(
      { actorType: "user", userId: USER_A, orgId: ORG, scopes: viewer, dimensionGrants: {} },
      (_tx) =>
        mentionSearch({
          orgId: ORG,
          userId: USER_A,
          scopes: viewer,
          q: "matrix",
          type: "addressable",
          limit: 10,
        }),
    )
    const filter = meiliSearch.mock.calls[0][1].filter as string
    expect(filter).not.toContain(`"kernel:users:read"`)
  })

  it("the # reference set is not widened by the member rule", async () => {
    meiliSearch.mockImplementationOnce(async () => ({ hits: [], estimatedTotalHits: 0 }))
    const member = ["kernel:threads:read", "kernel:threads:write"]
    const { mentionSearch } = await importService()
    await withRlsContext(
      { actorType: "user", userId: USER_A, orgId: ORG, scopes: member, dimensionGrants: {} },
      (_tx) =>
        mentionSearch({
          orgId: ORG,
          userId: USER_A,
          scopes: member,
          q: "matrix",
          type: "reference",
          limit: 10,
        }),
    )
    const filter = meiliSearch.mock.calls[0][1].filter as string
    expect(filter).not.toContain(`"kernel:users:read"`)
  })

  it("returns [] when no read scope authorizes anything", async () => {
    const { mentionSearch } = await importService()
    const res = await withRlsContext(
      {
        actorType: "user",
        userId: USER_A,
        orgId: ORG,
        scopes: ["unrelated:scope"],
        dimensionGrants: {},
      },
      (_tx) =>
        mentionSearch({
          orgId: ORG,
          userId: USER_A,
          scopes: ["unrelated:scope"],
          q: "USB",
          limit: 10,
        }),
    )
    expect(res).toEqual([])
    expect(meiliSearch).not.toHaveBeenCalled()
  })

  it("returns Meili hits as-is with no live-DB fallback supplement (directMentionFallback deleted)", async () => {
    // Meili returns fewer than `limit` hits — pre-refactor this used to trigger
    // directMentionFallback's live-DB ILIKE recall supplement. That fallback is
    // deleted (spec §3.4/§3.7): mentionSearch must return exactly what Meili
    // returned, never more.
    meiliSearch.mockImplementationOnce(async () => ({
      hits: [
        {
          id: "tickets:ticket:1",
          app: "tickets",
          entity_type: "ticket",
          entity_id: "1",
          title: "Only hit",
          is_mentionable: true,
        },
      ],
      estimatedTotalHits: 1,
    }))
    const { mentionSearch } = await importService()
    const res = await withRlsContext(
      {
        actorType: "user",
        userId: USER_A,
        orgId: ORG,
        scopes: ["tickets:tickets:read"],
        dimensionGrants: {},
      },
      (_tx) =>
        mentionSearch({
          orgId: ORG,
          userId: USER_A,
          scopes: ["tickets:tickets:read"],
          q: "o",
          type: "entity",
          limit: 10,
        }),
    )
    expect(res.length).toBe(1)
    expect(meiliSearch).toHaveBeenCalledTimes(1)
  })

  // A page that FILLS the limit is the common case for a popular handle
  // ("@support" on the seed): the picker returns ten rows and every one of
  // them needs the fact that tells it apart. The secondary-label pass used to
  // sit behind an early return taken by exactly that page, so the full pages
  // were the only ones shipped with a bare title.
  it("attaches secondary labels even when the hits fill the limit", async () => {
    entityRegistry.set([ORG, "projects", "task"], {
      labelField: "title",
      handlePrefix: "tsk",
      searchable: true,
      tableName: "tasks",
      readScope: "projects:tasks:read",
      indexFields: { title: "title" },
      permissionFields: { readScope: "projects:tasks:read", dimensionFields: [] },
    })
    const full = Array.from({ length: 10 }, (_v, i) => ({
      id: `projects:task:${i}`,
      app: "projects",
      entity_type: "task",
      entity_id: String(i),
      title: "Email-bounce dashboard for support",
      is_mentionable: true,
    }))
    meiliSearch.mockImplementationOnce(async () => ({
      hits: full,
      estimatedTotalHits: full.length,
    }))
    const attach = spyOn(mentionSecondaryModule, "attachMentionSecondaryLabels")
    attach.mockImplementation(async (_orgId, hits) => {
      for (const hit of hits) if (!hit.secondaryLabel) hit.secondaryLabel = `Project ${hit.id}`
    })
    spies.push(attach)
    try {
      const { mentionSearch } = await importService()
      const res = await withRlsContext(
        {
          actorType: "user",
          userId: USER_A,
          orgId: ORG,
          scopes: ["projects:tasks:read"],
          dimensionGrants: {},
        },
        (_tx) =>
          mentionSearch({
            orgId: ORG,
            userId: USER_A,
            scopes: ["projects:tasks:read"],
            q: "support",
            type: "entity",
            limit: 10,
          }),
      )
      expect(res.length).toBe(10)
      expect(res.filter((h) => !h.secondaryLabel)).toEqual([])
      expect(res[0].secondaryLabel).toBe("Project 0")
    } finally {
      entityRegistry.delete([ORG, "projects", "task"])
    }
  })
})

describe("executor capability matrix basics", () => {
  it("resolveTicketMatches never fans out externally regardless of caller scope", async () => {
    meiliSearch.mockImplementationOnce(async () => ({
      hits: [{ id: "tickets:ticket:9", app: "tickets", entity_type: "ticket", entity_id: "9" }],
      estimatedTotalHits: 1,
    }))
    const { registerExternalSearchHandler } = await import("./external-handlers")
    let externalCalled = false
    registerExternalSearchHandler(ORG, "shopify", async () => {
      externalCalled = true
      return { hits: [], nextCursor: null }
    })
    const { SearchDriftTestAccess } = await import("./drift")
    SearchDriftTestAccess.setSearchReady(true)
    try {
      const { resolveTicketMatches } = await importService()
      const ids = await withRlsContext(
        {
          actorType: "user",
          userId: USER_A,
          orgId: ORG,
          scopes: ["tickets:tickets:read"],
          dimensionGrants: {},
        },
        (_tx) =>
          resolveTicketMatches({
            orgId: ORG,
            userId: USER_A,
            scopes: ["tickets:tickets:read"],
            q: "x",
          }),
      )
      expect(ids).toEqual(["9"])
      expect(externalCalled).toBe(false)
    } finally {
      SearchDriftTestAccess.resetSearchReady()
    }
  })

  it("resolveTicketMatches throws MeiliUnavailableError when the index is not ready", async () => {
    const { SearchDriftTestAccess } = await import("./drift")
    SearchDriftTestAccess.resetSearchReady() // isSearchReady() === false
    const { resolveTicketMatches, MeiliUnavailableError } = await importService()
    await expect(
      withRlsContext(
        {
          actorType: "user",
          userId: USER_A,
          orgId: ORG,
          scopes: ["tickets:tickets:read"],
          dimensionGrants: {},
        },
        (_tx) =>
          resolveTicketMatches({
            orgId: ORG,
            userId: USER_A,
            scopes: ["tickets:tickets:read"],
            q: "x",
          }),
      ),
    ).rejects.toBeInstanceOf(MeiliUnavailableError)
    expect(meiliSearch).not.toHaveBeenCalled()
  })

  it("hits surfaces pass distinct=dedupe_key so fragmented conversations collapse to one result", async () => {
    const { globalSearch, pageSearch, mentionSearch } = await importService()
    const actor = {
      orgId: ORG,
      userId: USER_A,
      scopes: ["*"],
      q: "a",
      limit: 5,
    }
    await globalSearch(actor)
    await pageSearch({ ...actor, offset: 0, filters: {} })
    await mentionSearch(actor)
    for (const call of meiliSearch.mock.calls) {
      expect((call[1] as { distinct?: string }).distinct).toBe("dedupe_key")
    }
    // Five reads: `globalSearch` reads two windows (its people/thread buckets
    // and every other record), and `pageSearch` also runs the exact-count
    // pass. The loop above is what matters here — the count query dedupes the
    // SAME way as the page it counts, or the total would disagree with the
    // hits it is a total of.
    expect(meiliSearch.mock.calls.length).toBe(5)
    expect(
      meiliSearch.mock.calls.filter((c) =>
        Array.isArray((c[1] as { attributesToRetrieve?: unknown }).attributesToRetrieve),
      ).length,
    ).toBe(1)
  })

  it("the ids projection does NOT dedupe — the inbox must list every real ticket row", async () => {
    meiliSearch.mockImplementationOnce(async () => ({ hits: [], estimatedTotalHits: 0 }))
    const { SearchDriftTestAccess } = await import("./drift")
    SearchDriftTestAccess.setSearchReady(true)
    try {
      const { resolveTicketMatches } = await importService()
      await resolveTicketMatches({
        orgId: ORG,
        userId: USER_A,
        scopes: ["tickets:tickets:read"],
        q: "x",
      })
      const callArg = meiliSearch.mock.calls[0][1] as { distinct?: string }
      expect(callArg.distinct).toBeUndefined()
    } finally {
      SearchDriftTestAccess.resetSearchReady()
    }
  })

  it("the permission filter always runs first — no authorized scope short-circuits before Meili on every projection", async () => {
    const { SearchDriftTestAccess } = await import("./drift")
    SearchDriftTestAccess.setSearchReady(true)
    try {
      const { resolveTicketMatches } = await importService()
      const ids = await withRlsContext(
        {
          actorType: "user",
          userId: USER_A,
          orgId: ORG,
          scopes: ["unrelated:scope"],
          dimensionGrants: {},
        },
        (_tx) =>
          resolveTicketMatches({
            orgId: ORG,
            userId: USER_A,
            scopes: ["unrelated:scope"],
            q: "x",
          }),
      )
      expect(ids).toEqual([])
      expect(meiliSearch).not.toHaveBeenCalled()
    } finally {
      SearchDriftTestAccess.resetSearchReady()
    }
  })
})

describe("expandTicketSearchDimensionGrants (sensitivity ladder, spec §3.1a)", () => {
  it("expands a namespaced tickets:sensitivity grant to the cumulative downward set, merged into the bare key", async () => {
    const { expandTicketSearchDimensionGrants } = await importService()
    const out = expandTicketSearchDimensionGrants({ "tickets:sensitivity": ["confidential"] })
    expect(out.sensitivity).toEqual(expect.arrayContaining(["internal", "confidential"]))
    expect(out.sensitivity).not.toContain("restricted")
    // The namespaced key itself is also expanded in place (SQL GUC consumers
    // that read the namespaced key still see the full downward set).
    expect(out["tickets:sensitivity"]).toEqual(expect.arrayContaining(["internal", "confidential"]))
  })

  it("restricted grants everything at or below (internal, confidential, restricted)", async () => {
    const { expandTicketSearchDimensionGrants } = await importService()
    const out = expandTicketSearchDimensionGrants({ "tickets:sensitivity": ["restricted"] })
    expect(new Set(out.sensitivity)).toEqual(new Set(["internal", "confidential", "restricted"]))
  })

  it("internal grants only internal", async () => {
    const { expandTicketSearchDimensionGrants } = await importService()
    const out = expandTicketSearchDimensionGrants({ "tickets:sensitivity": ["internal"] })
    expect(out.sensitivity).toEqual(["internal"])
  })

  it("merges the namespaced tickets:team grant into the bare team key", async () => {
    const { expandTicketSearchDimensionGrants } = await importService()
    const out = expandTicketSearchDimensionGrants({ "tickets:team": ["support-us"] })
    expect(out.team).toEqual(["support-us"])
  })

  it("a bare sensitivity grant (no namespaced key present) is still ladder-expanded", async () => {
    const { expandTicketSearchDimensionGrants } = await importService()
    const out = expandTicketSearchDimensionGrants({ sensitivity: ["confidential"] })
    expect(new Set(out.sensitivity)).toEqual(new Set(["internal", "confidential"]))
  })

  it("wildcard passes through unexpanded", async () => {
    const { expandTicketSearchDimensionGrants } = await importService()
    const out = expandTicketSearchDimensionGrants({ "tickets:sensitivity": ["*"] })
    expect(out["tickets:sensitivity"]).toEqual(["*"])
    expect(out.sensitivity).toEqual(["*"])
  })

  it("an unrelated dimension key is left untouched (sensitivity still defaults to the lowest band)", async () => {
    const { expandTicketSearchDimensionGrants } = await importService()
    const out = expandTicketSearchDimensionGrants({ "mail:inbox": ["account-1"] })
    expect(out["mail:inbox"]).toEqual(["account-1"])
    expect(out.sensitivity).toEqual(["internal"])
    expect(out.team).toBeUndefined()
  })

  it("no sensitivity grant at all defaults to the lowest band (RLS COALESCE-0 parity)", async () => {
    // Every ticket row defaults to sensitivity='internal', and the SQL
    // can_read_ticket policy COALESCEs a missing grant to ordinal 0 — so a
    // member with no sensitivity grant can open internal tickets in the list
    // view. Without this default the Meili filter degenerates to
    // `(NOT sensitivity EXISTS)` and that member gets ZERO search hits.
    const { expandTicketSearchDimensionGrants } = await importService()
    expect(expandTicketSearchDimensionGrants({}).sensitivity).toEqual(["internal"])
    expect(expandTicketSearchDimensionGrants(undefined).sensitivity).toEqual(["internal"])
    // team keeps empty-set semantics: no membership grant, no default
    expect(expandTicketSearchDimensionGrants({}).team).toBeUndefined()
  })

  it("a global wildcard grant skips the lowest-band default (admins bypass dimension clauses)", async () => {
    const { expandTicketSearchDimensionGrants } = await importService()
    const out = expandTicketSearchDimensionGrants({ "*": ["*"] })
    expect(out.sensitivity).toBeUndefined()
    expect(out["*"]).toEqual(["*"])
  })
})

describe("expandTicketSensitivityGrants (exact expansions + unknown values)", () => {
  it("expands each tier to its cumulative downward set", async () => {
    const { expandTicketSensitivityGrants } = await importService()
    expect(expandTicketSensitivityGrants(["internal"])).toEqual(["internal"])
    expect(new Set(expandTicketSensitivityGrants(["confidential"]))).toEqual(
      new Set(["internal", "confidential"]),
    )
    expect(new Set(expandTicketSensitivityGrants(["restricted"]))).toEqual(
      new Set(["internal", "confidential", "restricted"]),
    )
  })

  it("wildcard short-circuits to a single-element wildcard list", async () => {
    const { expandTicketSensitivityGrants } = await importService()
    expect(expandTicketSensitivityGrants(["*"])).toEqual(["*"])
  })

  it("unknown values are preserved verbatim, not dropped", async () => {
    const { expandTicketSensitivityGrants } = await importService()
    expect(expandTicketSensitivityGrants(["custom-tier"])).toEqual(["custom-tier"])
  })

  it("empty input returns empty output", async () => {
    const { expandTicketSensitivityGrants } = await importService()
    expect(expandTicketSensitivityGrants([])).toEqual([])
  })
})

describe("pageSearch", () => {
  it("merges internal and external hits with source tags", async () => {
    meiliSearch.mockImplementationOnce(async () => ({
      hits: [
        {
          id: "tickets:ticket:1",
          app: "tickets",
          entity_type: "ticket",
          entity_id: "1",
          title: "USB",
        },
      ],
      estimatedTotalHits: 1,
    }))
    const { registerExternalSearchHandler } = await import("./external-handlers")
    registerExternalSearchHandler(ORG, "shopify", async () => ({
      hits: [{ id: "o1", app: "shopify", entity_type: "order", title: "#1001" }],
      nextCursor: null,
    }))

    const { pageSearch } = await importService()
    const r = await withRlsContext(
      {
        actorType: "user",
        userId: USER_A,
        orgId: ORG,
        scopes: ["*"],
        dimensionGrants: {},
      },
      (_tx) =>
        pageSearch({
          orgId: ORG,
          userId: USER_A,
          scopes: ["*"],
          q: "a",
          limit: 10,
          offset: 0,
          filters: {},
        }),
    )
    expect(typeof r.total).toBe("number")
    expect(Array.isArray(r.hits)).toBe(true)
    expect(r.hits.map((h) => h.source)).toEqual(
      expect.arrayContaining(["internal", "external:shopify"]),
    )
  })

  it("round-trips per-source cursor + limit + marketContext through fanout to the response (criterion #7)", async () => {
    meiliSearch.mockImplementationOnce(async () => ({ hits: [], estimatedTotalHits: 0 }))
    const { registerExternalSearchHandler } = await import("./external-handlers")
    const received: Array<{
      cursor?: string | null
      limit?: number
      marketContext?: string | null
    }> = []
    registerExternalSearchHandler(ORG, "shopify", async (p) => {
      received.push({ cursor: p.cursor, limit: p.limit, marketContext: p.marketContext })
      return {
        hits: [{ id: "o2", app: "shopify", entity_type: "order", title: "#1002" }],
        nextCursor: "page-2",
      }
    })

    const { pageSearch } = await importService()
    const r = await withRlsContext(
      {
        actorType: "user",
        userId: USER_A,
        orgId: ORG,
        scopes: ["*"],
        dimensionGrants: {},
      },
      (_tx) =>
        pageSearch({
          orgId: ORG,
          userId: USER_A,
          scopes: ["*"],
          q: "a",
          limit: 7,
          offset: 0,
          filters: {},
          externalCursors: { shopify: "page-1" },
          marketContext: "EU",
        }),
    )

    // Request cursor / limit / market reached the handler unchanged.
    expect(received).toEqual([{ cursor: "page-1", limit: 7, marketContext: "EU" }])
    // The handler's nextCursor is surfaced back out, keyed by app.
    expect(r.externalCursors).toEqual({ shopify: "page-2" })
  })

  it("surfaces a null external cursor when a source is exhausted", async () => {
    meiliSearch.mockImplementationOnce(async () => ({ hits: [], estimatedTotalHits: 0 }))
    const { registerExternalSearchHandler } = await import("./external-handlers")
    registerExternalSearchHandler(ORG, "shopify", async () => ({
      hits: [],
      nextCursor: null,
    }))
    const { pageSearch } = await importService()
    const r = await withRlsContext(
      {
        actorType: "user",
        userId: USER_A,
        orgId: ORG,
        scopes: ["*"],
        dimensionGrants: {},
      },
      (_tx) =>
        pageSearch({
          orgId: ORG,
          userId: USER_A,
          scopes: ["*"],
          q: "a",
          limit: 10,
          offset: 0,
          filters: {},
        }),
    )
    expect(r.externalCursors).toEqual({ shopify: null })
  })

  it("rejects unknown manifest dimension filters before Meili interpolation", async () => {
    const { pageSearch } = await importService()
    await expect(
      withRlsContext(
        {
          actorType: "user",
          userId: USER_A,
          orgId: ORG,
          scopes: ["*"],
          dimensionGrants: {},
        },
        (_tx) =>
          pageSearch({
            orgId: ORG,
            userId: USER_A,
            scopes: ["*"],
            q: "a",
            limit: 10,
            offset: 0,
            filters: { unknown: ["x"] },
          }),
      ),
    ).rejects.toThrow(/unknown search filter/i)
  })

  it("applies declared dimension filter (team) into Meili filter", async () => {
    entityRegistry.set([ORG, "tickets", "ticket"], {
      labelField: "subject",
      handlePrefix: "tk",
      searchable: true,
      tableName: "tickets",
      readScope: "tickets:tickets:read",
      indexFields: { title: "subject" },
      permissionFields: {
        readScope: "tickets:tickets:read",
        dimensionFields: ["team"],
      },
    })
    meiliSearch.mockImplementationOnce(async () => ({ hits: [], estimatedTotalHits: 0 }))
    const { pageSearch } = await importService()
    await withRlsContext(
      {
        actorType: "user",
        userId: USER_A,
        orgId: ORG,
        scopes: ["*"],
        dimensionGrants: { team: ["red"] },
      },
      (_tx) =>
        pageSearch({
          orgId: ORG,
          userId: USER_A,
          scopes: ["*"],
          q: "a",
          limit: 10,
          offset: 0,
          filters: { team: ["red"] },
        }),
    )
    const callArg = meiliSearch.mock.calls[0][1]
    expect(callArg.filter).toContain(`team IN ["red"]`)
  })
})

describe("mentionSearch — user status indexFilter", () => {
  it("direct-DB fallback queries kernel.users restricted to active status", async () => {
    const privilegedModule = await import("~/db/privileged")
    const captured: string[] = []
    const spy = spyOn(privilegedModule, "withPrivilegedDb").mockImplementation(
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      async (_org: string, _purpose: string, fn: any) =>
        fn({
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          execute: async (query: any) => {
            captured.push(JSON.stringify(query))
            return { rows: [] }
          },
        }),
    )
    try {
      meiliSearch.mockImplementationOnce(async () => ({ hits: [], estimatedTotalHits: 0 }))
      const { mentionSearch } = await importService()
      await withRlsContext(
        {
          actorType: "user",
          userId: USER_A,
          orgId: ORG,
          scopes: ["kernel:users:read"],
          dimensionGrants: {},
        },
        (_tx) =>
          mentionSearch({
            orgId: ORG,
            userId: USER_A,
            scopes: ["kernel:users:read"],
            q: "",
            type: "user",
            limit: 10,
          }),
      )
      const userQuery = captured.find((s) => s.includes("users"))
      expect(userQuery).toBeDefined()
      expect(userQuery).toContain("status")
      expect(userQuery).toContain("active")
    } finally {
      spy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// The reported `total` is a COUNT OF WHAT THIS SEARCHER MAY READ, never the
// engine's pre-filter estimate.
//
// The engine takes its estimate before the visibility post-filter runs, and
// three filters drop hits after it: the message recheck (a message document
// carries neither its room nor its disclosure list), the thread-participant
// recheck, and the registration filter. Reporting that estimate answers "there
// are N things here you may not read", and because it is a COUNT that moves
// with the query, varying the query binary-searches the hidden content. It is
// reachable at default settings: 60 unreadable matches with a 25-item page
// returned `hits: []` with `total: 35`.
//
// So the count is taken AFTER the same three filters, over a bounded
// over-fetch of the same result set. It saturates at that bound, which
// under-reports and therefore never leaks.
// ---------------------------------------------------------------------------

const DEFAULT_MEILI = async () => ({ hits: [] as any[], estimatedTotalHits: 0 })

function doc(entityType: string, app: string): Record<string, unknown> {
  return {
    id: `${app}:${entityType}:${crypto.randomUUID()}`,
    app,
    entity_type: entityType,
    entity_id: crypto.randomUUID(),
    title: "acquisition",
  }
}

/**
 * The page query and the count query are the same Meili index, told apart by
 * the count query's `attributesToRetrieve` (it needs only the fields the
 * post-filters read).
 */
function meiliPageAndCount(page: unknown[], count: unknown[], estimate: number): void {
  meiliSearch.mockImplementation(async (_q, opts) => {
    const isCountQuery = Array.isArray(
      (opts as { attributesToRetrieve?: unknown }).attributesToRetrieve,
    )
    return {
      hits: (isCountQuery ? count : page) as any[],
      estimatedTotalHits: estimate,
    }
  })
}

async function pageAs(scopes: string[], limit: number) {
  const { pageSearch } = await importService()
  return await withRlsContext(
    { actorType: "user", userId: USER_A, orgId: ORG, scopes, dimensionGrants: {} },
    (_tx) =>
      pageSearch({
        orgId: ORG,
        userId: USER_A,
        scopes,
        q: "acquisition",
        limit,
        offset: 0,
        filters: {},
      }),
  )
}

describe("pageSearch total never counts what the searcher cannot read", () => {
  afterEach(() => {
    meiliSearch.mockImplementation(DEFAULT_MEILI)
  })

  it("a full page of unreadable message matches reports 0, not the engine estimate", async () => {
    // 60 messages match; the page holds 25; this searcher is in none of those
    // rooms, so the database drops every one of them.
    const all = Array.from({ length: 60 }, () => doc("message", "kernel"))
    meiliPageAndCount(all.slice(0, 25), all, 60)

    const r = await pageAs(["*"], 25)
    expect(r.hits).toEqual([])
    expect(r.total).toBe(0)
  })

  it("hidden matches BEYOND the fetched page are not counted either", async () => {
    // One readable ticket on the page, two unreadable messages behind it: the
    // page-local correction could not see them, so the count came back 3.
    const ticket = doc("ticket", "tickets")
    const hidden = [doc("message", "kernel"), doc("message", "kernel")]
    meiliPageAndCount([ticket], [ticket, ...hidden], 3)

    const r = await pageAs(["*"], 1)
    expect(r.hits.map((h) => h.entity_type)).toEqual(["ticket"])
    expect(r.total).toBe(1)
  })

  it("thread hits the searcher is not a participant in are not counted", async () => {
    // The thread-participant recheck also runs after the estimate, so a stale
    // `participant_ids` inflated the count the same way.
    const threads = Array.from({ length: 3 }, () => doc("thread", "kernel"))
    meiliPageAndCount(threads, threads, 3)

    const r = await pageAs(["*"], 25)
    expect(r.hits).toEqual([])
    expect(r.total).toBe(0)
  })

  it("a full page of readable hits still reports the whole result set, so paging works", async () => {
    // The client derives "is there a next page" from offset + hits < total.
    // Closing the oracle must not strand the searcher on page 1.
    const all = Array.from({ length: 60 }, () => doc("ticket", "tickets"))
    meiliPageAndCount(all.slice(0, 25), all, 60)

    const r = await pageAs(["*"], 25)
    expect(r.hits.length).toBe(25)
    expect(r.total).toBe(60)
    expect(r.offset + r.hits.length < r.total).toBe(true)
  })
})

describe("one kind of record is narrowed in the engine, never filtered out of a shared window", () => {
  const actor = {
    actorType: "user" as const,
    userId: USER_A,
    orgId: ORG,
    scopes: ["tickets:tickets:read", "kernel:contacts:read", "kernel:threads:read"],
    dimensionGrants: {},
  }

  it("globalSearch reads the people/thread buckets and the other records in two windows", async () => {
    const { globalSearch } = await importService()
    await withRlsContext(actor, () =>
      globalSearch({ orgId: ORG, userId: USER_A, scopes: actor.scopes, q: "erae", limit: 5 }),
    )
    const filters = meiliSearch.mock.calls.map((c) => c[1].filter ?? "")
    expect(filters).toHaveLength(2)
    expect(
      filters.filter((f) => f.includes('entity_type NOT IN ["thread","user","contact"]')),
    ).toHaveLength(1)
    expect(
      filters.filter(
        (f) => f.includes('entity_type IN ["thread","user","contact"]') && !f.includes("NOT IN"),
      ),
    ).toHaveLength(1)
  })

  it("globalSearch lists a contact once when both windows return it", async () => {
    const contact = {
      id: "kernel:contact:c1",
      app: "kernel",
      entity_type: "contact",
      entity_id: "c1",
      title: "Erae Dealer",
    }
    meiliSearch.mockImplementation(async () => ({ hits: [contact], estimatedTotalHits: 1 }))
    try {
      const { globalSearch } = await importService()
      const res = await withRlsContext(actor, () =>
        globalSearch({ orgId: ORG, userId: USER_A, scopes: actor.scopes, q: "erae", limit: 5 }),
      )
      expect(res.contacts.map((c) => c.id)).toEqual(["c1"])
    } finally {
      meiliSearch.mockImplementation(async () => ({ hits: [], estimatedTotalHits: 0 }))
    }
  })

  it("scopedEntitySearch puts the app and entity type in the engine filter", async () => {
    const { scopedEntitySearch } = await importService()
    await withRlsContext(actor, () =>
      scopedEntitySearch({
        orgId: ORG,
        userId: USER_A,
        scopes: actor.scopes,
        q: "erae",
        app: ["tickets"],
        entityType: ["ticket"],
        limit: 50,
        offset: 50,
      }),
    )
    const [, opts] = meiliSearch.mock.calls[0]!
    expect(opts.filter).toContain('app IN ["tickets"]')
    expect(opts.filter).toMatch(/entity_type IN \["ticket"\]/)
    expect(opts.offset).toBe(50)
  })

  it("mentionSearch narrows to the picker's app and entity type in the engine", async () => {
    const { mentionSearch } = await importService()
    await withRlsContext(actor, () =>
      mentionSearch({
        orgId: ORG,
        userId: USER_A,
        scopes: actor.scopes,
        q: "erae",
        limit: 10,
        app: "tickets",
        entityType: "ticket",
      }),
    )
    const [, opts] = meiliSearch.mock.calls[0]!
    expect(opts.filter).toContain('app IN ["tickets"]')
    expect(opts.filter).toMatch(/entity_type IN \["ticket"\]/)
  })

  it("resolveThreadMessageMatches past the room-clause cap pages and keeps the caller's rooms only", async () => {
    const mine = Array.from({ length: 2001 }, (_, i) => `room-${i}`)
    const msg = (n: number, thread: string) => ({
      entity_id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      thread_id: thread,
    })
    // Page 1: 200 messages of a room the caller is not in; page 2: two of theirs.
    meiliSearch.mockImplementation(async (_q, opts) => ({
      hits:
        (opts.offset ?? 0) === 0
          ? Array.from({ length: 200 }, (_, i) => msg(i, "someone-elses-room"))
          : [msg(900, "room-7"), msg(901, "room-2000")],
      estimatedTotalHits: 202,
    }))
    const { SearchDriftTestAccess } = await import("./drift")
    SearchDriftTestAccess.setSearchReady(true)
    try {
      const { resolveThreadMessageMatches } = await importService()
      const ids = await resolveThreadMessageMatches({
        orgId: ORG,
        userId: USER_A,
        scopes: ["*"],
        q: "erae",
        threadIds: mine,
        limit: 20,
      })
      expect(ids).toEqual([msg(900, "").entity_id, msg(901, "").entity_id])
      expect(meiliSearch.mock.calls.map((c) => c[1].offset)).toEqual([0, 200])
      expect(meiliSearch.mock.calls[0]![1].filter).not.toContain("thread_id IN")
    } finally {
      SearchDriftTestAccess.resetSearchReady()
      meiliSearch.mockImplementation(async () => ({ hits: [], estimatedTotalHits: 0 }))
    }
  })
})
