// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Export handlers of core apps that own no handler module: the app's own server
// code, called in process with the caller's RLS-bound context, keyed by app name.
// runtime.ts resolves a manifest app's export here when it has no `_bundlePath`.
import { exportContacts } from "~/apps/contacts/export"
import type { AppContext } from "~/modules/apps/context"

export type CoreExportHandler = (
  ctx: AppContext,
  format: string,
  filters?: { dateRange?: { from?: string; to?: string } },
) => Promise<unknown>

export const CORE_EXPORT_HANDLERS: Readonly<Record<string, CoreExportHandler>> = {
  contacts: exportContacts,
}
