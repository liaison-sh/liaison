// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE DESKTOP APP READ IN FRENCH (2026-09-23).
//
// A French business analyst runs an agent on her own computer with the desktop
// app in French. Every control this module draws was an English literal: the
// runtime control said "This machine", and the card she clicks to let the
// agent run a command said "Permission needed", "Bash", "Allow", "Deny". These
// render each surface inside a French provider and pin the words she reads,
// and pin that English is unchanged.

import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import type { DesktopToolActivity } from "~/lib/desktop-shell-contract"
import { I18nProvider, translatorFor } from "~/modules/i18n/i18n-context"
import { resetToastStore, toasts } from "~/modules/shell/toast-store"
import DesktopConnect from "./DesktopConnect"
import {
  DEVICE_LOGIN_OPEN_ACTION,
  DEVICE_LOGIN_WAITING,
  DeviceGrantStep,
} from "./DesktopDeviceApproval"
import { DEVICE_APPROVAL_DIALOG_TITLE } from "./DesktopDeviceApprovalDialog"
import {
  NOTICE_APPROVAL_STATUS_UNKNOWN,
  NOTICE_RECONNECT_NOT_APPROVED,
  NOTICE_WAITING_FOR_APPROVAL,
  reconnectCopyFor,
  startRefusalCopyFor,
} from "./desktop-notices"
import { installFakeBridge, liveSession, uninstallFakeBridge } from "./fake-bridge"
import LocalPermissionCard, { localToolLabel, resetLocalPrompts } from "./LocalPermissionCard"
import PermissionModeMenu from "./PermissionModeMenu"
import RuntimeBadge from "./RuntimeBadge"
import RuntimeControl from "./RuntimeControl"

const BASH_ROW: DesktopToolActivity = {
  id: "toolu_bash",
  toolName: "Bash",
  summary: "command: ls ~/Documents",
  status: "running",
  startedAt: 1_000,
}

const BASH_PROMPT = {
  requestId: "req-1",
  toolName: "Bash",
  summary: "command: ls ~/Documents",
  toolUseId: "toolu_bash",
}

function inLocale(locale: "fr" | "en", ui: () => unknown) {
  return render(() => <I18nProvider initialLocale={locale}>{ui() as never}</I18nProvider>)
}

afterEach(() => {
  cleanup()
  resetLocalPrompts()
  resetToastStore()
  uninstallFakeBridge()
})

