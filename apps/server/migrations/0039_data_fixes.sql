-- One-time data fixes the server has run, by name, so each runs only once
-- (src/ops/dataFixes.ts). Additive only: a new table, empty until an
-- operator runs a fix (CBLD_DATA_FIX).
CREATE TABLE `data_fixes` (
	`id` text PRIMARY KEY NOT NULL,
	`applied_at` integer NOT NULL,
	`summary` text
);
