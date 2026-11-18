CREATE TABLE `club_partner_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`from_org_id` text NOT NULL,
	`to_org_id` text NOT NULL,
	`requested_by` text,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by` text,
	FOREIGN KEY (`from_org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `club_partner_requests_pair_idx` ON `club_partner_requests` (`from_org_id`,`to_org_id`);--> statement-breakpoint
CREATE INDEX `club_partner_requests_to_idx` ON `club_partner_requests` (`to_org_id`);--> statement-breakpoint
CREATE INDEX `club_partner_requests_requested_by_idx` ON `club_partner_requests` (`requested_by`);--> statement-breakpoint
CREATE INDEX `club_partner_requests_decided_by_idx` ON `club_partner_requests` (`decided_by`);--> statement-breakpoint
CREATE TABLE `club_partners` (
	`org_a` text NOT NULL,
	`org_b` text NOT NULL,
	`requested_by_org` text NOT NULL,
	`accepted_by` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`org_a`, `org_b`),
	FOREIGN KEY (`org_a`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_b`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`accepted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `club_partners_org_b_idx` ON `club_partners` (`org_b`);--> statement-breakpoint
CREATE INDEX `club_partners_accepted_by_idx` ON `club_partners` (`accepted_by`);--> statement-breakpoint
CREATE TABLE `module_club_offers` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`from_org_id` text NOT NULL,
	`to_org_id` text NOT NULL,
	`offered_by` text,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by` text,
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`offered_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `module_club_offers_module_to_idx` ON `module_club_offers` (`module_id`,`to_org_id`);--> statement-breakpoint
CREATE INDEX `module_club_offers_to_idx` ON `module_club_offers` (`to_org_id`);--> statement-breakpoint
CREATE INDEX `module_club_offers_from_idx` ON `module_club_offers` (`from_org_id`);--> statement-breakpoint
CREATE INDEX `module_club_offers_offered_by_idx` ON `module_club_offers` (`offered_by`);--> statement-breakpoint
CREATE INDEX `module_club_offers_decided_by_idx` ON `module_club_offers` (`decided_by`);--> statement-breakpoint
ALTER TABLE `module_club_shares` ADD `via` text;--> statement-breakpoint
ALTER TABLE `module_club_shares` ADD `from_org_id` text REFERENCES orgs(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `module_club_shares_from_org_idx` ON `module_club_shares` (`from_org_id`);