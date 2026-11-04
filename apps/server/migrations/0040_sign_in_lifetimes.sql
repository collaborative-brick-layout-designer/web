-- Sign-in lifetimes (Admin › Settings › Sign-in). Additive only: two new
-- columns, nothing dropped or rewritten, nobody signed out.
--   platform_settings.sign_in   JSON of sign-in setting -> hours or "never"; null = the defaults
--   sessions.created_at         when the person signed in; the longest a sign-in can last counts
--                               from it. Sessions from before this get the migration's time, so
--                               their longest counts from the deploy, not from 1970.
ALTER TABLE `platform_settings` ADD `sign_in` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `created_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `sessions` SET `created_at` = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE `created_at` = 0;
