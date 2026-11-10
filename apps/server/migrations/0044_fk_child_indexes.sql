CREATE INDEX `audit_events_user_id_idx` ON `audit_events` (`user_id`);--> statement-breakpoint
CREATE INDEX `catalog_items_owner_user_id_idx` ON `catalog_items` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `catalog_items_owner_org_id_idx` ON `catalog_items` (`owner_org_id`);--> statement-breakpoint
CREATE INDEX `custom_parts_created_by_idx` ON `custom_parts` (`created_by`);--> statement-breakpoint
CREATE INDEX `device_codes_user_id_idx` ON `device_codes` (`user_id`);--> statement-breakpoint
CREATE INDEX `email_verifications_user_id_idx` ON `email_verifications` (`user_id`);--> statement-breakpoint
CREATE INDEX `layout_invites_layout_id_idx` ON `layout_invites` (`layout_id`);--> statement-breakpoint
CREATE INDEX `layout_transfers_layout_id_idx` ON `layout_transfers` (`layout_id`);--> statement-breakpoint
CREATE INDEX `layouts_created_by_idx` ON `layouts` (`created_by`);--> statement-breakpoint
CREATE INDEX `module_transfers_module_id_idx` ON `module_transfers` (`module_id`);--> statement-breakpoint
CREATE INDEX `module_versions_author_id_idx` ON `module_versions` (`author_id`);--> statement-breakpoint
CREATE INDEX `modules_created_by_idx` ON `modules` (`created_by`);--> statement-breakpoint
CREATE INDEX `oauth_accounts_user_id_idx` ON `oauth_accounts` (`user_id`);--> statement-breakpoint
CREATE INDEX `org_invites_org_id_idx` ON `org_invites` (`org_id`);--> statement-breakpoint
CREATE INDEX `venue_library_owner_user_id_idx` ON `venue_library` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `venue_library_owner_org_id_idx` ON `venue_library` (`owner_org_id`);