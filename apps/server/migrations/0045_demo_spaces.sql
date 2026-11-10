ALTER TABLE `platform_settings` ADD `demo_max_spaces` integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `demo_expires_at` integer;--> statement-breakpoint
CREATE INDEX `users_demo_expires_at_idx` ON `users` (`demo_expires_at`);