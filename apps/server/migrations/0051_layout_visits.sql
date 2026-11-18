CREATE TABLE `layout_visits` (
	`layout_id` text NOT NULL,
	`user_id` text NOT NULL,
	`seen_at` integer NOT NULL,
	PRIMARY KEY(`layout_id`, `user_id`),
	FOREIGN KEY (`layout_id`) REFERENCES `layouts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `layout_visits_user_idx` ON `layout_visits` (`user_id`);