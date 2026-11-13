// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Saved transforms, versioned. Saving under a name adds version n+1 (the
 * first save is version 1); a version is never updated, so a run that pins
 * (id, version) runs exactly the code its preview showed and its approval
 * named. Saving builds the version's Worker module (execute.ts
 * transformModule). Reached through the privileged connection only (the table has no
 * RLS read path); every call takes the org from its caller (the run row or
 * the authenticated request), never from the transform.
 */
import { and, desc, eq, max } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { importTransforms } from "~/db/schema/kernel"
import type { ImportTransform } from "~/db/schema/kernel/import-transforms"
import { AdhocModuleError } from "~/modules/apps/workers/adhoc-module"
import { transformModule } from "./execute"
import { validateTransformSource } from "./source"

export const TRANSFORM_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const KIND_RE = /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_]*$/
const MAX_KINDS = 32
const IDENTIFIER_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export class TransformStoreError extends Error {
  constructor(
    readonly code: "invalid_transform" | "transform_not_found" | "transform_version_mismatch",
    message: string,
  ) {
    super(message)
    this.name = "TransformStoreError"
  }
}

export interface SaveTransformInput {
  orgId: string
  name: string
  source: string
  kinds: string[]
  sourceType: "upload" | "api"
  /** API sources: the api-connector connection the transform pulls from. */
  connectionIdentifier?: string | null
  createdBy?: string | null
}

export interface TransformRef {
  id: string
  name: string
  version: number
}

function checkInput(input: SaveTransformInput): void {
  if (!TRANSFORM_NAME_RE.test(input.name)) {
    throw new TransformStoreError(
      "invalid_transform",
      "A transform name is 1 to 64 lowercase letters, digits, dots, dashes or underscores.",
    )
  }
  const kinds = [...new Set(input.kinds)]
  if (kinds.length === 0 || kinds.length > MAX_KINDS || kinds.some((k) => !KIND_RE.test(k))) {
    throw new TransformStoreError(
      "invalid_transform",
      `A transform declares 1 to ${MAX_KINDS} record kinds such as "tickets.ticket".`,
    )
  }
  if (input.sourceType === "api") {
    if (!input.connectionIdentifier || !IDENTIFIER_RE.test(input.connectionIdentifier)) {
      throw new TransformStoreError(
        "invalid_transform",
        "An API transform names its connection: pass connection, the identifier of an api-connector connection (lowercase letters, digits, - and _).",
      )
    }
  } else if (input.connectionIdentifier) {
    throw new TransformStoreError("invalid_transform", "An upload transform takes no connection.")
  }
  validateTransformSource(input.source, input.sourceType === "api" ? "pull" : "transform")
}

/** Save a new version of a transform (version 1 when the name is new). */
export async function saveTransform(
  tx: PrivilegedDb,
  input: SaveTransformInput,
): Promise<TransformRef> {
  checkInput(input)
  // Its Worker module, built now (workers/adhoc-module.ts): code that does not
  // build is refused at the save, not at the first run on a remote executor.
  try {
    await transformModule(input.orgId, input.source, tx)
  } catch (err) {
    if (!(err instanceof AdhocModuleError)) throw err
    throw new TransformStoreError(
      "invalid_transform",
      `The transform ${err.message.replace(/^the code /, "")}.`,
    )
  }
  for (let attempt = 0; ; attempt++) {
    const [top] = await tx
      .select({ v: max(importTransforms.version) })
      .from(importTransforms)
      .where(and(eq(importTransforms.orgId, input.orgId), eq(importTransforms.name, input.name)))
    const version = (top?.v ?? 0) + 1
    // ON CONFLICT DO NOTHING on the (org, name, version) unique index: a
    // concurrent save that took this version returns no row instead of raising
    // a 23505, which would abort the caller's transaction.
    const [row] = await tx
      .insert(importTransforms)
      .values({
        orgId: input.orgId,
        name: input.name,
        version,
        source: input.source,
        kinds: [...new Set(input.kinds)],
        sourceType: input.sourceType,
        connectionIdentifier:
          input.sourceType === "api" ? (input.connectionIdentifier ?? null) : null,
        createdBy: input.createdBy ?? null,
      })
      .onConflictDoNothing()
      .returning({
        id: importTransforms.id,
        name: importTransforms.name,
        version: importTransforms.version,
      })
    if (row) return row
    // A concurrent save took this version number: take the next one.
    if (attempt >= 4) {
      throw new TransformStoreError(
        "invalid_transform",
        "The transform is being saved concurrently; try again.",
      )
    }
  }
}

/** One version of a transform, or its latest version when none is given. */
export async function getTransform(
  tx: PrivilegedDb,
  orgId: string,
  name: string,
  version?: number,
): Promise<ImportTransform> {
  const rows = await tx
    .select()
    .from(importTransforms)
    .where(
      and(
        eq(importTransforms.orgId, orgId),
        eq(importTransforms.name, name),
        ...(version !== undefined ? [eq(importTransforms.version, version)] : []),
      ),
    )
    .orderBy(desc(importTransforms.version))
    .limit(1)
  const row = rows[0]
  if (!row) {
    throw new TransformStoreError(
      "transform_not_found",
      version === undefined
        ? `No transform named "${name}".`
        : `No version ${version} of transform "${name}".`,
    )
  }
  return row
}

/**
 * The exact version a run pinned. A pin names the row id and its version; both
 * must match, so a run can never be moved onto other code.
 */
export async function resolvePinnedTransform(
  tx: PrivilegedDb,
  orgId: string,
  pin: { transformId: string; version: number },
): Promise<ImportTransform> {
  const rows = await tx
    .select()
    .from(importTransforms)
    .where(and(eq(importTransforms.orgId, orgId), eq(importTransforms.id, pin.transformId)))
    .limit(1)
  const row = rows[0]
  if (!row)
    throw new TransformStoreError("transform_not_found", "The run's transform no longer exists.")
  if (row.version !== pin.version) {
    throw new TransformStoreError(
      "transform_version_mismatch",
      `The run pinned version ${pin.version} of "${row.name}", not version ${row.version}.`,
    )
  }
  return row
}

/** The latest version of every transform of an org, by name. */
export async function listTransforms(
  tx: PrivilegedDb,
  orgId: string,
): Promise<Array<Omit<ImportTransform, "source">>> {
  const rows = await tx
    .select({
      id: importTransforms.id,
      orgId: importTransforms.orgId,
      name: importTransforms.name,
      version: importTransforms.version,
      kinds: importTransforms.kinds,
      sourceType: importTransforms.sourceType,
      connectionIdentifier: importTransforms.connectionIdentifier,
      createdBy: importTransforms.createdBy,
      createdAt: importTransforms.createdAt,
    })
    .from(importTransforms)
    .where(eq(importTransforms.orgId, orgId))
    .orderBy(importTransforms.name, desc(importTransforms.version))
  const latest = new Map<string, (typeof rows)[number]>()
  for (const r of rows) if (!latest.has(r.name)) latest.set(r.name, r)
  return [...latest.values()]
}
