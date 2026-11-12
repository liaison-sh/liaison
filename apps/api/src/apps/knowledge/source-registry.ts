// SPDX-License-Identifier: FSL-1.1-ALv2

import type { KnowledgeSourceRegistry } from "~/apps/knowledge/federated-search"
import { createKnowledgeSourceRegistry } from "~/apps/knowledge/federated-search"
import type { KnowledgeActor } from "~/apps/knowledge/service"
import {
  isFolderSourceCapable,
  type KnowledgeSourceAdapter,
} from "~/apps/knowledge/source-protocol"
import type { RlsClient } from "~/db"
/**
 * Build a request-scoped registry of kernel source adapters. Every connector
 * now syncs through its own app's source kinds (app-sources.ts), so the
 * default registry is empty; route handlers and sandbox bridges still take it
 * from here, and unit tests construct an explicit registry via
 * `createKnowledgeSourceRegistry()` + `.register(...)` with their own stub
 * adapters.
 */
export function registerDefaultKnowledgeSources(_input: {
  tx: RlsClient
  orgId: string
  userId: string
  /** The caller's effective scopes (kept for adapters that gate on them). */
  scopes: readonly string[]
  identifier?: string
}): KnowledgeSourceRegistry {
  return createKnowledgeSourceRegistry()
}

/**
 * Filter a registry down to adapters that declare `listFolder` (M-2 protocol
 * extension). Used by the Knowledge synced-sources UI to populate the
 * "Choose source" picker and by the reconciler to refuse running against a
 * non-folder-capable adapter.
 */
export function listFolderCapableSources(
  registry: KnowledgeSourceRegistry,
  actor: KnowledgeActor,
): KnowledgeSourceAdapter[] {
  return registry.listEnabled(actor).filter(isFolderSourceCapable)
}
