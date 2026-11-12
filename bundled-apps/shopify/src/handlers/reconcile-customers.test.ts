// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B12 — Periodic reconcile-customers job tests.
//
// Sample N of this app's externally-linked kernel contacts via the kernel
// bridge affordance (ctx.listContactsByExternalId — NOT ctx.db, which can't
// read kernel.contacts from the sandbox) → refetch from Shopify →
//   - present + changed   → re-resolve via ctx.resolveContact (kernel re-derives diff)
//   - present + unchanged → no-op
//   - missing in Shopify  → emit customer:deleted; clear external_ids.shopify
//     via ctx.resolveContact({ clear: true }) (NOT a raw db.update).
// Empty store and per-contact error paths are tested for resilience.
//
// Test fidelity (cluster 6): the previous mock seeded a `"kernel.contacts"`
// Map key that ctx.db.findMany resolved literally — masking the fact that the
// production sandbox bridge rejects `ctx.db.findMany("kernel.contacts")`. This
// mock instead binds the real `listContactsByExternalId` affordance the job
// now calls, and asserts the clear path goes through resolveContact.
import { describe, expect, it } from "bun:test"
import type { AppContext } from "@liaison/app-sdk"
import { createEnforcingEmit } from "../lib/emit.testutil"
import type { KernelContactRef } from "../lib/kernel-contacts"
import { reconcileCustomersJob } from "./reconcile-customers"

interface FetchResponse {
  status?: number
  body: unknown
}

interface ResolveCall {
  email?: string
  externalId?: string
  name?: string
  clear?: boolean
}

