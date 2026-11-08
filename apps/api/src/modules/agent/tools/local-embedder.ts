// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A small multilingual embedding model run in the API process (ONNX on the
 * CPU, through transformers.js), for tool search's meaning score
 * (tool-meaning.ts). Nothing leaves the machine: the model's files are fetched
 * once into the model cache, or read from it when the image ships them.
 *
 * `LIAISON_TOOL_MEANING_MODEL` picks another model of the same family;
 * `LIAISON_MODEL_CACHE_DIR` is where the files live. When the package or the
 * files are missing, loading throws and tool search ranks by keywords alone.
 */
import type { TextEmbedder, Vector } from "./tool-meaning"

const DEFAULT_MODEL = "onnx-community/embeddinggemma-300m-ONNX"
/** 4-bit weights: about a quarter of the memory and time of 8-bit, same ranking on the bench. */
const DEFAULT_DTYPE = "q4"

/** The prompt each model family was trained with, for a query and for a document. */
function prefixes(model: string): { query: string; document: string } {
  if (/gemma/i.test(model))
    return { query: "task: search result | query: ", document: "title: none | text: " }
  if (/e5/i.test(model)) return { query: "query: ", document: "passage: " }
  return { query: "", document: "" }
}

export async function loadLocalEmbedder(): Promise<TextEmbedder> {
  const model = process.env.LIAISON_TOOL_MEANING_MODEL || DEFAULT_MODEL
  const { pipeline, env } = await import("@huggingface/transformers")
  if (process.env.LIAISON_MODEL_CACHE_DIR) env.cacheDir = process.env.LIAISON_MODEL_CACHE_DIR
  const extract = await pipeline("feature-extraction", model, {
    dtype: DEFAULT_DTYPE,
  })
  const pre = prefixes(model)
  return {
    id: `local:${model}`,
    async embed(texts, kind) {
      const p = kind === "query" ? pre.query : pre.document
      const out = await extract(
        texts.map((t) => p + t),
        { pooling: "mean", normalize: true },
      )
      return out.tolist() as Vector[]
    },
  }
}
