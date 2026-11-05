// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The second browser walk of a French org (2026-09-23) still read English in
// places no catalog lookup reached: copy built from DATA at display time (a
// ticket's raw status, an org default view's seeded name, a stored approval
// title, a scope description, an agent error line). Each helper below turns
// that data into the reader's language; these pin the French.

import { render } from "@solidjs/testing-library"
import { describe, expect, test, vi } from "vitest"
import { categoryChip, scopeLabel } from "~/lib/capability-copy"
import { defaultPurpose } from "~/modules/agent/AgentOverviewTab"
import {
  approvalActionLabel,
  approvalRowTitle,
  localizeApprovalText,
} from "~/modules/approvals/approval-copy"
import { prettyStatus } from "~/modules/projects/status-label"
import { chartMoney } from "~/modules/settings/UsageSettings"
import { savedViewDisplayName } from "~/modules/shell/saved-views/SavedViewsList"
import { localizeAgentNotice } from "~/modules/threads/agent-notice"
import { ticketChipLabel } from "~/modules/tickets/TicketsInbox"
import { I18nProvider, seededCopy, translatorFor } from "./i18n-context"

const fr = translatorFor("fr")
const en = translatorFor("en")

describe("ticket row chips", () => {
  test("status and priority read in French, not as the raw value", () => {
    expect(ticketChipLabel(fr, "status", "open")).toBe("Ouvert")
    expect(ticketChipLabel(fr, "status", "awaiting_customer")).toBe("En attente du client")
    expect(ticketChipLabel(fr, "priority", "normal")).toBe("Normale")
    expect(ticketChipLabel(en, "priority", "high")).toBe("High")
    // An unknown value keeps its own words rather than a missing key.
    expect(ticketChipLabel(fr, "status", "on_hold")).toBe("on hold")
  })
})

describe("org default saved views", () => {
  const row = (over: Partial<Parameters<typeof savedViewDisplayName>[0]>) => ({
    app: "tickets",
    viewId: "inbox",
    manifestKey: "my-open",
    name: "My open tickets",
    isDefault: true,
    ...over,
  })

  test("a seeded default reads in the reader's language", () => {
    expect(savedViewDisplayName(row({}), fr)).toBe("Mes tickets ouverts")
    expect(
      savedViewDisplayName(
        row({ app: "projects", viewId: "home", manifestKey: "due-soon", name: "Due this week" }),
        fr,
      ),
    ).toBe("À échéance cette semaine")
  })

  test("a renamed default, and a personal view, keep the name as written", () => {
    expect(savedViewDisplayName(row({ name: "Mes urgences" }), fr)).toBe("Mes urgences")
    expect(savedViewDisplayName(row({ isDefault: false, manifestKey: null }), fr)).toBe(
      "My open tickets",
    )
  })
})

