// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Workspace app management (S24, A4, A7, A12, A24-2), mounted at
 * `/api/org/apps`, `kernel:apps:admin` only:
 *
 *   GET  /                    every app of the workspace, Off and restricted included
 *   POST /:app/add            add a server-installed app (On)
 *   POST /:app/remove         remove it from this workspace (data kept)
 *   POST /:app/enable         turn it back On
 *   POST /:app/disable        turn it Off
 *   PUT  /:app/access         { mode: "everyone" | "restricted", roleIds, userIds }
 *
 * Each change is audited as `{app:"kernel", entity:"org_app", action}` and
 * broadcast as the `kernel:org_app:update` WebSocket event. Refusals carry a
 * typed code (`app_required`, `app_has_dependents`, `app_removed`, `app_off`,
 * `app_not_restrictable`) and a sentence for the person.
 */
import { setOrgAppAccessSchema } from "@liaison/shared"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { requireScope } from "~/middleware/require-scope"
import {
  addOrgApp,
  disableOrgApp,
  enableOrgApp,
  listOrgAppsForAdmin,
  type OrgAppActor,
  removeOrgApp,
  setOrgAppAccessChecked,
} from "~/modules/apps/org-app-admin"
import type { OrgAppState } from "~/modules/apps/org-apps"

export const orgAppRoutes = new Hono<AppEnv>()

function actorOf(userId: string | undefined): OrgAppActor {
  return { actorId: userId ?? null, actorType: "user" }
}

function view(state: OrgAppState) {
  return {
    name: state.app,
    status: state.status,
    accessMode: state.accessMode,
    principals: { roleIds: [...state.roleIds], userIds: [...state.userIds] },
  }
}

orgAppRoutes
  .get("/", requireScope("kernel:apps:admin"), async (c) =>
    success(c, await listOrgAppsForAdmin(c.get("orgId"))),
  )
  .post("/:app/add", requireScope("kernel:apps:admin"), async (c) =>
    success(c, view(await addOrgApp(c.get("orgId"), c.req.param("app"), actorOf(c.get("userId"))))),
  )
  .post("/:app/remove", requireScope("kernel:apps:admin"), async (c) =>
    success(
      c,
      view(await removeOrgApp(c.get("orgId"), c.req.param("app"), actorOf(c.get("userId")))),
    ),
  )
  .post("/:app/enable", requireScope("kernel:apps:admin"), async (c) =>
    success(
      c,
      view(await enableOrgApp(c.get("orgId"), c.req.param("app"), actorOf(c.get("userId")))),
    ),
  )
  .post("/:app/disable", requireScope("kernel:apps:admin"), async (c) =>
    success(
      c,
      view(await disableOrgApp(c.get("orgId"), c.req.param("app"), actorOf(c.get("userId")))),
    ),
  )
  .put(
    "/:app/access",
    requireScope("kernel:apps:admin"),
    zValidator("json", setOrgAppAccessSchema),
    async (c) => {
      const body = c.req.valid("json")
      const state = await setOrgAppAccessChecked(
        c.get("orgId"),
        c.req.param("app"),
        body,
        actorOf(c.get("userId")),
      )
      return success(c, view(state))
    },
  )