describe("the permission card, in French", () => {
  it("says plainly what the agent asks, and answers with Autoriser", async () => {
    const fake = installFakeBridge(
      liveSession("t1", "a1", { toolActivity: [BASH_ROW], pendingPermissions: [BASH_PROMPT] }),
    )
    inLocale("fr", () => <LocalPermissionCard toolCallId="toolu_bash" />)
    const card = screen.getByTestId("local-permission-card")
    expect(card.textContent).toContain("L'agent demande votre accord")
    expect(card.textContent).toContain("Lancer une commande sur cet ordinateur")
    expect(card.textContent).not.toContain("Bash")
    expect(card.textContent).not.toMatch(/Permission needed|Allow|Deny/)
    expect(screen.getByRole("button", { name: "Refuser" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Autoriser" }))
    await waitFor(() =>
      expect(fake.calls.permissions).toEqual([{ requestId: "req-1", decision: "allow" }]),
    )
  })

  it("names a file edit in words, and keeps a tool the catalog does not know by its name", () => {
    installFakeBridge(
      liveSession("t1", "a1", {
        pendingPermissions: [
          { ...BASH_PROMPT, toolName: "Edit" },
          { ...BASH_PROMPT, requestId: "req-2", toolName: "custom_tool", toolUseId: "toolu_2" },
        ],
      }),
    )
    inLocale("fr", () => <LocalPermissionCard toolCallId="toolu_bash" />)
    expect(screen.getByTestId("local-permission-card").textContent).toContain("Modifier un fichier")
    const fr = translatorFor("fr")
    expect(localToolLabel("custom_tool", fr)).toBe("Custom Tool")
  })

  it("reads exactly as before in English", () => {
    installFakeBridge(
      liveSession("t1", "a1", { toolActivity: [BASH_ROW], pendingPermissions: [BASH_PROMPT] }),
    )
    inLocale("en", () => <LocalPermissionCard toolCallId="toolu_bash" />)
    const card = screen.getByTestId("local-permission-card")
    expect(card.textContent).toContain("Permission needed")
    expect(card.textContent).toContain("Bash")
    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument()
  })
})

describe("where the agent runs, in French", () => {
  it("the runtime control names this computer and its menu", async () => {
    installFakeBridge({ runtimeLocation: "local", folderPath: "/Users/stephanie/Rapports" })
    inLocale("fr", () => <RuntimeControl agentId="a1" agentName="Agent" threadId="t1" />)
    const trigger = screen.getByRole("button", {
      name: "Où l'agent travaille pour cette discussion",
    })
    expect(trigger.textContent).toBe("Cet ordinateur, Rapports")
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    const menu = await screen.findByRole("menu")
    for (const words of [
      "Où l'agent travaille",
      "Cet ordinateur",
      "Dossier",
      "Choisir un dossier",
      "Démarrer sur cet ordinateur",
      // P3-T3 (S18): one plain sentence per mode.
      "Travaille dans un dossier de cet ordinateur avec votre compte Claude : il peut lire et écrire vos fichiers, lancer des scripts et créer des PDF.",
      "Travaille sur le serveur Liaison, depuis n'importe quel appareil, avec la même mémoire et les mêmes discussions, mais sans accès à vos fichiers ni aux scripts.",
    ]) {
      expect(menu.textContent).toContain(words)
    }
    expect(menu.textContent).not.toMatch(
      /This machine|Choose a folder|Start a session|Works on|Works in/,
    )
  })

  it("the badge and the permission mode chip speak French", () => {
    installFakeBridge(liveSession("t1", "a1"))
    inLocale("fr", () => (
      <>
        <RuntimeBadge threadId="t1" />
        <PermissionModeMenu threadId="t1" />
      </>
    ))
    expect(screen.getByTestId("desktop-runtime-badge").textContent).toBe("Cet ordinateur")
    expect(
      screen.getByRole("button", { name: "Quand l'agent vous demande votre accord" }),
    ).toBeInTheDocument()
  })

  it("the badge offers the files the agent created in French", async () => {
    installFakeBridge(
      liveSession("t1", "a1", {
        producedFiles: [{ path: "/Users/stephanie/Rapports/bilan.md", name: "bilan.md" }],
      }),
    )
    inLocale("fr", () => <RuntimeBadge threadId="t1" />)
    const trigger = screen.getByRole("button", { name: "Ouvrir les fichiers créés par l'agent" })
    expect(trigger.textContent).toContain("Cet ordinateur")
    fireEvent.pointerEnter(screen.getByTestId("desktop-runtime-badge"), { pointerType: "mouse" })
    expect((await screen.findByTestId("tooltip-content")).textContent).toBe(
      "Ouvrir les fichiers créés par l'agent",
    )
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    const menu = await screen.findByRole("menu")
    expect(menu.textContent).toContain("Fichiers créés par l'agent")
    expect(menu.textContent).not.toMatch(/Files created|Open files/)
  })
})

describe("connecting the app, in French", () => {
  it("the connect step and the device approval step", () => {
    installFakeBridge({}, { withoutApprovalOpener: true })
    inLocale("fr", () => (
      <>
        <DesktopConnect />
        <DeviceGrantStep verificationUri="https://liaison.example.com/auth/device?code=QKVZ" />
      </>
    ))
    expect(screen.getByText("Saisissez l'URL de votre organisation Liaison :")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Se connecter" })).toBeInTheDocument()
    expect(screen.getByText("Identifiez-vous pour terminer la connexion")).toBeInTheDocument()
    expect(screen.getByText("Votre code")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Ouvrir la page d'approbation" })).toBeInTheDocument()
  })

  it("names the approval with the words of the page it opens", () => {
    // The link lands on the web approval page, titled « Approuver cet
    // appareil ». The app asking her to « valider cet ordinateur » for the
    // same step read as a second, different thing to do.
    const fr = translatorFor("fr")
    expect(fr(DEVICE_APPROVAL_DIALOG_TITLE)).toBe(fr("kernel.deviceApproval.title"))
    for (const key of [
      DEVICE_APPROVAL_DIALOG_TITLE,
      DEVICE_LOGIN_OPEN_ACTION,
      DEVICE_LOGIN_WAITING,
      NOTICE_WAITING_FOR_APPROVAL,
      NOTICE_APPROVAL_STATUS_UNKNOWN,
      NOTICE_RECONNECT_NOT_APPROVED,
    ]) {
      expect(fr(key)).not.toMatch(/valid/i)
    }
  })
})

describe("the desktop's notices, in French", () => {
  it("a refused start and a lost session are said in French", () => {
    inLocale("fr", () => null)
    expect(startRefusalCopyFor("NoFolderChosen")).toBe(
      "Choisissez un dossier sur cet ordinateur, puis démarrez la session.",
    )
    expect(startRefusalCopyFor(null)).toBe("La session n'a pas pu démarrer. Réessayez.")
    expect(reconnectCopyFor(null)).toBe("L'agent ne répond plus sur cet ordinateur.")
  })

  it("a refused permission mode raises a French toast", async () => {
    const refusing = installFakeBridge(liveSession("t1", "a1", { permissionMode: "manual" }), {
      refusePermissionMode: true,
    })
    inLocale("fr", () => <PermissionModeMenu threadId="t1" />)
    const trigger = screen.getByRole("button", { name: "Quand l'agent vous demande votre accord" })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    const menu = await screen.findByRole("menu")
    const bypass = [...menu.querySelectorAll('[role="menuitem"]')].find((item) =>
      item.textContent?.includes("Ignorer les autorisations"),
    ) as HTMLElement
    fireEvent.keyDown(bypass, { key: "Enter" })
    await waitFor(() => expect(refusing.calls.modes).toEqual(["bypass"]))
    await waitFor(() =>
      expect(toasts().map((toast) => toast.message)).toContain(
        "Ce mode n'a pas été appliqué, rien n'a changé.",
      ),
    )
  })
})
