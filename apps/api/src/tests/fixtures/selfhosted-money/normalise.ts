// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One normaliser for the self-hosted money snapshots (spec S19): ids and
// timestamps are masked, every other value and the shape stay as served.
// Model lists keep only the fixture's own models, so a catalogue row added by
// a later migration does not move a snapshot that is about money.

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g

/** The prefix of every model the fixture seeds. */
export const FIXTURE_MODEL_PREFIX = "shm-"

function keepModel(m: unknown): boolean {
  if (!m || typeof m !== "object") return true
  const row = m as Record<string, unknown>
  const key = row.key ?? row.modelKey ?? row.id
  return typeof key !== "string" || key.startsWith(FIXTURE_MODEL_PREFIX)
}

function walk(v: unknown, parentKey: string | null): unknown {
  if (typeof v === "string") return v.replace(UUID, "<uuid>").replace(ISO, "<ts>")
  if (Array.isArray(v)) {
    const rows = parentKey === "models" ? v.filter(keepModel) : v
    return rows.map((x) => walk(x, null))
  }
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, k)
    return out
  }
  return v
}

/** A response body as the snapshots store it. */
export function normaliseMoneyBody(body: unknown): unknown {
  return walk(body, null)
}
