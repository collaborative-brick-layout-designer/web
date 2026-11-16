CREATE TABLE `layout_shared_modules` (
	`layout_id` text NOT NULL,
	`placed_id` text NOT NULL,
	`module_id` text NOT NULL,
	`version` integer NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`layout_id`, `placed_id`),
	FOREIGN KEY (`layout_id`) REFERENCES `layouts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `layout_shared_modules_module_idx` ON `layout_shared_modules` (`module_id`);--> statement-breakpoint
CREATE TABLE `module_club_shares` (
	`module_id` text NOT NULL,
	`org_id` text NOT NULL,
	`shared_by` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`module_id`, `org_id`),
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`shared_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `module_club_shares_org_idx` ON `module_club_shares` (`org_id`);--> statement-breakpoint
CREATE INDEX `module_club_shares_shared_by_idx` ON `module_club_shares` (`shared_by`);--> statement-breakpoint
CREATE TABLE `module_share_parts` (
	`module_id` text NOT NULL,
	`part_id` text NOT NULL,
	`user_id` text,
	`org_id` text,
	`added_at` integer NOT NULL,
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`part_id`) REFERENCES `custom_parts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `module_share_parts_module_idx` ON `module_share_parts` (`module_id`);--> statement-breakpoint
CREATE INDEX `module_share_parts_part_idx` ON `module_share_parts` (`part_id`);--> statement-breakpoint
CREATE INDEX `module_share_parts_user_idx` ON `module_share_parts` (`user_id`);--> statement-breakpoint
CREATE INDEX `module_share_parts_org_idx` ON `module_share_parts` (`org_id`);--> statement-breakpoint
ALTER TABLE `layouts` ADD `shared_module_updates` text DEFAULT 'ask' NOT NULL;