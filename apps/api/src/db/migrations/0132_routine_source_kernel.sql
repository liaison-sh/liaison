-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Kernel routine templates (S28, A37, F5).
--
-- routines.source_kind gains 'kernel': a routine instantiated from a template
-- the platform itself ships (the "Morning brief"), as opposed to one an app
-- ships ('app') or one a person wrote ('user'). A kernel-sourced routine has
-- no app_name; its template_key names the kernel template.
--
-- Every statement is re-runnable, following the 0033/0045/0082 convention.

ALTER TABLE kernel.routines DROP CONSTRAINT IF EXISTS routines_source_kind_chk;
--> statement-breakpoint
ALTER TABLE kernel.routines
  ADD CONSTRAINT routines_source_kind_chk CHECK (source_kind IN ('user', 'app', 'kernel'));
