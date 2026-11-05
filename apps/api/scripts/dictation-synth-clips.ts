// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Writes the SYNTHETIC dictation fixture clips: a text-to-speech model reads
 * a scripted, deliberately hesitant text (written "um", "euh", repetitions,
 * false starts), so the clean-up scorer has clips whose fillers are known
 * exactly. Real speech for the word error rate comes from the corpora (see
 * clips.json); synthetic clips are scored for filler removal only.
 *
 * Owns every `synthetic: true` entry of
 * `src/modules/assist/__fixtures__/dictation/clips.json`: regenerates their
 * audio and replaces those entries, leaving the real clips untouched.
 *
 * Usage (from the repo root, ffmpeg and ffprobe on PATH):
 *   set -a; source .env.test; set +a; bun run apps/api/scripts/dictation-synth-clips.ts
 *
 * Cost: eight short readings on google/gemini-3.8-flash-lite-tts, well under
 * one US cent in total.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { type DictationClip, dictationManifestSchema } from "../src/modules/assist/dictation-scorer"

const FIXTURES = path.join(import.meta.dir, "../src/modules/assist/__fixtures__/dictation")
const MANIFEST = path.join(FIXTURES, "clips.json")
const MODEL = "google/gemini-3.8-flash-lite-tts"
const ENDPOINT = `${process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"}/audio/speech`

interface Script {
  id: string
  lang: "en" | "fr"
  voice: string
  text: string
  fillers: string[]
  mustKeep: (string | string[])[]
}

const INSTRUCTIONS: Record<Script["lang"], string> = {
  en: "Speak casually, like someone dictating a quick note. Say every hesitation and repetition exactly as written.",
  fr: "Parle de façon naturelle, comme quelqu'un qui dicte une note rapide. Prononce chaque hésitation et chaque répétition exactement comme elles sont écrites.",
}

const SCRIPTS: Script[] = [
  {
    id: "en-synth-01",
    lang: "en",
    voice: "Kore",
    text: "Um, so I just wanted to, uh, follow up on the the order from Harbour Supplies. Invoice number 4512 went out on March third, and, um, they still haven't paid it.",
    fillers: ["um", "uh", "the the"],
    mustKeep: [
      "harbour supplies",
      ["4512", "forty five twelve"],
      ["march third", "march 3rd", "march 3"],
    ],
  },
  {
    id: "en-synth-02",
    lang: "en",
    voice: "Puck",
    text: "Hi Daniel, uh, quick note. The, the replacement unit, um, ships tomorrow by courier, and you should, you should get it before Friday. Uh, the tracking code is in the ticket.",
    fillers: ["uh", "um", "the the", "you should you should"],
    mustKeep: ["daniel", "replacement unit", "tomorrow", "friday", "tracking code"],
  },
  {
    id: "en-synth-03",
    lang: "en",
    voice: "Aoede",
    text: "Okay so, um, for the meeting on Tuesday at ten thirty, I, I think we need, uh, the Q3 numbers, the revenue and the churn, and, um, Sarah's slides.",
    fillers: ["um", "uh", "i i"],
    mustKeep: [
      "tuesday",
      ["ten thirty", "10 30"],
      ["q3", "q 3", "third quarter"],
      "revenue",
      "churn",
      "sarah's",
    ],
  },
  {
    id: "en-synth-04",
    lang: "en",
    voice: "Charon",
    text: "Uh, can you, can you reset the password for the warehouse account? Um, it's the one ending in zero zero eight seven, and, uh, the user has been locked out since this morning.",
    fillers: ["uh", "um", "can you can you"],
    mustKeep: [
      "password",
      "warehouse account",
      ["zero zero eight seven", "0087", "00 87", "87"],
      "locked out",
      "this morning",
    ],
  },
  {
    id: "fr-synth-01",
    lang: "fr",
    voice: "Kore",
    text: "Euh, bonjour Claire, je voulais, euh, te dire que la la commande numéro 2087 est partie mardi, et, ben, le client devrait la recevoir jeudi.",
    fillers: ["euh", "la la", "ben"],
    mustKeep: ["claire", ["2087", "deux mille quatre vingt sept"], "mardi", "jeudi"],
  },
  {
    id: "fr-synth-02",
    lang: "fr",
    voice: "Puck",
    text: "Alors, euh, pour la réunion de vendredi à quatorze heures, il faudrait, il faudrait préparer, heu, le budget de douze mille euros et la liste des fournisseurs.",
    fillers: ["euh", "heu", "il faudrait il faudrait"],
    mustKeep: [
      "vendredi",
      ["quatorze heures", "14 heures", "14h", "14 h"],
      ["douze mille euros", "12 000 euros", "12000 euros", "12 000 €", "12000 €"],
      "fournisseurs",
    ],
  },
  {
    id: "fr-synth-03",
    lang: "fr",
    voice: "Aoede",
    text: "Bon, euh, le client Martin a appelé ce matin, il dit que, que la facture du trois mars est, euh, incorrecte, il manque la remise de dix pour cent.",
    fillers: ["euh", "que que"],
    mustKeep: [
      "martin",
      "ce matin",
      ["trois mars", "3 mars"],
      "facture",
      "remise",
      ["dix pour cent", "10 pour cent", "10"],
    ],
  },
  {
    id: "fr-synth-04",
    lang: "fr",
    voice: "Charon",
    text: "Euh, tu peux, tu peux relancer le fournisseur Durand pour la livraison ? Euh, c'est la référence AB 552, et, heu, on l'attend depuis lundi.",
    fillers: ["euh", "heu", "tu peux tu peux"],
    mustKeep: ["durand", "livraison", ["ab 552", "ab552"], "lundi"],
  },
]

