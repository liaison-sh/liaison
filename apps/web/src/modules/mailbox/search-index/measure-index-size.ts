// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The measurement blueprint task 10.4 makes mandatory: "index a representative
// 5k to 10k message sample, record the observed index-bytes-per-text-byte ratio
// in the spec before it is used to size any quota threshold".
//
// It is a script, not a test: the number it produces is a fact about a corpus
// and a library version, so it is recorded in the spec and in the phase ledger
// rather than asserted on every CI run, where a library bump would turn an
// honest change into a red build.
//
// Run it with:
//   bun apps/web/src/modules/mailbox/search-index/measure-index-size.ts
//
// The corpus is SYNTHETIC and the script says so, because a real corpus cannot
// be committed: the measurement is over messages built from an English word
// list with a Zipf-like frequency distribution, realistic length spread, and
// quoted reply chains (mail repeats itself, which matters: a repeated token
// costs the index almost nothing but costs the raw text a lot). The exact
// corpus parameters are printed with the result so the number is reproducible.

import { readFileSync } from "node:fs"
import { createFlexSearchIndexAdapter } from "./flexsearch-adapter"

const MESSAGE_COUNT = 8000
const WORDLIST = "/usr/share/dict/words"

function loadVocabulary(): string[] {
  let words: string[]
  try {
    words = readFileSync(WORDLIST, "utf8").split("\n")
  } catch {
    words = []
  }
  const usable = words
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word.length >= 3 && word.length <= 12 && /^[a-z]+$/.test(word))
  if (usable.length >= 5000) return usable.slice(0, 20000)
  // A machine with no word list still produces a number, from a generated
  // vocabulary of the same shape. The output says which was used.
  return Array.from({ length: 20000 }, (_, i) => `w${i.toString(36)}word`)
}

/** Deterministic, so two runs on the same machine give the same number. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function main(): void {
  const vocabulary = loadVocabulary()
  const random = makeRandom(20260827)
  // Zipf-like: index = floor(vocabulary.length * r^3) makes common words common.
  const word = () => vocabulary[Math.floor(vocabulary.length * random() ** 3)]!

  const adapter = createFlexSearchIndexAdapter()
  const messages: { metadata: string; content: string }[] = []
  const threadTails: string[] = []

  for (let i = 0; i < MESSAGE_COUNT; i++) {
    const paragraphs = 1 + Math.floor(random() * 4)
    const lines: string[] = []
    for (let p = 0; p < paragraphs; p++) {
      const length = 12 + Math.floor(random() * 60)
      lines.push(Array.from({ length }, word).join(" "))
    }
    // One message in three quotes the tail of an earlier one, which is what a
    // real mailbox looks like and what makes the raw-text denominator grow
    // faster than the index does.
    if (threadTails.length > 0 && random() < 0.34) {
      lines.push(`> ${threadTails[Math.floor(random() * threadTails.length)]!}`)
    }
    const content = `${Array.from({ length: 4 }, word).join(" ")}\n${lines.join("\n")}`
    if (threadTails.length < 400) threadTails.push(lines[0]!)
    const metadata = `${word()}.${word()}@example.com ${word()}@example.net inbox ${word()}.pdf`
    messages.push({ metadata, content })
  }

  const encoder = new TextEncoder()
  let textBytes = 0
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    textBytes += encoder.encode(message.metadata).length + encoder.encode(message.content).length
    adapter.add({
      id: `m${i}`,
      accountId: "acc-1",
      conversationId: `conv-${i % 1200}`,
      sentAt: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString(),
      metadata: message.metadata,
      content: message.content,
    })
  }

  adapter.exportShards().then((shards) => {
    let indexBytes = 0
    for (const shard of shards) indexBytes += encoder.encode(shard.data).length
    const ratio = indexBytes / textBytes
    console.log(
      JSON.stringify(
        {
          library: "flexsearch@0.8.212",
          adapter: adapter.name,
          corpus: "synthetic, Zipf-like over /usr/share/dict/words, 34 percent quoted replies",
          vocabularySource: vocabulary[0]?.startsWith("w0") ? "generated" : WORDLIST,
          messages: MESSAGE_COUNT,
          shards: shards.length,
          textBytes,
          indexBytes,
          indexBytesPerTextByte: Number(ratio.toFixed(4)),
          bytesPerMessage: Math.round(indexBytes / MESSAGE_COUNT),
        },
        null,
        2,
      ),
    )
  })
}

main()
