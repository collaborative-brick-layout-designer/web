CREATE TABLE `trash_items` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`item_id` text NOT NULL,
	`title` text NOT NULL,
	`owner_user_id` text,
	`owner_org_id` text,
	`deleted_by` text,
	`deleted_at` integer NOT NULL,
	`purge_at` integer NOT NULL,
	`payload` blob NOT NULL,
	`bytes` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deleted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `trash_items_owner_user_id_idx` ON `trash_items` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `trash_items_owner_org_id_idx` ON `trash_items` (`owner_org_id`);--> statement-breakpoint
CREATE INDEX `trash_items_deleted_by_idx` ON `trash_items` (`deleted_by`);--> statement-breakpoint
CREATE INDEX `trash_items_purge_at_idx` ON `trash_items` (`purge_at`);