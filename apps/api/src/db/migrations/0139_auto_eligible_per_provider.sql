-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Auto mode for every provider an org can bring a key for.
--
-- Auto mode picks the cheapest auto-eligible model among the providers the org
-- has a key for. The catalog marked no Anthropic model auto-eligible, so an org
-- whose only AI key is Anthropic (the usual case for a Claude Code user, or a
-- demo visitor who pastes an Anthropic key) had no auto model and every auto
-- turn failed asking for a Google key. This marks the cheapest current model
-- of each provider that had none: Anthropic's Haiku-class model. OpenAI's
-- cheapest (gpt-5.4-nano), Mistral's and Google's were already auto-eligible
-- and are left as they are, so an org that already resolved to one of them
-- resolves to the same model after this migration.
--
-- One UPDATE of an existing row: a catalog without the row is untouched, and a
-- re-run sets nothing new. An operator who turns the flag off afterwards keeps
-- it off (migrations run once; the boot seed never updates existing rows).
-- A fresh instance gets the same flag from MODEL_PRICING_SEED.

UPDATE kernel.model_pricing
   SET auto_eligible = true
 WHERE provider = 'anthropic'
   AND model_id = 'claude-haiku-4-5'
   AND auto_eligible = false;
