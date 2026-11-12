// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Drive settings blocks' strings (en, fr), picked by the host's locale.
import { hostLocale } from "@liaison/host"

const EN = {
  loadFailed: "Could not load your Drive accounts: {{message}}",
  pickedIntro:
    "This Drive is connected with access to the files you pick only. Liaison sees the files and folders you choose here, and the files it creates.",
  choose: "Choose files",
  chooseFor: "Choose files for {{account}}",
  popupBlocked: "Your browser blocked the window. Allow pop-ups for Liaison and try again.",
  openFailed: "The picker could not open. Try again.",
  notConfigured:
    "The Google Picker is not set up on this server: an admin sets its API key and project number (pickerApiKey, pickerAppId).",
  pickedCount: "{{count}} picked",
  noPicks: "Nothing picked yet.",
  remove: "Stop sharing {{name}}",
  syncing: "Syncing into Knowledge…",
  inKnowledge: "{{count}} in Knowledge",
  syncError: "The last sync failed: {{message}}",
  notImported: "{{name}} ({{type}}) has no text Knowledge can import.",
  sharedIntro:
    "The organization's Drive connection reads only the shared drives chosen here, never anyone's My Drive.",
  noOrgConnection: "The organization has no Drive connection of its own.",
  needsChoice: "No shared drive chosen yet: Liaison reads none of this connection's files.",
  notMember: "A shared drive missing from this list needs {{account}} added to it (any role).",
  save: "Save",
  saved: "Saved",
  saveFailed: "Could not save: {{message}}",
}

const FR: Record<keyof typeof EN, string> = {
  loadFailed: "Impossible de charger vos comptes Drive : {{message}}",
  pickedIntro:
    "Ce Drive est connecté avec un accès limité aux fichiers que vous choisissez. Liaison voit les fichiers et dossiers choisis ici, et les fichiers qu'il crée.",
  choose: "Choisir des fichiers",
  chooseFor: "Choisir des fichiers pour {{account}}",
  popupBlocked:
    "Votre navigateur a bloqué la fenêtre. Autorisez les fenêtres pour Liaison et réessayez.",
  openFailed: "Le sélecteur n'a pas pu s'ouvrir. Réessayez.",
  notConfigured:
    "Le sélecteur Google n'est pas configuré sur ce serveur : un administrateur renseigne sa clé d'API et son numéro de projet (pickerApiKey, pickerAppId).",
  pickedCount: "{{count}} choisis",
  noPicks: "Rien n'est choisi pour l'instant.",
  remove: "Ne plus partager {{name}}",
  syncing: "Synchronisation dans Connaissances…",
  inKnowledge: "{{count}} dans Connaissances",
  syncError: "La dernière synchronisation a échoué : {{message}}",
  notImported: "{{name}} ({{type}}) n'a pas de texte que Connaissances peut importer.",
  sharedIntro:
    "La connexion Drive de l'organisation ne lit que les drives partagés choisis ici, jamais le Mon Drive de quelqu'un.",
  noOrgConnection: "L'organisation n'a pas de connexion Drive à elle.",
  needsChoice: "Aucun drive partagé choisi : Liaison ne lit aucun fichier de cette connexion.",
  notMember:
    "Pour un drive partagé absent de cette liste, ajoutez-y {{account}} (n'importe quel rôle).",
  save: "Enregistrer",
  saved: "Enregistré",
  saveFailed: "Enregistrement impossible : {{message}}",
}

export type StringKey = keyof typeof EN

export function t(key: StringKey, params: Record<string, string | number> = {}): string {
  const table = hostLocale().startsWith("fr") ? FR : EN
  return table[key].replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(params[k] ?? ""))
}