function makeCtx(opts: { shopifyFetch?: FetchResponse[]; contacts?: KernelContactRef[] }): {
  ctx: AppContext
  resolveContact: { calls: ResolveCall[] }
  events: Array<{
    entity: string
    action: string
    entityId?: string
    data?: unknown
    metadata?: Record<string, unknown>
  }>
} {
  const responses = [...(opts.shopifyFetch ?? [])]
  const allContacts = [...(opts.contacts ?? [])]
  const resolveCalls: ResolveCall[] = []
  // Enforcing emit: throws if the job emits an `${entity}:${action}` not in the
  // real app.manifest.json (e.g. the old doubled-verb `customer:customer_deleted`).
  const { emit, emits: events } = createEnforcingEmit()
  const ctx = {
    userId: "u",
    orgId: "o",
    db: {
      // The reconcile job MUST NOT read kernel.contacts via ctx.db — that is
      // exactly the cluster-6 bug. Fail loudly if it tries. `install_metadata`
      // is a real app table (getShopifyClient reads it) so it resolves normally.
      findMany: async (entity: string) => {
        if (entity === "kernel.contacts") {
          throw new Error(
            'Entity "kernel.contacts" not found (sandbox rejects literal kernel table refs)',
          )
        }
        if (entity === "install_metadata") {
          return [
            {
              id: "i1",
              shopDomain: "demo.myshopify.com",
              connectionId: "ca1",
              apiVersion: "2026-04",
            },
          ]
        }
        return []
      },
      findOne: async () => null,
      insert: async () => ({ id: "x" }),
      update: async (entity: string) => {
        if (entity === "kernel.contacts") {
          throw new Error(
            "reconcile must clear external ids via resolveContact, not db.update(kernel.contacts)",
          )
        }
      },
      updateMany: async () => ({ count: 0 }),
      delete: async () => undefined,
      count: async () => 0,
    },
    // Real kernel bridge affordance (keyset-paginated). One page is enough for
    // these fixtures (nextCursor=null).
    listContactsByExternalId: async (limit?: number, _cursor?: string) => ({
      contacts: allContacts.slice(0, limit ?? 50),
      nextCursor: null,
    }),
    emit,
    enqueueJob: async () => undefined,
    resolveContact: (async (p: ResolveCall) => {
      resolveCalls.push(p)
      return {}
    }) as AppContext["resolveContact"],
    connections: {
      shop: {
        getAccounts: async () => [
          {
            id: "ca1",
            ownerType: "org" as const,
            ownerId: null,
            identifier: "demo.myshopify.com",
            displayName: null,
          },
        ],
        getToken: async () => "test-token",
      },
    },
    fetch: async (_url: string) => {
      const next = responses.shift() ?? { body: {} }
      return { status: next.status ?? 200, headers: {}, body: JSON.stringify(next.body) }
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    agent_run: async () => "{}",
    realtime_publish: async () => "{}",
    grants_setUserScopes: async () => "{}",
    bulk: {
      fetchToBlob: async () => ({ blobId: "x", sizeBytes: 0 }),
      iterateJsonl: async function* () {},
      deleteBlob: async () => undefined,
    },
  } as unknown as AppContext
  return { ctx, resolveContact: { calls: resolveCalls }, events }
}

const customerNode = (id: string, email: string, name: string): FetchResponse => ({
  body: {
    data: {
      customer: {
        id: `gid://shopify/Customer/${id}`,
        email,
        firstName: name,
        lastName: "",
      },
    },
  },
})

const customerNull: FetchResponse = { body: { data: { customer: null } } }

describe("reconcileCustomersJob", () => {
  it("samples contacts via the kernel bridge affordance and refetches each", async () => {
    const contacts: KernelContactRef[] = Array.from({ length: 3 }, (_, i) => ({
      id: `contact-${i}`,
      externalId: `c${i + 1}`,
    }))
    const { ctx, resolveContact } = makeCtx({
      contacts,
      shopifyFetch: [
        customerNode("c1", "c1@x", "C1"),
        customerNode("c2", "c2@x", "C2"),
        customerNode("c3", "c3@x", "C3"),
      ],
    })
    await reconcileCustomersJob({}, ctx)
    expect(resolveContact.calls.length).toBe(3)
    expect(resolveContact.calls.map((c) => c.externalId)).toEqual(["c1", "c2", "c3"])
    // None of these are clear calls (all present in Shopify).
    expect(resolveContact.calls.every((c) => !c.clear)).toBe(true)
  })

  it("missing-in-Shopify contact emits customer:deleted and clears via resolveContact({clear:true})", async () => {
    const contacts: KernelContactRef[] = [{ id: "contact-1", externalId: "c1" }]
    const { ctx, events, resolveContact } = makeCtx({
      contacts,
      shopifyFetch: [customerNull],
    })
    await reconcileCustomersJob({}, ctx)
    // Canonical identity: action "deleted" (not the doubled-verb "customer_deleted").
    const deletedEvent = events.find((e) => e.entity === "customer" && e.action === "deleted")
    expect(deletedEvent).toBeDefined()
    // Linkage cleared through the kernel resolveContact path (NOT db.update).
    const clearCall = resolveContact.calls.find((c) => c.clear === true)
    expect(clearCall).toBeDefined()
    expect(clearCall!.externalId).toBe("c1")
  })

  it("empty store → no resolveContact calls, no events", async () => {
    const { ctx, resolveContact, events } = makeCtx({})
    await reconcileCustomersJob({}, ctx)
    expect(resolveContact.calls.length).toBe(0)
    expect(events.length).toBe(0)
  })

  it("per-contact fetch error is swallowed and skipped (job completes other contacts)", async () => {
    const contacts: KernelContactRef[] = [
      { id: "contact-1", externalId: "c1" },
      { id: "contact-2", externalId: "c2" },
    ]
    const { ctx, resolveContact } = makeCtx({
      contacts,
      shopifyFetch: [
        { status: 500, body: { errors: [{ message: "boom" }] } },
        customerNode("c2", "c2@x", "C2"),
      ],
    })
    await reconcileCustomersJob({}, ctx)
    expect(resolveContact.calls.length).toBe(1)
    expect(resolveContact.calls[0]!.externalId).toBe("c2")
  })
})