describe("approvals on Home, in the reviewer's language", () => {
  const frCtx = { t: fr, locale: "fr" }
  const enCtx = { t: en, locale: "en" }

  test("the action badge is rebuilt from the tool id", () => {
    expect(approvalActionLabel("kpi:kpi_propose_edit", "Kpi: kpi propose edit", frCtx)).toBe(
      "KPI : proposer une modification",
    )
    expect(approvalActionLabel("kernel:edit_role", "Kernel: edit role", frCtx)).toBe(
      "Espace de travail : modifier un rôle",
    )
    expect(
      approvalActionLabel(
        "remediation:rgpd_delete_customer",
        "Remediation: delete rgpd customer",
        frCtx,
      ),
    ).toBe("Remédiation : supprimer un client (RGPD)")
    // English keeps the server's words, except an older row's "Kernel" app
    // name, which reads "Workspace" like everywhere else; an unknown tool keeps them too.
    expect(approvalActionLabel("kernel:edit_role", "Kernel: edit role", enCtx)).toBe(
      "Workspace: edit role",
    )
    expect(approvalActionLabel("tickets:reply", "Tickets: reply", enCtx)).toBe("Tickets: reply")
    expect(approvalActionLabel("acme:do_thing", "Acme: do thing", frCtx)).toBe("Acme: do thing")
  })

  test("a stalled action-only row reads in French", () => {
    const item = {
      summary: "Stalled: Remediation: delete rgpd customer",
      metadata: {
        toolName: "remediation:rgpd_delete_customer",
        actionLabel: "Remediation: delete rgpd customer",
        wedged: true,
        titleKind: "action",
        baseTitle: "Remediation: delete rgpd customer",
      },
    }
    expect(approvalRowTitle(item, frCtx)).toBe("Bloquée : Remédiation : supprimer un client (RGPD)")
    expect(approvalRowTitle(item, enCtx)).toBe("Stalled: Remediation: delete rgpd customer")
    // An older cached item without the structure still loses the English prefix.
    expect(
      approvalRowTitle(
        { summary: item.summary, metadata: { toolName: item.metadata.toolName, wedged: true } },
        frCtx,
      ),
    ).toBe("Bloquée : Remediation: delete rgpd customer")
  })

  test("a payload-derived title keeps its detail and translates the action", () => {
    expect(
      approvalRowTitle(
        {
          summary: "Kpi propose edit: Panier moyen par journée",
          metadata: {
            toolName: "kpi:kpi_propose_edit",
            titleKind: "derived",
            titleDetail: "Panier moyen par journée",
            baseTitle: "Kpi propose edit: Panier moyen par journée",
          },
        },
        frCtx,
      ),
    ).toBe("Proposer une modification : Panier moyen par journée")
  })

  test("a bundle head is named after its outcome step, not the gated head", () => {
    expect(
      approvalRowTitle(
        {
          summary: "Remediation: delete rgpd customer",
          metadata: {
            toolName: "kpi:kpi_propose_edit",
            outcomeToolName: "remediation:rgpd_delete_customer",
            actionLabel: "Remediation: delete rgpd customer",
            titleKind: "action",
            baseTitle: "Remediation: delete rgpd customer",
            bundleSteps: 2,
          },
        },
        frCtx,
      ),
    ).toBe("Remédiation : supprimer un client (RGPD)")
  })

  test("the edit role summary and its lines are translated from the known templates", () => {
    expect(
      approvalRowTitle(
        {
          summary: 'Edit role "support-business-analyst" (-1 scope)',
          metadata: { toolName: "kernel:edit_role", titleKind: "summary" },
        },
        frCtx,
      ),
    ).toBe("Modifier le rôle « support-business-analyst » (-1 droit)")
    expect(localizeApprovalText("REVOKE these scopes from the role:", frCtx)).toBe(
      "RETIRER ces droits du rôle :",
    )
    expect(
      localizeApprovalText(
        "Every current and future member of this role inherits the resulting scope set.",
        frCtx,
      ),
    ).toBe(
      "Chaque membre actuel et futur de ce rôle hérite de l'ensemble de droits qui en résulte.",
    )
    expect(localizeApprovalText("Reply to Fabien on ticket-10013", frCtx)).toBe(
      "Répondre à Fabien sur ticket-10013",
    )
    // Data is shown as written.
    expect(localizeApprovalText("metricId: inscrits_periode", frCtx)).toBe(
      "metricId: inscrits_periode",
    )
  })
})

