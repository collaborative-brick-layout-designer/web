CREATE TABLE `rolling_stock` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text,
	`owner_org_id` text,
	`number` text DEFAULT '' NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`data` text NOT NULL,
	`model_part_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by` text,
	`copied_from_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `rolling_stock_owner_user_id_idx` ON `rolling_stock` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `rolling_stock_owner_org_id_idx` ON `rolling_stock` (`owner_org_id`);