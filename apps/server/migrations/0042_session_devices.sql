-- Profile › Browsers and devices. Additive only: two new nullable columns,
-- nothing dropped or rewritten, nobody signed out.
--   sessions.last_used_at   when the browser last used the sign-in (written at most every 5 minutes)
--   sessions.device         a rough browser name such as "Firefox on Linux", never the full user agent
ALTER TABLE `sessions` ADD `last_used_at` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `device` text;