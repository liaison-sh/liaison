// SPDX-License-Identifier: FSL-1.1-ALv2
// The declarative settings page an app's manifest describes (`settings`, see
// @liaison/app-sdk app-settings.ts for the one structural definition), and the
// entry a registered app hands the settings pages (its manifest slice, icon and
// UI export bag).
import type {
  AppKind,
  AppSettingsSchema,
  SettingsBlock,
  SettingsConnectionsBlock,
  SettingsCustomBlock,
  SettingsField,
  SettingsListBlock,
  SettingsListCreateField,
  SettingsSection,
  SettingsTreeBlock,
} from "@liaison/app-sdk"
import type { Component } from "solid-js"

export type {
  AppSettingsSchema,
  SettingsBlock,
  SettingsConnectionsBlock,
  SettingsCustomBlock,
  SettingsField,
  SettingsListBlock,
  SettingsListCreateField,
  SettingsSection,
  SettingsTreeBlock,
}

/** The scope of an org section that names none (app-sdk DEFAULT_SETTINGS_ADMIN_SCOPE). */
export const DEFAULT_SECTION_ADMIN_SCOPE = "kernel:apps:admin"

/** The slice of `GET /api/apps/manifests` an app's settings page reads. */
export interface AppSettingsManifest {
  name: string
  displayName?: string
  version?: string
  /** Publisher, shown in the page header. */
  author?: string
  kind?: AppKind
  settings?: AppSettingsSchema
}

/** One app's settings page as the registry holds it. */
export interface AppSettingsPageEntry {
  appId: string
  manifest: AppSettingsManifest
  /** Catalog key of the app's name, when the kernel catalog has one. */
  labelKey?: string
  /** English name; defaults to displayName, then name. */
  label?: string
  /** The app's rail icon, when it has one. */
  icon?: Component<{ size?: number }>
  /**
   * The app's UI export bag (in-tree module, bundle, or the isolated-frame
   * proxy). `custom` blocks resolve their `component` here.
   */
  exports?: Record<string, unknown>
}

export type SettingsScope = "org" | "user"
