-- One-time fix, approved by Aaron 2026-11-18: module copies made before copies
-- started at version 1 (web #600), and never saved since, have no version at
-- all (latest_version 0), so they can't be placed or shared. Give each one the
-- first version a copy gets today: version 1, holding the contents it was
-- copied with, credited to whoever copied it, dated when it was copied.
-- Only copies (copied_from_id set) that were never saved (doc_version 0,
-- latest_version 0, no version rows) are touched. Nothing is removed.
INSERT INTO `module_versions` (`id`, `module_id`, `version`, `doc_snapshot`, `thumbnail`, `thumbnail_mime`, `note`, `author_id`, `created_at`)
SELECT
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  m.`id`, 1, m.`doc_snapshot`, NULL, NULL, NULL, m.`created_by`, m.`created_at`
FROM `modules` m
WHERE m.`copied_from_id` IS NOT NULL
  AND m.`doc_version` = 0
  AND m.`latest_version` = 0
  AND NOT EXISTS (SELECT 1 FROM `module_versions` v WHERE v.`module_id` = m.`id`);
--> statement-breakpoint
UPDATE `modules` SET `doc_version` = 1, `latest_version` = 1
WHERE `copied_from_id` IS NOT NULL
  AND `doc_version` = 0
  AND `latest_version` = 0
  AND EXISTS (SELECT 1 FROM `module_versions` v WHERE v.`module_id` = `modules`.`id` AND v.`version` = 1);
