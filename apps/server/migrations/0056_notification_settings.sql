CREATE TABLE `notification_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`notification_id` text NOT NULL,
	`user_id` text NOT NULL,
	`channel` text NOT NULL,
	`due_at` integer NOT NULL,
	`state` text NOT NULL,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notification_deliveries_due_idx` ON `notification_deliveries` (`state`,`due_at`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_user_idx` ON `notification_deliveries` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_notification_idx` ON `notification_deliveries` (`notification_id`);--> statement-breakpoint
CREATE TABLE `notification_digests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`period` text NOT NULL,
	`items` integer DEFAULT 0 NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_digests_once_idx` ON `notification_digests` (`user_id`,`kind`,`period`);--> statement-breakpoint
CREATE TABLE `notification_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`settings` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `notifications` ADD `hidden` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- The old "Email me about requests to join" switch (user_preferences
-- emailJoinRequests, which also covered partner requests and module
-- offers): whoever turned it off gets email off for those three types.
-- Nothing else changes for anyone.
INSERT INTO `notification_settings` (`user_id`, `settings`, `updated_at`)
SELECT `user_id`, '{"v":1,"types":{"club.join_request":{"email":"off"},"club.partner_request":{"email":"off"},"club.offer_received":{"email":"off"}}}', CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM `user_preferences`
WHERE json_valid(`prefs`) AND json_extract(`prefs`, '$.emailJoinRequests') = 0
ON CONFLICT (`user_id`) DO NOTHING;
