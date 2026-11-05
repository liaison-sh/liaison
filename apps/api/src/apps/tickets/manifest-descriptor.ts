// SPDX-License-Identifier: FSL-1.1-ALv2

import { readFile } from "node:fs/promises"
import { ticketsSettingsDefaults } from "@liaison/shared"
import { resolveGoogleOAuthClientConfig } from "~/modules/settings/google-integration"
import ticketsManifestJson from "./app.manifest.json"

// Skill bodies live as on-disk markdown next to the descriptor (app.manifest.json stays
// JSON-pure); the descriptor injects them with lazy loaders resolved at app-register time —
// the same pattern as knowledge/manifest-descriptor.ts.
const REPLY_PLAYBOOK_BODY = new URL("./skills/reply-playbook.md", import.meta.url).pathname
const VIP_ESCALATION_BODY = new URL("./skills/vip-escalation.md", import.meta.url).pathname
const EXPORT_DISCIPLINE_BODY = new URL("./skills/export-discipline.md", import.meta.url).pathname

export const ticketsAppManifest = {
  ...ticketsManifestJson,
  skills: {
    // Because this `skills` object carries function bodies, the descriptor's whole `skills` key
    // replaces the JSON's — so re-merge any JSON-declared skills (e.g. a guide) first.
    ...(ticketsManifestJson as { skills?: Record<string, unknown> }).skills,
    "reply-playbook": {
      description: "How to draft a customer support reply that will pass human approval.",
      requiredScopes: ["tickets:tickets:reply"],
      body: async () => readFile(REPLY_PLAYBOOK_BODY, "utf8"),
    },
    "vip-escalation": {
      description: "When and how to escalate a VIP customer ticket without overpromising.",
      requiredScopes: ["tickets:tickets:reply", "tickets:tickets:write"],
      body: async () => readFile(VIP_ESCALATION_BODY, "utf8"),
    },
    "export-discipline": {
      description: "How to export ticket data safely without leaking or overscoping.",
      requiredScopes: ["tickets:tickets:read"],
      body: async () => readFile(EXPORT_DISCIPLINE_BODY, "utf8"),
    },
  },
  _format: "manifest" as const,
  _bundlePath: new URL("./handlers.ts", import.meta.url).pathname,
  // Wire the gmail connection to the per-org (or deployment) Google OAuth client -- mirrors the
  // mail app. Without this the resolver registry has no entry for tickets:gmail and startOAuthFlow
  // throws "OAuth provider not configured". (Unlike mail's resolver this does NOT gate on a mail
  // provider being enabled -- tickets owns its own Gmail inbox.)
  _oauthClientResolvers: {
    gmail: async ({ orgId }: { orgId: string }) => resolveGoogleOAuthClientConfig(orgId),
  },
  orgSettings: { defaults: ticketsSettingsDefaults },
}
