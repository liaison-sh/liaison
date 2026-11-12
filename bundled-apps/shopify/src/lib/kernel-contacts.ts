// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Cluster-6 — typed accessor for the kernel contact-list affordance.
//
// The sandbox RPC bridge (apps/api/src/modules/apps/sandbox/rpc-bridge.ts)
// exposes a kernel read that lists THIS app's externally-linked
// `kernel.contacts`, keyset-paginated, under two equivalent names:
//
//   - flat:   `ctx.listContactsByExternalId(limit?, cursor?)`
//   - nested: `ctx.kernel.findContactsByExternalId(limit?, cursor?)`
//
// Both return `{ contacts: Array<{ id, externalId }>, nextCursor }`. This is
// the ONLY sanctioned way for a sandboxed handler to read kernel.contacts:
// `ctx.db.findMany("kernel.contacts", …)` resolves to the app's own schema
// (`app_shopify."kernel.contacts"`) and throws `validateEntity` because the
// literal key is not one of the app's declared tables.
//
// The affordance is not (yet) declared on the public `@liaison/app-sdk`
// `AppContext` type — adding it there is owned by the SDK/kernel track. Until
// then this module declares the runtime contract locally (a real, host-backed
// surface — not a type escape hatch) and narrows `ctx` to it with an explicit
// runtime guard so a missing bridge fails loudly rather than silently casting.
import type { AppContext } from "@liaison/app-sdk"

/** One externally-linked kernel contact as returned by the bridge. */
export interface KernelContactRef {
  id: string
  /** This app's external id for the contact (`external_ids.shopify`), or null. */
  externalId: string | null
}

export interface KernelContactPage {
  contacts: KernelContactRef[]
  nextCursor: string | null
}

/**
 * Runtime shape of the kernel contact-list affordance exposed by the sandbox
 * bridge. Declared here (rather than imported from the SDK) until the SDK type
 * carries it; see the SDK/kernel track cross-track need.
 */
interface KernelContactReader {
  listContactsByExternalId(limit?: number, cursor?: string): Promise<KernelContactPage>
}

function hasKernelContactReader(ctx: AppContext): ctx is AppContext & KernelContactReader {
  return typeof (ctx as Partial<KernelContactReader>).listContactsByExternalId === "function"
}

/**
 * List this app's externally-linked kernel contacts, one page at a time.
 * Throws if the bridge affordance is unavailable (rather than silently
 * returning nothing) so the reconcile job surfaces a real misconfiguration.
 */
export async function listContactsByExternalId(
  ctx: AppContext,
  limit: number,
  cursor: string | null,
): Promise<KernelContactPage> {
  if (!hasKernelContactReader(ctx)) {
    throw new Error(
      "kernel contact-list affordance unavailable: ctx.listContactsByExternalId is not bound by the sandbox bridge",
    )
  }
  const raw = (await (cursor == null
    ? ctx.listContactsByExternalId(limit)
    : ctx.listContactsByExternalId(limit, cursor))) as unknown
  // The FLAT bridge alias is wrapped by the sandbox's plain `__wrap`, which only JSON.parses
  // the string return when a call arg is non-primitive. Here every arg is primitive (limit,
  // cursor), so the bridge's JSON string arrives UNPARSED -- `page.contacts` was then undefined
  // and `for (const c of page.contacts)` in reconcileCustomersJob crashed with
  // "Symbol.iterator of undefined". Parse defensively and default the shape so every caller gets
  // a real array. (The nested ctx.kernel.* alias IS parsed; this flat one is not.)
  const page = (
    typeof raw === "string" ? JSON.parse(raw) : raw
  ) as Partial<KernelContactPage> | null
  return { contacts: page?.contacts ?? [], nextCursor: page?.nextCursor ?? null }
}
