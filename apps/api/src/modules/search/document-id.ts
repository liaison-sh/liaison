// SPDX-License-Identifier: FSL-1.1-ALv2

/**
 * Builds the MeiliSearch document id for a searchable entity.
 *
 * Meili only permits `[a-zA-Z0-9_-]` in document ids (max 511 bytes), so any
 * other character in a component is replaced with `_`. The id is org-scoped:
 * a full reindex tags each document with the loop's org id, so without the org
 * prefix two orgs with same-shaped rows would collide on `${app}_${entity}_${id}`
 * and the last-processed org would overwrite the others (cross-tenant
 * cross-tagging). Both the upsert and delete paths must produce the same id for
 * a given `(orgId, app, entityType, entityId)`, so this is the single source.
 */
function sanitizeComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_")
}

export function documentId(
  orgId: string,
  app: string,
  entityType: string,
  entityId: string,
): string {
  return [orgId, app, entityType, entityId].map(sanitizeComponent).join("_")
}
