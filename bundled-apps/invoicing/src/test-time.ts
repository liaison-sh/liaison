// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test only: the host's `ctx.time` for the suites that run a handler without the sandbox. The zone
// table comes from this process's `Intl`, the same one the host reads. The real seam, through
// QuickJS and the bridge, is proven by the api integration test of the issue date.
import type { CivilTime, TimeSurface } from "./issue-date"

/** An org with no zone, unless `orgZone` says otherwise; `UTC` means "not set", as on the host. */
export function testTime(orgZone = "UTC"): TimeSurface["time"] {
  return {
    async civil({ timezone, at }): Promise<CivilTime> {
      const zone = timezone === "UTC" ? orgZone : timezone
      let parts: Map<string, string>
      try {
        const fmt = new Intl.DateTimeFormat("en-US", {
          timeZone: zone,
          hourCycle: "h23",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          weekday: "short",
        })
        parts = new Map(
          fmt
            .formatToParts(at === undefined ? new Date() : new Date(at))
            .map((p) => [p.type, p.value]),
        )
      } catch {
        throw Object.assign(new Error(`"${zone}" is not a known IANA time zone name`), {
          code: "invalid_timezone",
        })
      }
      const get = (k: string) => parts.get(k) ?? ""
      return {
        date: `${get("year")}-${get("month")}-${get("day")}`,
        year: Number(get("year")),
        month: Number(get("month")),
        day: Number(get("day")),
        hour: Number(get("hour")),
        minute: Number(get("minute")),
        weekday: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday")) + 1,
        zone,
      }
    },
  }
}
