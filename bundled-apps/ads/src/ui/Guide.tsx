// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Guide tab: static discoverability page for the marketing lead. Explains how
// to work with the Ads agent (doctrine, approval gating, weekly rhythm) and
// offers copyable example prompts per workflow. No tool calls, no settings
// surfaces: pure content composed from the shared kit. Copy uses
// navigator.clipboard with a brief "Copied" state per prompt block.
import { type Component, createSignal, For, Show } from "solid-js"
import { Card, PageHeader, SectionLabel } from "./kit"

// ── Content ──────────────────────────────────────────────────────────────────

interface GuideSection {
  title: string
  intro?: string
  prompts: string[]
  note?: string
}

const GUIDE_INTRO =
  "Ask the agent in any Liaison thread, in normal language. It knows our ad accounts, our sales data, and " +
  "a library of advertising know-how, so you do not need to be a marketer. Asking is always safe: anything " +
  "that spends money, stops ads, or sends customer data to an ad platform first shows up as an approval " +
  "card that a human must accept."

const GUIDE_SECTIONS: GuideSection[] = [
  {
    title: "The Monday report",
    intro:
      "Every Monday the agent posts a summary: what we spent on Facebook/Instagram and Google, what that " +
      "spend brought back, and anything that looks wrong. Just reply to it with questions.",
    prompts: [
      "Explain this week's report to me like I am new to this.",
      "We spent more than last week. Was it worth it?",
    ],
  },
  {
    title: "Launching or changing ads",
    intro:
      "Describe what you want to promote and how much you are willing to spend per day. The agent designs " +
      "the campaign, explains its choices, and stages everything for approval. Nothing runs until someone " +
      "approves.",
    prompts: [
      "I want to promote [product] with about [X] euros per day. Set something up and explain your plan in simple terms.",
      "Is any of our ad money being wasted right now? If so, prepare the changes and tell me why.",
      "Before we spend more on [campaign], how will we know if it worked?",
    ],
  },
  {
    title: "Reaching the right people",
    intro:
      "The agent can ask Meta to show our ads to people similar to our existing customers. It only ever " +
      "uses customers who agreed to this, and it tells you exactly how many were included.",
    prompts: [
      "Show our ads to people similar to our past buyers. How many customers can we legally use for that?",
      "Who are we currently showing ads to, in plain words?",
    ],
  },
  {
    title: "Ideas for the ads themselves",
    intro:
      "The library contains our customer profiles (who buys the product and why), what happened to similar " +
      "companies, and guidance on what makes music gear ads work.",
    prompts: [
      "Give me three ideas for a video ad aimed at [type of musician], based on what we know about our customers.",
      "What mistakes did similar companies make with their advertising that we should avoid?",
      "We have two versions of an ad. Set up a fair test to see which one works better.",
    ],
  },
  {
    title: "Is it working?",
    intro:
      "Numbers come from a calculator, not from the model's imagination, and always say where they came " +
      "from and what they can and cannot tell you.",
    prompts: [
      "For every euro we spent on ads this month, how much revenue did we get back?",
      "Which ads or channels actually brought sales last week?",
      "Facebook says our ads made X euros. Is that number real?",
    ],
  },
  {
    title: "Google Shopping problems",
    intro:
      "Google refuses to show some of our products for technical reasons. The agent can read the list and " +
      "say what to fix.",
    prompts: [
      "Google is not showing some of our products. What is wrong and what should we fix first?",
      "Which of those problems can we fix ourselves in Shopify?",
    ],
  },
  {
    title: "When to stop an ad",
    prompts: [
      "Which of our ads should we stop because they cost more than they bring in? Prepare the stops for approval.",
    ],
    note:
      "To answer precisely the agent needs to know how much profit each product makes. Until we provide " +
      "that, it will say so instead of guessing, and that is intentional.",
  },
]

const NEVER_DO =
  "It never spends, stops, or restarts ads and never sends customer data anywhere without an approval " +
  "card. It never claims an ad is running without checking. When data is missing it says so instead of " +
  "making numbers up."

// ── PromptBlock — one copyable example prompt ────────────────────────────────

const PromptBlock: Component<{ text: string }> = (props) => {
  const [copied, setCopied] = createSignal(false)
  let resetTimer: number | undefined

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.text)
      setCopied(true)
      if (resetTimer !== undefined) window.clearTimeout(resetTimer)
      resetTimer = window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard unavailable (permissions, insecure context): leave the
      // button label as Copy, the user can still select the text manually.
    }
  }

  return (
    <div
      data-testid="ads-guide-prompt"
      class="flex items-start justify-between gap-3 rounded-md border border-border-subtle bg-elevated px-3 py-2"
    >
      <span class="min-w-0 text-[12.5px] leading-relaxed text-text">{props.text}</span>
      <button
        type="button"
        data-testid="ads-guide-copy"
        onClick={() => void copy()}
        class="shrink-0 rounded-md border border-border bg-surface px-2 py-0.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
      >
        {copied() ? "Copied" : "Copy"}
      </button>
    </div>
  )
}

// ── GuideTab ─────────────────────────────────────────────────────────────────

export const GuideTab: Component = () => (
  <div data-testid="ads-guide" class="flex min-h-full flex-col">
    <PageHeader title="Guide" subtitle="How to work with the Ads agent, in plain language" />

    <div class="flex flex-col gap-4 p-4">
      <Card class="p-4" testid="ads-guide-intro">
        <SectionLabel>Start here</SectionLabel>
        <p class="mt-2 text-[12.5px] leading-relaxed text-text-secondary">{GUIDE_INTRO}</p>
      </Card>

      <For each={GUIDE_SECTIONS}>
        {(section) => (
          <Card class="p-4">
            <SectionLabel>{section.title}</SectionLabel>
            <Show when={section.intro}>
              <p class="mt-2 text-[12.5px] leading-relaxed text-text-secondary">{section.intro}</p>
            </Show>
            <div class="mt-3 flex flex-col gap-2">
              <For each={section.prompts}>{(prompt) => <PromptBlock text={prompt} />}</For>
            </div>
            <Show when={section.note}>
              <p class="mt-3 text-[11.5px] leading-relaxed text-text-tertiary">{section.note}</p>
            </Show>
          </Card>
        )}
      </For>

      <Card class="p-4" testid="ads-guide-never">
        <SectionLabel>What the agent will never do</SectionLabel>
        <p class="mt-2 text-[12.5px] leading-relaxed text-text-secondary">{NEVER_DO}</p>
      </Card>
    </div>
  </div>
)