describe("agents in Chats and Agents", () => {
  test("a failed turn says what happened in French; its summary never shows the provider's text", () => {
    const stored =
      "⚠️ I couldn't complete that response — the AI provider returned an error:\n\nYour project has exceeded its monthly spending cap. Please go to AI Studio at https://ai.studio/spend to manage your project spend cap."
    const out = localizeAgentNotice(stored, fr)
    expect(out).toBe(
      "⚠️ Le service d'IA est momentanément indisponible (plafond de dépenses atteint). Prévenez un administrateur.",
    )
    expect(out).not.toContain("http")
    expect(
      localizeAgentNotice(
        "⚠️ I couldn't complete that response — the AI provider returned an error. Please try again in a moment.",
        fr,
      ),
    ).toBe(
      "⚠️ Je n'ai pas pu terminer cette réponse : le service d'IA a renvoyé une erreur. Réessayez dans un instant.",
    )
    // An ordinary message is left alone.
    expect(localizeAgentNotice("Voici un aperçu", fr)).toBe("Voici un aperçu")
  })

  test("in the conversation a failed turn shows its real detail under the French line", () => {
    const stored =
      "⚠️ I couldn't complete that response: the AI service returned an error. Please try again in a moment.\n\nThis demo's agent budget for your address is spent."
    expect(
      localizeAgentNotice(stored, fr, { agentNotice: "provider_error" }, { withDetail: true }),
    ).toBe(
      "⚠️ Je n'ai pas pu terminer cette réponse : le service d'IA a renvoyé une erreur. Réessayez dans un instant.\n\nThis demo's agent budget for your address is spent.",
    )
  })

  test("a personal agent and the base agent have a purpose line in the reader's language", () => {
    expect(defaultPurpose({ kind: "personal", handle: "@avery" }, fr)).toContain(
      "Votre assistant personnel",
    )
    expect(defaultPurpose({ kind: "system", handle: "@base" }, fr)).toContain("L'agent de base")
    expect(defaultPurpose({ kind: "role", handle: "@data" }, fr)).toBe(
      "Aucun objectif enregistré pour l'instant.",
    )
  })
})

describe("the personal agent's state and name", () => {
  test("the state token reads as a word", async () => {
    vi.resetModules()
    const i18n = await import("./i18n-context")
    const { agentStateLabel } = await import("~/modules/threads/agent-name")
    // Without a provider the active locale is English.
    expect(agentStateLabel("active")).toBe("Active")
    expect(agentStateLabel("")).toBe("")
    expect(i18n.translatorFor("fr")("kernel.agents.agentState.active")).toBe("Actif")
  })
})

describe("capabilities on the agent Settings tab", () => {
  test("scope descriptions, approver scopes and derived phrases read in French", () => {
    const r = render(() => (
      <I18nProvider initialLocale="fr">
        <span />
      </I18nProvider>
    ))
    // The server's English description is not what a French reader gets.
    expect(scopeLabel("kernel:contacts:read", fr, "Read contacts")).toBe(
      "Espace de travail : Lire les contacts",
    )
    expect(
      scopeLabel(
        "calendar:approve",
        fr,
        "Decide (approve, edit, or deny) calendar approvals raised by its gated tools",
      ),
    ).toBe(
      "Agenda : décider (approuver, modifier ou refuser) des demandes d'approbation de ses outils soumis à approbation",
    )
    expect(scopeLabel("mail:drafts:read", fr)).toBe("Mail : lire les brouillons")
    expect(scopeLabel("tickets:categories:read", fr)).toBe("Tickets : lire les catégories")
    expect(categoryChip("*", fr).label).toBe("tout ce que cet espace de travail permet")
    r.unmount()
  })
})

describe("settings and projects data seeded in English", () => {
  test("seeded project columns, role and app descriptions read in French; edited ones stay", () => {
    const r = render(() => (
      <I18nProvider initialLocale="fr">
        <span />
      </I18nProvider>
    ))
    expect(prettyStatus("in_progress")).toBe("En cours")
    expect(prettyStatus("backlog")).toBe("À planifier")
    expect(prettyStatus("Idea")).toBe("Idea")
    expect(
      seededCopy(
        "Team lead — manages inboxes, categories, accounts; can close tickets",
        "kernel.roleDescriptions.tickets__support_lead",
      ),
    ).toBe(
      "Chef d'équipe : gère les boîtes de réception, les catégories et les comptes, peut clôturer les tickets",
    )
    expect(seededCopy("Our own wording", "kernel.roleDescriptions.tickets__support_lead")).toBe(
      "Our own wording",
    )
    expect(
      seededCopy(
        "Liaison Invoicing app: invoices, quotes, proformas, purchase orders, credit notes.",
        "kernel.appDescriptions.invoicing",
      ),
    ).toBe("Facturation Liaison : factures, devis, factures proforma, bons de commande, avoirs.")
    // The usage chart's axis uses the same locale money format as its table.
    expect(chartMoney(2.5, "EUR")).toBe(
      new Intl.NumberFormat("fr", { style: "currency", currency: "EUR" }).format(2.5),
    )
    r.unmount()
  })
})
