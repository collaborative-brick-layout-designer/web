CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`club_org_id` text,
	`needs_membership` integer DEFAULT false NOT NULL,
	`actor_user_id` text,
	`subject_kind` text,
	`subject_id` text,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`link` text,
	`group_key` text,
	`created_at` integer NOT NULL,
	`read_at` integer,
	`done_at` integer,
	`outcome` text,
	`outcome_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`club_org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`outcome_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `notifications_user_created_idx` ON `notifications` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_user_unread_idx` ON `notifications` (`user_id`,`read_at`);--> statement-breakpoint
CREATE INDEX `notifications_subject_idx` ON `notifications` (`subject_kind`,`subject_id`);--> statement-breakpoint
CREATE INDEX `notifications_club_idx` ON `notifications` (`club_org_id`);--> statement-breakpoint
CREATE INDEX `notifications_actor_idx` ON `notifications` (`actor_user_id`);--> statement-breakpoint
CREATE INDEX `notifications_outcome_by_idx` ON `notifications` (`outcome_by`);--> statement-breakpoint
CREATE INDEX `notifications_read_idx` ON `notifications` (`read_at`);