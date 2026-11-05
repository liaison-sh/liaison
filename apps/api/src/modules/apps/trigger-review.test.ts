// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { reviewTriggerBody, TriggerReviewError } from "~/modules/apps/trigger-review"

const OWN = "app_my_app"
const ok = (body: string) => reviewTriggerBody(body, OWN, "t.trg")
const bad = (body: string) => expect(() => ok(body)).toThrow(TriggerReviewError)

describe("reviewTriggerBody", () => {
  it("accepts ordinary row-local logic on the app's own tables", () => {
    ok(`BEGIN
      IF NEW.depth > 3 THEN RAISE EXCEPTION 'too deep'; END IF;
      NEW.updated_at := now();
      UPDATE app_my_app.counters SET n = n + 1 WHERE id = NEW.id;
      INSERT INTO app_my_app.audit (id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
      RETURN NEW;
    END;`)
  })

  it("refuses overwriting the RLS context (the cross-tenant primitive)", () => {
    bad(
      "BEGIN PERFORM set_config('app.current_org_id', '00000000-0000-0000-0000-000000000000', true); RETURN NEW; END;",
    )
    bad("BEGIN PERFORM SET_CONFIG('app.current_scopes', '*', true); RETURN NEW; END;")
    bad(`BEGIN PERFORM "set_config"('app.current_org_id', 'x', true); RETURN NEW; END;`)
    bad("BEGIN SET LOCAL app.current_org_id = 'x'; RETURN NEW; END;")
    bad("BEGIN SET LOCAL ROLE liaison_admin; RETURN NEW; END;")
    bad("BEGIN RESET ROLE; RETURN NEW; END;")
  })

  it("refuses dynamic SQL, which could rebuild any of the above", () => {
    bad("BEGIN EXECUTE 'select 1'; RETURN NEW; END;")
  })

  it("refuses other schemas, system catalogues and utility statements", () => {
    bad("BEGIN PERFORM 1 FROM kernel.users; RETURN NEW; END;")
    bad("BEGIN PERFORM 1 FROM public.t; RETURN NEW; END;")
    bad("BEGIN PERFORM 1 FROM app_other_app.t; RETURN NEW; END;")
    bad(`BEGIN PERFORM 1 FROM "kernel"."users"; RETURN NEW; END;`)
    bad("BEGIN PERFORM pg_sleep(1); RETURN NEW; END;")
    bad("BEGIN DROP TABLE app_my_app.x; RETURN NEW; END;")
    bad("BEGIN PERFORM 1; /* hidden */ RETURN NEW; END;")
    bad("BEGIN PERFORM 1; -- hidden\n RETURN NEW; END;")
  })

  it("refuses a function that runs a query handed to it as text", () => {
    bad("BEGIN PERFORM query_to_xml('sel' || 'ect 1', true, false, ''); RETURN NEW; END;")
    bad("BEGIN PERFORM cursor_to_xml(c, 1, true, false, ''); RETURN NEW; END;")
    bad("BEGIN PERFORM ts_stat('select 1'); RETURN NEW; END;")
    bad("BEGIN PERFORM some_unknown_fn(NEW.id); RETURN NEW; END;")
    bad("BEGIN PERFORM app_other.fn(NEW.id); RETURN NEW; END;")
  })

  it("refuses quoted identifiers and statement-level SET in any spelling", () => {
    bad(`BEGIN SET LOCAL "app.current_org_id" = 'x'; RETURN NEW; END;`)
    bad(`BEGIN SET "role" TO 'liaison_admin'; RETURN NEW; END;`)
    bad("BEGIN SET app . current_org_id = 'x'; RETURN NEW; END;")
    bad("BEGIN SET TIME ZONE 'UTC'; RETURN NEW; END;")
    bad("BEGIN IF NEW.a = 'update' THEN SET x.y = 1; END IF; RETURN NEW; END;")
  })

  it("still accepts own-schema writes, keyword parentheses and safe functions", () => {
    ok(`BEGIN
      INSERT INTO audit (id, at) VALUES (NEW.id, now());
      NEW.total := round(coalesce(NEW.amount, 0)::numeric(12, 2), 2);
      IF NEW.status IN ('a', 'b') AND EXISTS (SELECT 1 FROM app_my_app.t WHERE id = NEW.id) THEN
        UPDATE app_my_app.t SET label = lower(trim(NEW.label)) WHERE id = NEW.id;
      END IF;
      RETURN NEW;
    END;`)
  })

  it("caps the body length", () => {
    bad(`BEGIN ${"NULL; ".repeat(2000)} RETURN NEW; END;`)
  })
})
