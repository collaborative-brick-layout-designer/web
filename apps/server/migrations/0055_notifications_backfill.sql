-- Notifications backfill (docs/notifications.md). Each warning or note
-- nobody has acknowledged yet gets one notification per person who should
-- see it, dated when it was sent, so the bell and the per-person
-- "I understand" start with what is waiting today. Only inserts; nothing
-- is changed or removed, and a row already there is not made again.
--
-- Who sees it is the rule in routes/warnings.ts recipientsOf and
-- access/clubNotices.ts, in SQL:
--   - to a person: that person;
--   - from the site team to a club: its members whose roles may invite
--     people or manage members, and its Admins;
--   - a club's own note about its things: its members whose roles may
--     delete club items, and its Admins.
-- A member's roles are their member_roles rows; with none, the club's
-- stored role named by org_members.role; with none of those either, the
-- role's starting permissions (Admin: all; Manager: all but managing
-- members and exporting; Member and Viewer: neither).
INSERT INTO `notifications` (`id`, `user_id`, `type`, `club_org_id`, `needs_membership`, `actor_user_id`, `subject_kind`, `subject_id`, `title`, `body`, `link`, `group_key`, `created_at`, `read_at`, `done_at`, `outcome`, `outcome_by`)
WITH
  held AS (
    SELECT mr.`org_id` AS org_id, mr.`user_id` AS user_id, cr.`key` AS role_key, cr.`permissions` AS perms
    FROM `member_roles` mr JOIN `club_roles` cr ON cr.`id` = mr.`role_id`
  ),
  bare AS (
    SELECT om.`org_id` AS org_id, om.`user_id` AS user_id, cr.`key` AS role_key, cr.`permissions` AS perms
    FROM `org_members` om JOIN `club_roles` cr ON cr.`org_id` = om.`org_id` AND cr.`key` = om.`role`
    WHERE NOT EXISTS (SELECT 1 FROM held h WHERE h.org_id = om.`org_id` AND h.user_id = om.`user_id`)
  ),
  legacy AS (
    SELECT om.`org_id` AS org_id, om.`user_id` AS user_id, om.`role` AS role_key, NULL AS perms
    FROM `org_members` om
    WHERE NOT EXISTS (SELECT 1 FROM held h WHERE h.org_id = om.`org_id` AND h.user_id = om.`user_id`)
      AND NOT EXISTS (SELECT 1 FROM `club_roles` cr WHERE cr.`org_id` = om.`org_id` AND cr.`key` = om.`role`)
  ),
  roles AS (
    SELECT * FROM held UNION ALL SELECT * FROM bare UNION ALL SELECT * FROM legacy
  ),
  access AS (
    SELECT org_id, user_id,
      MAX(CASE WHEN role_key = 'admin' THEN 1 ELSE 0 END) AS is_admin,
      MAX(CASE
        WHEN perms IS NULL THEN (CASE WHEN role_key IN ('admin', 'manager') THEN 1 ELSE 0 END)
        WHEN json_valid(perms) THEN (SELECT COUNT(*) > 0 FROM json_each(perms) j WHERE j.value IN ('invite', 'manage_members'))
        ELSE 0 END) AS runs_people,
      MAX(CASE
        WHEN perms IS NULL THEN (CASE WHEN role_key IN ('admin', 'manager') THEN 1 ELSE 0 END)
        WHEN json_valid(perms) THEN (SELECT COUNT(*) > 0 FROM json_each(perms) j WHERE j.value = 'delete_items')
        ELSE 0 END) AS runs_things
    FROM roles
    GROUP BY org_id, user_id
  ),
  recipients AS (
    SELECT w.`id` AS warning_id, w.`subject_user_id` AS user_id
    FROM `warnings` w
    WHERE w.`acknowledged_at` IS NULL AND w.`subject_user_id` IS NOT NULL
    UNION
    SELECT w.`id`, a.user_id
    FROM `warnings` w JOIN access a ON a.org_id = w.`subject_org_id`
    WHERE w.`acknowledged_at` IS NULL AND w.`subject_org_id` IS NOT NULL
      AND (a.is_admin = 1 OR (w.`scope` = 'site' AND a.runs_people = 1) OR (w.`scope` = 'club' AND a.runs_things = 1))
  )
SELECT
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  r.user_id,
  CASE w.`severity` WHEN 'warning' THEN 'moderation.warning' WHEN 'final' THEN 'moderation.final_warning' ELSE 'moderation.note' END,
  COALESCE(w.`subject_org_id`, w.`club_org_id`),
  CASE WHEN w.`subject_org_id` IS NOT NULL THEN 1 ELSE 0 END,
  NULL,
  'warning',
  w.`id`,
  (CASE w.`severity` WHEN 'warning' THEN 'Warning' WHEN 'final' THEN 'Final warning' ELSE 'Note' END)
    || ' from '
    || COALESCE(CASE WHEN w.`scope` = 'club' THEN (SELECT o.`name` FROM `orgs` o WHERE o.`id` = w.`club_org_id`) END, 'the site team')
    || COALESCE(CASE WHEN w.`club_org_id` IS NULL OR w.`club_org_id` != w.`subject_org_id` THEN ' to your club ' || (SELECT o.`name` FROM `orgs` o WHERE o.`id` = w.`subject_org_id`) END, ''),
  w.`reason`,
  w.`link`,
  NULL,
  w.`created_at`,
  NULL, NULL, NULL, NULL
FROM recipients r JOIN `warnings` w ON w.`id` = r.warning_id
WHERE NOT EXISTS (
  SELECT 1 FROM `notifications` n WHERE n.`subject_kind` = 'warning' AND n.`subject_id` = w.`id` AND n.`user_id` = r.user_id
);
