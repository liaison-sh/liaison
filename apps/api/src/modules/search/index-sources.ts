// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The document kinds a full rebuild streams BESIDES the registered searchable
// entities: thread messages and their windows, brief rows and episodes, mail
// message fragments. Each owning module registers how to stream one org's
// documents of its kind; the rebuild (reindex.ts) calls every source for every
// org into its shadow index.
//
// Why a registry: the old full reindex walked the registered entities only, so
// the 750k message and window documents were never rebuilt at all. An index
// lost or rebuilt from scratch came back without any of them, and a swap to a
// freshly built index would have dropped them. A source registered here is
// rebuilt with everything else, by the module that knows how to build it.
//
// Its own module, with no imports, so the indexers can register without an
// import cycle through the rebuild.

/**
 * Where a source hands its documents. `transcript: true` marks documents whose
 * vectors the rebuild carries over from the live index (the only ones that can
 * have vectors); their ids are remembered for that pass.
 */
export type IndexSourceSink = (
  docs: Record<string, unknown>[],
  opts?: { transcript?: boolean },
) => Promise<void>

/** Stream every document of this kind for one org into `sink`, in pages. */
export type IndexSource = (orgId: string, sink: IndexSourceSink) => Promise<void>

const sources = new Map<string, IndexSource>()

export function registerIndexSource(name: string, source: IndexSource): void {
  sources.set(name, source)
}

export function indexSources(): Array<[string, IndexSource]> {
  return [...sources.entries()]
}
