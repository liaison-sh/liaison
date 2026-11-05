// SPDX-License-Identifier: FSL-1.1-ALv2
// The declarative app settings page (`/settings/apps/<appId>`, S13). The kernel
// bootstrap renders `AppSettingsPage` for every app page and feeds the
// registry below from the app registration (define-app).
export { AppSettingsBody, AppSettingsPage } from "./AppSettingsPage"
export { registerAppSettingsPage, unregisterAppSettingsPage } from "./app-settings-pages"
export type { AppSettingsPageEntry } from "./types"
