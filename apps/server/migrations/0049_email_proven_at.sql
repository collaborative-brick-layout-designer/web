-- When an account's email address was proven (owning the mailbox). Additive
-- only: one new nullable column, nothing dropped, no other column changed.
--   users.email_proven_at   when the person last opened a link sent to their
--                           address or signed in with a provider that vouches
--                           for it; null until then.
-- Backfill: only where the proof is on record. A GitHub sign-in has only ever
-- been accepted with an address GitHub marks verified, so accounts linked to
-- GitHub get the migration's time. Everyone else stays null (verification
-- links and reset links are deleted once used, and a Google or single sign-on
-- link doesn't record what the provider said back then): they get it the next
-- time they sign in that way or confirm their email.
ALTER TABLE `users` ADD `email_proven_at` integer;--> statement-breakpoint
UPDATE `users` SET `email_proven_at` = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE `email_proven_at` IS NULL AND `is_demo_account` = 0 AND `id` IN (SELECT `user_id` FROM `oauth_accounts` WHERE `provider` = 'github');
