// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHICH LANGUAGE THIS TURN'S ANSWER IS IN, said per turn.
//
// The stable `## Language` rule ("answer in the language of their message")
// sits thousands of tokens above the message it is about, and a weak model
// weighs it against a history written in another language and loses: asked in
// English in a DM whose earlier exchanges were French, the personal agent
// answered in French, twice. So the tail names the language of THE message
// being answered, when it can be told with confidence, next to the request.
//
// The guess is deliberately small: function words of the languages the
// product ships (English, French), counted as whole words. It returns null
// rather than guess on a short or mixed message, and the tail then restates
// the rule without naming a language.

const FUNCTION_WORDS: Record<ReplyLanguage, ReadonlySet<string>> = {
  English: new Set(
    "the a an and or of to in on for with is are was were be been what which who how why when where my your our their it this that these those do does did can could would should will please i you we they me us not no yes have has from at by as if every".split(
      " ",
    ),
  ),
  French: new Set(
    "le la les un une des et ou de du au aux en dans sur pour avec est sont était être quoi quel quelle quels quelles qui comment pourquoi quand où mon ma mes ton ta tes notre nos votre vos leur leurs ce cet cette ces fais fait peux peut pouvez merci je tu nous vous ils elles moi pas oui non ai as avons avez ont que qu il elle on se sa son".split(
      " ",
    ),
  ),
}

export type ReplyLanguage = "English" | "French"

/** Minimum function word hits before a language is named at all. */
const MIN_HITS = 2

/**
 * Hits from which one message decides the language on its own, against what
 * the person wrote before. Below it a message is as likely pasted data (a
 * French address: "12 rue de la Paix" counts "de" and "la") as a switch of
 * language, and the person's earlier messages decide.
 */
const DECISIVE_HITS = 4

/** How many of the person's earlier messages the language is read from. */
const EARLIER_MESSAGES_READ = 6

interface LanguageEvidence {
  lang: ReplyLanguage
  hits: number
}

function languageEvidence(text: string): LanguageEvidence | null {
  const cleaned = text
    .replace(/@\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .toLowerCase()
  const words = cleaned.split(/[^\p{L}]+/u).filter(Boolean)
  const scores = (Object.keys(FUNCTION_WORDS) as ReplyLanguage[]).map((lang) => ({
    lang,
    hits: words.filter((w) => FUNCTION_WORDS[lang].has(w)).length,
  }))
  scores.sort((a, b) => b.hits - a.hits)
  const [best, next] = scores
  if (!best || best.hits < MIN_HITS) return null
  // A clear winner only: twice the runner up.
  if (next && best.hits < next.hits * 2) return null
  return best
}

/**
 * The language `text` is written in, or null when it cannot be told: too few
 * function words, or no clear winner. Mention tokens, links and code are
 * stripped first, since a pill label or a URL is not the person's language.
 */
export function guessMessageLanguage(text: string): ReplyLanguage | null {
  return languageEvidence(text)?.lang ?? null
}

/** What else tells the person's language besides the message being answered. */
export interface ReplyLanguageContext {
  /** What the person wrote earlier in this conversation, oldest first. */
  earlierMessages?: readonly string[]
  /**
   * The language the person (or, failing that, their org) chose in Settings,
   * as a locale code ("en", "fr"); null when neither chose one.
   */
  locale?: string | null
}

/**
 * Whether a message carries data whose words are not the person's language:
 * an address, a postcode, an amount, an id. Digits are the tell.
 */
function carriesData(text: string): boolean {
  return /\d/.test(text.replace(/@\[[^\]]*\]\([^)]*\)/g, " "))
}

function localeLanguage(locale: string | null | undefined): ReplyLanguage | null {
  const code = locale?.toLowerCase().split(/[-_]/)[0]
  if (code === "fr") return "French"
  if (code === "en") return "English"
  return null
}

/**
 * The language to answer in: the message itself when it says so clearly; else
 * the language of what the person wrote before; else their locale setting;
 * else the message's own weak guess. Never the language of the data a message
 * carries or a tool returned.
 */
export function replyLanguage(
  messageText: string | null | undefined,
  context: ReplyLanguageContext = {},
): ReplyLanguage | null {
  const current = messageText ? languageEvidence(messageText) : null
  if (current && current.hits >= DECISIVE_HITS) return current.lang
  // A short message that is clearly one language and carries no data (no
  // address, no number) is the person switching: "Oui, fais-le." decides.
  if (current && messageText && !carriesData(messageText)) return current.lang
  const earlierText = (context.earlierMessages ?? []).slice(-EARLIER_MESSAGES_READ).join("\n")
  const earlier = earlierText ? languageEvidence(earlierText) : null
  if (earlier) return earlier.lang
  return localeLanguage(context.locale) ?? current?.lang ?? null
}

/** The per turn tail line. Always present, so the rule is never only far away. */
export function replyLanguageLine(
  messageText: string | null | undefined,
  context: ReplyLanguageContext = {},
): string {
  const lang = replyLanguage(messageText, context)
  if (lang) {
    return `The person you are answering writes in ${lang}: write your answer in ${lang}, even where earlier messages in this conversation, tool results or refusals are in another language. The language of the data (addresses, names, files and tool results) never decides it.`
  }
  return "Write your answer in the language the person writes in, even where earlier messages in this conversation are in another language. The language of the data (addresses, names, files and tool results) never decides it."
}
