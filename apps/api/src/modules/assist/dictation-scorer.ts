// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Scoring for dictation: the word error rate the transcription bake-off ranks
// models by (S4), and the clean-up checks (S5): none of a clip's annotated
// fillers survive, every annotated must-keep term does. Pure functions over
// strings, plus the schema of the committed fixture manifest
// (`__fixtures__/dictation/clips.json`) they are run against.
import { z } from "zod"

/**
 * Words for comparison: NFC, lowercase, typographic apostrophes folded to
 * `'`, hyphens and slashes split words, every other character that is not a
 * letter, digit or in-word apostrophe dropped. A French elision is split off
 * (`c'est` is `c'` + `est`, so `l'OMC` still holds the word `omc`); `it's`
 * stays one word and `'cause` becomes `cause`.
 */
export function normalizeWords(text: string): string[] {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[-‐‑‒–—/_]/g, " ")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^'+|'+$/g, ""))
    .flatMap(splitElision)
    .filter((word) => word.length > 0)
}

/** French elided articles and pronouns are their own word: `l'OMC` is `l'` + `omc`. */
const ELISION = /^(l|d|j|m|n|s|t|c|qu|jusqu|lorsqu|puisqu)'(?=\p{L})/u

function splitElision(word: string): string[] {
  const match = ELISION.exec(word)
  return match ? [`${match[1]}'`, word.slice(match[0].length)] : [word]
}

export interface WerResult {
  /** Substitutions + deletions + insertions. */
  errors: number
  referenceWords: number
  /** errors / referenceWords (1 when the reference is empty and the hypothesis is not). */
  wer: number
}

/**
 * Hesitation sounds (English and French). Transcription scoring ignores them
 * on both sides: whether a model writes "um" says nothing about whether it
 * heard the words, and the clean-up removes them anyway.
 */
export const HESITATION_TOKENS: ReadonlySet<string> = new Set([
  "um",
  "umm",
  "uh",
  "uhm",
  "hmm",
  "mm",
  "mhm",
  "euh",
  "heu",
  "hum",
  "eh",
])

/** Word error rate: standard Levenshtein distance over normalized words. */
export function wordErrorRate(
  reference: string,
  hypothesis: string,
  options: { ignore?: ReadonlySet<string> } = {},
): WerResult {
  const keep = (word: string): boolean => !options.ignore?.has(word)
  const ref = normalizeWords(reference).filter(keep)
  const hyp = normalizeWords(hypothesis).filter(keep)
  let previous = Array.from({ length: hyp.length + 1 }, (_, j) => j)
  for (let i = 1; i <= ref.length; i++) {
    const current = [i]
    for (let j = 1; j <= hyp.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (ref[i - 1] === hyp[j - 1] ? 0 : 1)
      const deletion = (previous[j] ?? 0) + 1
      const insertion = (current[j - 1] ?? 0) + 1
      current.push(Math.min(substitution, deletion, insertion))
    }
    previous = current
  }
  const errors = previous[hyp.length] ?? 0
  const wer = ref.length === 0 ? (hyp.length === 0 ? 0 : 1) : errors / ref.length
  return { errors, referenceWords: ref.length, wer }
}

/** True when `phrase`'s normalized words occur contiguously in `words`. */
function containsPhrase(words: readonly string[], phrase: string): boolean {
  const needle = normalizeWords(phrase)
  if (needle.length === 0) return false
  for (let start = 0; start + needle.length <= words.length; start++) {
    if (needle.every((word, k) => words[start + k] === word)) return true
  }
  return false
}

/** A must-keep term: one spelling, or the accepted spellings of one term. */
export type MustKeep = string | readonly string[]

function spellings(term: MustKeep): readonly string[] {
  return typeof term === "string" ? [term] : term
}

/** The term's label in a report: its first spelling. */
function label(term: MustKeep): string {
  return spellings(term)[0] ?? ""
}

export interface CleanupScore {
  /** Annotated fillers still present in the cleaned text. */
  fillersRemaining: string[]
  /** Must-keep terms absent from the cleaned text, whatever the cause. */
  mustKeepMissing: string[]
  /** Must-keep terms the raw transcript had and the clean-up lost. */
  mustKeepDroppedByCleanup: string[]
  /**
   * The clean-up's verdict: no filler left and nothing it was given dropped.
   * A term the transcription itself missed is the model's error (it counts in
   * the WER), not the clean-up's, so it is reported but does not fail this.
   */
  pass: boolean
}

