// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Report access block's strings (en, fr), picked by the host's locale.
import { hostLocale } from "@liaison/host"

const EN = {
    intro: "Internal reports run for every member who can read reports. Confidential ones run only for the roles you choose, restricted ones only for the people you choose. Admins and members who can run raw queries always run every report.",
    rawQueryNote: "Raw SQL queries (admins only) are not limited by these tiers.",
    loadFailed: "Report access could not be loaded: {{message}}",
    noCatalog: "No catalog of curated reads is connected.",
    empty: "The connected catalog has no curated reads.",
    readCount: "{{count}} reads",
    tierLabel: "Access for {{domain}}",
    tierInternal: "Internal",
    tierConfidential: "Confidential",
    tierRestricted: "Restricted",
    catalogDefault: "catalog default",
    roles: "Roles",
    people: "People",
    addRole: "Add a role",
    addPerson: "Add a person",
    remove: "Remove {{name}}",
    nobodyYet: "Nobody but admins until you add someone.",
    save: "Save",
    saved: "Saved",
    saveFailed: "Could not save: {{message}}",
    unsaved: "Unsaved changes",
    addByEmail: "Add a person by email",
    emailPlaceholder: "name@company.com",
    noSuchPerson: "No person with this email in the organization.",
  }

const FR: Record<keyof typeof EN, string> = {
    intro: "Les rapports internes sont accessibles à tout membre autorisé à lire les rapports. Les rapports confidentiels ne le sont qu'aux rôles choisis, les rapports restreints qu'aux personnes choisies. Les administrateurs et les membres autorisés aux requêtes brutes lancent toujours tous les rapports.",
    rawQueryNote: "Les requêtes SQL brutes (réservées aux administrateurs) ne sont pas limitées par ces niveaux.",
    loadFailed: "Impossible de charger l'accès aux rapports : {{message}}",
    noCatalog: "Aucun catalogue de lectures prédéfinies n'est connecté.",
    empty: "Le catalogue connecté n'a aucune lecture prédéfinie.",
    readCount: "{{count}} lectures",
    tierLabel: "Accès pour {{domain}}",
    tierInternal: "Interne",
    tierConfidential: "Confidentiel",
    tierRestricted: "Restreint",
    catalogDefault: "valeur du catalogue",
    roles: "Rôles",
    people: "Personnes",
    addRole: "Ajouter un rôle",
    addPerson: "Ajouter une personne",
    remove: "Retirer {{name}}",
    nobodyYet: "Seuls les administrateurs y ont accès tant que personne n'est ajouté.",
    save: "Enregistrer",
    saved: "Enregistré",
    saveFailed: "Enregistrement impossible : {{message}}",
    unsaved: "Modifications non enregistrées",
    addByEmail: "Ajouter une personne par e-mail",
    emailPlaceholder: "nom@entreprise.com",
    noSuchPerson: "Aucune personne de l'organisation n'a cet e-mail.",
  }

export type StringKey = keyof typeof EN

export function t(key: StringKey, vars: Record<string, string | number> = {}): string {
  const table = hostLocale().toLowerCase().startsWith("fr") ? FR : EN
  return table[key].replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(vars[name] ?? ""))
}
