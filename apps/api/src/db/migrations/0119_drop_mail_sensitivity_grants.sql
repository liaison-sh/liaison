-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The mail app declared a "sensitivity" dimension (internal < confidential <
-- restricted) that nothing ever enforced: no mail table has a sensitivity
-- column, no app_mail policy reads app.current_dimensions->'mail:sensitivity',
-- and no code checks it. Mail access is the `mail:inbox` membership alone.
-- The manifest no longer declares it, so the grants it left behind are deleted
-- here: they changed nothing and only showed on the access screen as a setting
-- that seemed to restrict mail. Tickets and Knowledge keep their own
-- sensitivity, which they do enforce. Idempotent.
DELETE FROM kernel.user_dimension_grants WHERE dimension_key = 'mail:sensitivity';
DELETE FROM kernel.role_dimension_grants WHERE dimension_key = 'mail:sensitivity';