function run(command: string[]): string {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    throw new Error(`${command[0]} failed: ${result.stderr.toString()}`)
  }
  return result.stdout.toString()
}

/** One TTS reading as raw 16-bit PCM, with the sample rate the response names. */
async function speak(apiKey: string, script: Script): Promise<{ pcm: Uint8Array; rate: number }> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      input: script.text,
      voice: script.voice,
      instructions: INSTRUCTIONS[script.lang],
      // Gemini TTS answers PCM only.
      response_format: "pcm",
      provider: { data_collection: "deny" },
    }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!response.ok) {
    throw new Error(`${script.id}: TTS ${response.status} ${await response.text()}`)
  }
  const type = response.headers.get("content-type") ?? ""
  const rate = Number(/rate=(\d+)/.exec(type)?.[1] ?? "24000")
  return { pcm: new Uint8Array(await response.arrayBuffer()), rate }
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set (source .env.test)")
  const manifest = dictationManifestSchema.parse(JSON.parse(readFileSync(MANIFEST, "utf8")))
  const scratch = mkdtempSync(path.join(tmpdir(), "dictation-synth-"))
  const synthetic: DictationClip[] = []
  try {
    for (const script of SCRIPTS) {
      const { pcm, rate } = await speak(apiKey, script)
      const raw = path.join(scratch, `${script.id}.pcm`)
      writeFileSync(raw, pcm)
      const file = `${script.id}.webm`
      const out = path.join(FIXTURES, file)
      run([
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "s16le",
        "-ar",
        String(rate),
        "-ac",
        "1",
        "-i",
        raw,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "libopus",
        "-b:a",
        "24k",
        "-application",
        "voip",
        out,
      ])
      const seconds = Number(
        run([
          "ffprobe",
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "csv=p=0",
          out,
        ]).trim(),
      )
      synthetic.push({
        id: script.id,
        file,
        lang: script.lang,
        durationSeconds: Math.round(seconds * 100) / 100,
        synthetic: true,
        source: {
          corpus: "Generated for Liaison",
          url: "https://openrouter.ai/docs/guides/overview/multimodal/tts",
          segments: [`${MODEL} voice ${script.voice}`],
        },
        licence: "generated",
        attribution: `Scripted text read by ${MODEL} (voice ${script.voice}) through OpenRouter, generated by apps/api/scripts/dictation-synth-clips.ts.`,
        reference: script.text,
        fillers: script.fillers,
        mustKeep: script.mustKeep,
        notes:
          "Synthetic: scored for filler removal and must-keep only, never in the word error rate.",
      })
      console.log(`${script.id}: ${seconds.toFixed(1)} s`)
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  const next = dictationManifestSchema.parse({
    ...manifest,
    clips: [...manifest.clips.filter((clip) => !clip.synthetic), ...synthetic],
  })
  writeFileSync(MANIFEST, `${JSON.stringify(next, null, 2)}\n`)
  console.log(`clips.json: ${next.clips.length} clips (${synthetic.length} synthetic)`)
}

await main()
