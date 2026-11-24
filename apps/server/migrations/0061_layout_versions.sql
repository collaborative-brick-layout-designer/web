CREATE TABLE `layout_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`layout_id` text NOT NULL,
	`reason` text NOT NULL,
	`title` text NOT NULL,
	`label` text,
	`doc_snapshot` blob NOT NULL,
	`doc_hash` text NOT NULL,
	`summary` text NOT NULL,
	`editors` text DEFAULT '[]' NOT NULL,
	`bytes` integer NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`layout_id`) REFERENCES `layouts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `layout_versions_layout_created_idx` ON `layout_versions` (`layout_id`,`created_at`);