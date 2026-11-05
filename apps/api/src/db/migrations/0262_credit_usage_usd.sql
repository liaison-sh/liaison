-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Usage rows keep the provider-reported cost in USD and the USD per EUR
-- exchange rate the meter used (the daily ECB rate in system_config
-- `usd_eur_rate`). `raw_cost` stays in EUR, so self-hosted reads are
-- unchanged; the managed edition's daily usage report sums `raw_cost_usd`.
-- Nullable: rows written before this migration have neither.
--
-- Additive, every statement re-runnable.

SET LOCAL lock_timeout = '5s';
ALTER TABLE kernel.credit_transactions ADD COLUMN IF NOT EXISTS raw_cost_usd numeric(16, 8);
ALTER TABLE kernel.credit_transactions ADD COLUMN IF NOT EXISTS usd_eur_rate numeric(12, 6);
