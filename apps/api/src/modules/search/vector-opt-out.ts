// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Once any org declares the `memory` embedder on the shared index, Meili
// REJECTS the whole batch for a new document that carries no `_vectors.memory`
// ("no vectors provided for document"). Every document written to the index
// therefore carries either a vector or an explicit `_vectors.memory: null`,
// which Meili accepts whether or not the embedder exists. The one place that
// guarantees it is `finalizeDocuments` in index-writer.ts, which every writer
// goes through.

/** The Meili embedder name for memory vectors, shared by every index writer. */
export const MEMORY_EMBEDDER_NAME = "memory"
