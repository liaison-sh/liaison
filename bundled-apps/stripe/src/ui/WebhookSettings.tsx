// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings > Apps > Stripe > Webhook, the app's half: the steps in Stripe and the exact events to
// select (the ones the event handler acts on). The kernel's `appSecrets` block beside it shows the
// endpoint address and takes the signing secret: this bundle never sees or sends the secret.
import { type Component, For } from "solid-js"
import { WEBHOOK_EVENTS } from "../webhook-events"
import { tr } from "./i18n"

export const StripeWebhookSettings: Component = () => (
  <div
    class="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 text-[13px]"
    data-testid="stripe-webhook-settings"
  >
    <span class="text-text-secondary">
      {tr(
        "In Stripe: Developers, Webhooks, Add endpoint. Paste the endpoint URL, select the events below, then reveal the endpoint's Signing secret and save it here.",
      )}
    </span>
    <details data-testid="stripe-webhook-events">
      <summary class="cursor-pointer font-medium">
        {tr("Events to select ({{count}})", { count: WEBHOOK_EVENTS.length })}
      </summary>
      <ul class="mt-1 grid gap-0.5 font-mono text-[12px] md:grid-cols-2">
        <For each={[...WEBHOOK_EVENTS]}>{(ev) => <li>{ev}</li>}</For>
      </ul>
    </details>
  </div>
)
