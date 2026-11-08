// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Meaning for tool search: how close a query is to what each tool does, read
 * from text embeddings, added to the keyword ranker's score (tool-rank.ts).
 *
 * The keyword ranker reads words; a person often says what they want without
 * the words a tool is named or described with ("Marc left, cut his access" for
 * deactivating a user). An embedding of the query and of each tool's name and
 * description places both by meaning, so a tool can rank on a request that
 * shares no word with it.
 *
 * Rules the ranker keeps:
 * - Only tools in the catalog it is handed can rank. The caller builds that
 *   catalog from the actor's scopes, Off apps and hidden tools, so a tool the
 *   caller cannot reach never surfaces, whatever its vector says.
 * - A tool the keyword search loads (a strong match) keeps its place ahead.
 * - Meaning adds to a tool's score only when the tool stands out from the
 *   catalog for this query (a z-score above MEANING_FLOOR_Z), so a query close
 *   to nothing adds nothing.
 * - Tool vectors are computed once per tool text and kept; only the query is
 *   embedded per search. Without an embedder, or past the query's time budget,
 *   the search is the keyword search alone.
 */

/** Weight of one standard deviation of meaning above the floor, in keyword-score points. */
export const MEANING_WEIGHT = 4
/** A tool adds meaning only this many standard deviations above the catalog's mean. */
export const MEANING_FLOOR_Z = 2
/** Below this many tools with vectors, the catalog's spread says nothing: no meaning. */
const MIN_TOOLS_FOR_MEANING = 20

export type Vector = Float32Array | readonly number[]

/** What a search knows by meaning: the query's vector and each tool's. */
export interface ToolMeaning {
  query: Vector
  vectorOf(sdkName: string): Vector | undefined
}

function dot(a: Vector, b: Vector): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += (a[i] as number) * (b[i] as number)
  return s
}

/**
 * Meaning points per tool of `catalog` (sdkName to points, absent for none):
 * the query's similarity to each tool, as standard deviations above the
 * catalog's mean, past the floor, times the weight. Vectors are unit length.
 */
export function meaningPoints(
  catalog: ReadonlyArray<{ sdkName: string }>,
  meaning: ToolMeaning,
): Map<string, number> {
  const sims: Array<{ name: string; sim: number }> = []
  for (const t of catalog) {
    const v = meaning.vectorOf(t.sdkName)
    if (v) sims.push({ name: t.sdkName, sim: dot(meaning.query, v) })
  }
  const points = new Map<string, number>()
  if (sims.length < MIN_TOOLS_FOR_MEANING) return points
  const mean = sims.reduce((a, s) => a + s.sim, 0) / sims.length
  const sd = Math.sqrt(sims.reduce((a, s) => a + (s.sim - mean) ** 2, 0) / sims.length)
  if (!(sd > 0)) return points
  for (const s of sims) {
    const z = (s.sim - mean) / sd
    // A trace of z on every tool breaks keyword ties by meaning.
    const p = MEANING_WEIGHT * Math.max(0, z - MEANING_FLOOR_Z) + 1e-6 * z
    points.set(s.name, p)
  }
  return points
}

/** The text a tool is embedded from: its app, its name as words, its description's opening. */
export function toolMeaningText(t: {
  appName: string
  toolName: string
  description: string
}): string {
  const name = t.toolName
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_.]+/g, " ")
    .toLowerCase()
  return `${t.appName} ${name}: ${t.description.slice(0, 400)}`
}

// ── The embedder and the tool vectors ────────────────────────────────────

/** Turns texts into unit vectors. `kind` lets a model tell a query from a document. */
export interface TextEmbedder {
  readonly id: string
  embed(texts: string[], kind: "query" | "document"): Promise<Vector[]>
}

/** How long a search waits for its query's vector before it ranks by keywords alone. */
export const QUERY_BUDGET_MS = 150
/** Tool texts embedded per call while the vectors fill. */
const DOCUMENT_BATCH = 4

/**
 * Tool vectors, one per tool text, filled in the background the first time a
 * catalog is seen and kept for the life of the process. A changed description
 * is a new text and gets a new vector; nothing is embedded twice.
 */
export class ToolMeaningIndex {
  private readonly vectors = new Map<string, Vector>()
  private readonly pending = new Set<string>()
  private filling: Promise<void> | null = null
  private failed = false