export function scoreCleanup(input: {
  raw: string
  cleaned: string
  fillers: readonly string[]
  mustKeep: readonly MustKeep[]
}): CleanupScore {
  const raw = normalizeWords(input.raw)
  const cleaned = normalizeWords(input.cleaned)
  const kept = (words: readonly string[], term: MustKeep): boolean =>
    spellings(term).some((spelling) => containsPhrase(words, spelling))
  const fillersRemaining = input.fillers.filter((filler) => containsPhrase(cleaned, filler))
  const missing = input.mustKeep.filter((term) => !kept(cleaned, term))
  const dropped = missing.filter((term) => kept(raw, term))
  return {
    fillersRemaining,
    mustKeepMissing: missing.map(label),
    mustKeepDroppedByCleanup: dropped.map(label),
    pass: fillersRemaining.length === 0 && dropped.length === 0,
  }
}

/**
 * Function words that mark French or English running text. A word both
 * languages use ("on", "a", "de" as a name) is in neither list.
 */
const FRENCH_MARKERS: ReadonlySet<string> = new Set([
  "le",
  "la",
  "les",
  "des",
  "du",
  "au",
  "aux",
  "un",
  "une",
  "et",
  "est",
  "sont",
  "que",
  "qui",
  "pour",
  "dans",
  "sur",
  "avec",
  "mais",
  "pas",
  "nous",
  "vous",
  "je",
  "il",
  "elle",
  "ils",
  "ce",
  "cette",
  "ces",
  "ont",
  "être",
  "très",
  "l'",
  "d'",
  "c'",
  "j'",
  "qu'",
  "n'",
  "s'",
])
const ENGLISH_MARKERS: ReadonlySet<string> = new Set([
  "the",
  "and",
  "is",
  "are",
  "of",
  "to",
  "that",
  "we",
  "you",
  "it",
  "for",
  "in",
  "this",
  "with",
  "have",
  "not",
  "but",
  "be",
  "they",
  "was",
  "what",
  "i",
  "so",
  "just",
])

/**
 * The language a text is written in, read off its function words: the one
 * whose markers occur more often, null on a tie (a list of names and numbers).
 * Enough to tell a clean-up that kept French from one that translated it.
 */
export function dominantLanguage(text: string): "en" | "fr" | null {
  let fr = 0
  let en = 0
  for (const word of normalizeWords(text)) {
    if (FRENCH_MARKERS.has(word)) fr++
    if (ENGLISH_MARKERS.has(word)) en++
  }
  if (fr === en) return null
  return fr > en ? "fr" : "en"
}

/** Nearest-rank percentile (p in 0..100); null without samples. */
export function percentile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null
}

/** One clip of `__fixtures__/dictation/clips.json`. */
export const dictationClipSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** The audio file beside clips.json. */
  file: z.string().regex(/^[a-z0-9-]+\.webm$/),
  lang: z.enum(["en", "fr"]),
  durationSeconds: z.number().min(5).max(60),
  /**
   * A text-to-speech reading of a scripted text: scored for filler removal
   * only, never in the word error rate that picks the model.
   */
  synthetic: z.boolean(),
  source: z.object({
    corpus: z.string().min(1),
    url: z.string().url(),
    /** The corpus's own ids for the segment(s) the clip was cut from. */
    segments: z.array(z.string().min(1)).min(1),
  }),
  licence: z.enum(["CC-BY-4.0", "CC0-1.0", "generated"]),
  attribution: z.string().min(1),
  /** What was said: the corpus's validated transcript, or the script read. */
  reference: z.string().min(1),
  /** Filler words, repetitions and false starts in the reference (phrases). */
  fillers: z.array(z.string().min(1)),
  mustKeep: z.array(z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])).min(1),
  notes: z.string().optional(),
})
export type DictationClip = z.infer<typeof dictationClipSchema>

export const dictationManifestSchema = z.object({
  description: z.string(),
  clips: z.array(dictationClipSchema).min(1),
})
export type DictationManifest = z.infer<typeof dictationManifestSchema>
