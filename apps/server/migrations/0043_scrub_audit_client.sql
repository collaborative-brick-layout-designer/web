-- Refused or flagged live updates stored the sender's whole user agent
-- under "client" in the audit payload, which the layout's viewers could
-- read (docs/PRIVACY-DATA.md promises no user agents). New events store
-- only a rough name ("Firefox on Linux", "Desktop app 2.0.12"); this
-- removes the field from the events written before. Rewrites only that
-- one key, in only those events; nothing else changes.
UPDATE `audit_events`
SET `payload` = json_remove(`payload`, '$.client')
WHERE `event_type` IN ('layout_update_refused', 'layout_merge_refused', 'layout_merge_suspected')
  AND json_valid(`payload`)
  AND json_type(`payload`, '$.client') IS NOT NULL;