  constructor(private readonly embedder: TextEmbedder) {}

  /** Queue the catalog's tools whose text has no vector yet. Never waits. */
  prepare(catalog: ReadonlyArray<{ appName: string; toolName: string; description: string }>) {
    if (this.failed) return
    for (const t of catalog) {
      const text = toolMeaningText(t)
      if (!this.vectors.has(text)) this.pending.add(text)
    }
    if (!this.filling && this.pending.size > 0) this.filling = this.fill()
  }

  /** Resolves when every queued text has its vector (tests and warm-up). */
  async ready(): Promise<void> {
    while (this.filling) await this.filling
  }

  private async fill(): Promise<void> {
    try {
      while (this.pending.size > 0) {
        const batch = [...this.pending].slice(0, DOCUMENT_BATCH)
        const out = await this.embedder.embed(batch, "document")
        batch.forEach((text, i) => {
          const v = out[i]
          if (v) this.vectors.set(text, v)
          this.pending.delete(text)
        })
        // Yield between batches so requests keep their turn on the event loop.
        await new Promise((r) => setTimeout(r, 0))
      }
    } catch (err) {
      // A model that cannot run leaves the search on keywords; it is not retried.
      this.failed = true
      this.pending.clear()
      const embedder = this.embedder.id
      void import("~/lib/logger")
        .then(({ rootLogger }) =>
          rootLogger.warn(
            { err, embedder },
            "tool search: the embedding model could not run, so tools rank by words alone",
          ),
        )
        .catch(() => {})
    } finally {
      this.filling = null
    }
  }

  /**
   * The meaning for one search over `catalog`, or null when there is none to
   * add: no tool vectors yet, the query embedding failed, or it took longer
   * than the budget.
   */
  async meaningFor<
    T extends { sdkName: string; appName: string; toolName: string; description: string },
  >(
    query: string,
    catalog: readonly T[],
    budgetMs: number = QUERY_BUDGET_MS,
  ): Promise<ToolMeaning | null> {
    this.prepare(catalog)
    const byName = new Map<string, Vector>()
    for (const t of catalog) {
      const v = this.vectors.get(toolMeaningText(t))
      if (v) byName.set(t.sdkName, v)
    }
    if (byName.size < MIN_TOOLS_FOR_MEANING) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((r) => {
      timer = setTimeout(() => r(null), budgetMs)
    })
    const vector = await Promise.race([
      this.embedder.embed([query], "query").then(
        (v) => v[0] ?? null,
        () => null,
      ),
      late,
    ])
    clearTimeout(timer)
    if (!vector) return null
    return { query: vector, vectorOf: (n) => byName.get(n) }
  }
}

// ── The process's index ──────────────────────────────────────────────────

let index: ToolMeaningIndex | null | undefined

/**
 * The embedder tool search uses, chosen once per process:
 * `LIAISON_TOOL_MEANING=off` turns meaning off; otherwise the local model
 * (local-embedder.ts) runs in this process when it can load, and the search
 * stays on keywords when it cannot. A test sets its own with setToolEmbedder.
 */
export function toolMeaningIndex(): ToolMeaningIndex | null {
  if (index !== undefined) return index
  // A test process ranks by words unless its test sets an embedder: results stay
  // deterministic and no model is fetched.
  const testProcess = process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test"
  if (process.env.LIAISON_TOOL_MEANING === "off" || testProcess) {
    index = null
    return index
  }
  index = new ToolMeaningIndex(lazyLocalEmbedder())
  return index
}

/** Tests: the embedder tool search uses (null for none); undefined restores the default. */
export function setToolEmbedder(embedder: TextEmbedder | null | undefined): void {
  index = embedder === undefined ? undefined : embedder ? new ToolMeaningIndex(embedder) : null
}

/** The local model, loaded on first use so a process that never searches pays nothing. */
function lazyLocalEmbedder(): TextEmbedder {
  let loaded: Promise<TextEmbedder> | null = null
  const load = () => {
    loaded ??= import("./local-embedder").then((m) => m.loadLocalEmbedder())
    return loaded
  }
  return {
    id: "local",
    async embed(texts, kind) {
      return (await load()).embed(texts, kind)
    },
  }
}
