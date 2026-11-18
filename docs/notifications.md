# Notifications

What the site tells a person: requests and invites waiting for their
answer, news from their clubs and the people they share with, and warnings
from the site team or a club. The web shows them in the header's bell, its
panel and the `/notifications` page; the desktop app uses the same API.
This file is the contract: type strings, routes and JSON shapes are stable.
New fields and new types may be added; nothing listed here is renamed or
removed.

## The model

- One row per person (`notifications` table, migration 0054). The title and
  body are plain text, written on the server from what that person may see
  anyway. Show them as text, never as HTML.
- **Read** (`readAt`): the person opened it or marked it read. The bell's
  number is the unread count.
- **Done** (`doneAt`): a request in it was answered (by them, or in a club by
  someone else), or it went away (taken back, expired), or a warning was
  acknowledged. `outcome` says how and `outcomeBy` who. A done item has no
  `actions`.
- **Club rows** that only a member should see disappear from every list and
  count as soon as the person leaves or is removed from the club.
- **Groups**: items with the same `groupKey` belong together ("3 requests to
  join Arklug"). Clients collapse them into one entry, newest first, with
  the rest one tap away. Shared-module updates go further: while unread, a
  layout's one notification is brought up to date instead of a new one.
- **Warnings** (`moderation.warning`, `moderation.final_warning`) need their
  own "I understand", per person: reading one is not acknowledging it. They
  stay in a banner until acknowledged. Notes are ordinary notifications.
- **Clean-up**: notifications read more than 180 days ago are deleted by the
  hourly privacy clean-up. Unread ones and warnings are never deleted.
- **Erasing an account** deletes its notifications, and other people's
  notifications that name it as who did it (`actor`).

## Types

`type` is one of these strings. `waits`: something waits for the person.
`action`: what `actions` can hold while it isn't done.

| Type | Category | Waits | Actions | When |
|---|---|---|---|---|
| `moderation.warning` | moderation | yes | acknowledge | a warning from the site team or a club, to you or a club you run |
| `moderation.final_warning` | moderation | yes | acknowledge | a final warning |
| `moderation.note` | moderation | | | a note from the site team (Admin › warnings with "Note") |
| `club.join_request` | clubs | yes | accept, decline | someone asked to join a club where your roles answer requests |
| `club.join_approved` | clubs | | | your request to join was approved |
| `club.join_declined` | clubs | | | your request to join was declined (who declined isn't named) |
| `club.invite` | clubs | yes | accept, decline | a club invited your account (sent to your confirmed address) |
| `club.role_changed` | clubs | | | your roles in a club changed |
| `club.removed` | clubs | | | you were removed from a club |
| `club.partner_request` | clubs | yes | accept, decline | another club asked yours to be partners |
| `club.partner_accepted` | clubs | | | the club you asked accepted |
| `club.partner_declined` | clubs | | | the club you asked declined |
| `club.partner_ended` | clubs | | | a partner club ended the partnership |
| `club.partner_deleted` | clubs | | | a partner club was deleted |
| `club.offer_received` | clubs | yes | accept, decline | another club offered yours one of its modules |
| `club.offer_accepted` | clubs | | | a club accepted your club's module |
| `club.offer_declined` | clubs | | | a club declined your club's module |
| `club.item_returned` | clubs | | | a club thing was taken back or given back to its author |
| `club.deleted` | clubs | | | a club you're in is being deleted |
| `club.restored` | clubs | | | a club you're in was restored |
| `sharing.layout_invite` | sharing | yes | accept, decline | you were invited to a layout |
| `sharing.module_invite` | sharing | yes | accept, decline | you were invited to a module |
| `sharing.part_invite` | sharing | yes | accept, decline | you were invited to a custom part or set |
| `sharing.transfer_offered` | sharing | yes | accept, decline | someone wants to give you a layout |
| `sharing.transfer_accepted` | sharing | | | the layout you offered was accepted |
| `sharing.transfer_declined` | sharing | | | the layout you offered was declined |
| `sharing.module_shared` | sharing | | | a module was shared with a club you're in |
| `sharing.module_unshared` | sharing | | | a module is no longer shared (with your club, or yours by a club) |
| `shared_modules.update_waiting` | shared_modules | | | a new version waits in one of your "Ask first" layouts (one per layout) |
| `shared_modules.updated` | shared_modules | | | a new version was put in one of your "Automatically" layouts (one per layout) |
| `account.export_ready` | account | yes | | your data download is ready (or failed) |
| `account.deletion_scheduled` | account | | | your account will be deleted |
| `account.deletion_cancelled` | account | | | your account will not be deleted |
| `account.club_admin_inherited` | account | | | you became a club's admin (its last admin deleted their account) |
| `account.restriction_placed` | account | | | your account was put on hold |
| `account.restriction_lifted` | account | | | your account is no longer on hold |

Sign-in, address confirmation and password emails are not notifications.

`GET /api/notifications/types` returns this list with plain-word labels, for
filters and settings. Unknown types (a newer server) should still be shown,
under their title, with no category.

### Subject kinds

`subject` says what an item is about: `{ kind, id }`.

| Kind | Id |
|---|---|
| `warning` | the warning (moderation types) |
| `join_request`, `partner_request`, `module_offer` | the request or offer |
| `org_invite`, `layout_invite`, `module_invite`, `part_invite`, `layout_transfer` | the invite or hand-over (never its token) |
| `org`, `layout`, `module`, `user` | the club, layout, module or account |

## The item

```json
{
  "id": "6f0c…",
  "type": "club.join_request",
  "category": "clubs",
  "title": "Ann asked to join ArkLUG",
  "body": "Their note: “Hi!”",
  "link": "/orgs/arklug/admin?tab=people",
  "createdAt": 1795000000000,
  "readAt": null,
  "doneAt": null,
  "outcome": null,
  "outcomeBy": null,
  "club": { "id": "…", "name": "ArkLUG", "slug": "arklug" },
  "actor": { "id": "…", "name": "Ann" },
  "subject": { "kind": "join_request", "id": "…" },
  "groupKey": "join:…",
  "actions": ["accept", "decline"]
}
```

- Times are Unix milliseconds. `link` is a path on this site, or null; the
  desktop opens it on the website (`PUBLIC_URL` + path). While an item still
  has `accept`, its thing usually isn't the person's to open yet (an
  invite's layout): show the answers first.
- `outcome`: `accepted`, `declined`, `withdrawn` (taken back by whoever sent
  it), `gone` (expired, or no longer there), `acknowledged`, or null.
- `outcomeBy`: `{ id, name, you }`, or null. `you` is true when the caller
  answered it.
- `category` is null for a type the server doesn't know.

## Routes

Every route needs a signed-in person (the session cookie) or a desktop
token (`Authorization: Bearer bld_pat_…`) with the scope shown. A
notification that isn't the caller's, or that they no longer see (they left
the club), is `404 {"error":"not_found"}`.

| Method and path | Body | Token scope | Answer |
|---|---|---|---|
| `GET /api/notifications` | | `layouts:read` or `layouts:write` | a page (below) |
| `GET /api/notifications/count` | | `layouts:read` or `layouts:write` | `{ unread, waiting, warnings }` |
| `GET /api/notifications/types` | | `layouts:read` or `layouts:write` | `{ categories, types: [{ type, category, label, waits, action }] }` |
| `POST /api/notifications/:id/read` | none | `layouts:read` or `layouts:write` | `{ ok: true, readAt }` |
| `POST /api/notifications/:id/unread` | none | `layouts:read` or `layouts:write` | `{ ok: true, readAt: null }` |
| `POST /api/notifications/read-all` | `{}` or `{ "ids": ["…"] }` (at most 500) | `layouts:read` or `layouts:write` | `{ ok: true, read: <how many> }` |
| `POST /api/notifications/:id/acknowledge` | none | `layouts:read` or `layouts:write` | `{ ok: true, acknowledgedAt }` |
| `POST /api/notifications/:id/act` | `{ "action": "accept" }` or `{ "action": "decline" }` | `layouts:write` | below |

Rate limits (per person, a minute): read and unread 240, read-all 30,
acknowledge 60, act 60. Over them: 429.

### The list

`GET /api/notifications?unread=1&type=club.join_request,club.invite&category=clubs&q=arklug&cursor=…&limit=30`

- `unread=1`: unread only. `type`: one or more types, comma separated (400
  `invalid_type` for an unknown one). `category`: one category (400
  `invalid_category`). `q`: words in the title or body (up to 100
  characters). `limit`: 1 to 100, default 30.
- Newest first. `nextCursor` is the next page's `cursor`, or null at the end
  (400 `invalid_cursor` for one this server didn't make).

```json
{
  "notifications": [ { "id": "…", "type": "…" } ],
  "nextCursor": "1795000000000.6f0c…",
  "unread": 3,
  "waiting": 1,
  "warnings": 0
}
```

The counts are the person's totals, whatever the filters: `unread`, the
requests that wait for their answer (`waiting`), and the warnings that wait
for "I understand" (`warnings`).

### Acknowledging a warning

`POST /api/notifications/:id/acknowledge` on a `moderation.warning` or
`moderation.final_warning` item: it's read and done (`outcome`
`acknowledged`) for the caller only; the rest of a club's runners still
acknowledge their own. The admin pages keep when it was first acknowledged.
On another type: 400 `not_a_warning`. `act` on a warning is 400
`no_answer_here`.

### Answering: `act`

`POST /api/notifications/:id/act {"action":"accept"|"decline"}` answers the
request on the server, in one call: it runs the same route the club page or
the invite page uses (approve a join request, accept a partner request or a
module offer, accept an invite or a hand-over), as the caller, with exactly
that route's checks. Declining an invite or a layout hand-over removes it
(only the person it was sent to may). The desktop never needs the other
routes or an invite's token.

- `200 { ok: true, outcome: "accepted"|"declined", result, notification }`:
  answered. `result` is the answering route's own reply (for an accepted
  layout invite or hand-over, `{ layoutId }`; for a club invite,
  `{ orgId, role }`). `notification` is the item as it is now.
- `200 { ok: true, already: true, outcome, notification }`: someone else
  answered first (another of the club's runners), it was taken back, or it
  expired. `outcome` says which. Not an error: show it.
- Otherwise the answering route's own refusal, as it is: for example
  `403 { error: "forbidden", permission: "invite" }` (your roles no longer
  answer requests), `403 { error: "email_not_verified" }`, `403
  { error: "demo_account_cannot_share" }`, `403 { error: "account_restricted",
  message }`, a usage-limit refusal with its `message`, or `429`. Show its
  `message` when there is one.
- `400 { error: "invalid_action" }`, `400 { error: "no_answer_here" }` (this
  type has no answer).

Answering on the club page or an invite page closes the same notifications:
every runner's item then shows who answered.

### Example (desktop)

```http
GET /api/notifications/count
Authorization: Bearer bld_pat_…

200 {"unread":2,"waiting":1,"warnings":0}
```

```http
POST /api/notifications/6f0c…/act
Authorization: Bearer bld_pat_…
Content-Type: application/json

{"action":"accept"}

200 {"ok":true,"outcome":"accepted","result":{"ok":true},"notification":{"id":"6f0c…","doneAt":1795000000500,"outcome":"accepted","outcomeBy":{"id":"…","name":"Ann","you":true},"actions":[],"…":"…"}}
```

## Delivery settings

Each person chooses, per type: **in the app** (on or off; warnings can't be
turned off), **email** (`now` right away, `daily` or `weekly` summary, or
`off`), and **push** (on or off; browser push comes in Web C). Plus quiet
hours, the summary times, per-club choices and "pause all".

Defaults: everything in the app; email `now` and push on for the types that
wait for you (requests, invites, warnings, a download ready); off for the
rest. Types whose email is sent apart (`emailApart`) have no email choice:
`invite` (the invite or hand-over email carries its link, and is always
sent) and `account` (account-deletion emails, always sent).

Turning a type off in the app, or muting a club, takes its items out of the
list and the count at once (they stay for the email summaries); turning it
back on brings them back.

| Method and path | Body | Token scope | Answer |
|---|---|---|---|
| `GET /api/me/notification-settings` | | `layouts:read`, `layouts:write` or `account:prefs` | the view (below) |
| `PUT /api/me/notification-settings` | `{ "settings": { …some keys } }` | `account:prefs` | the view; 400 `{ error: "invalid_settings", message }` |

The view:

```json
{
  "categories": ["moderation", "clubs", "sharing", "shared_modules", "account"],
  "types": [
    { "type": "club.join_request", "category": "clubs", "label": "Requests to join a club you run", "waits": true,
      "appLocked": false, "emailApart": null, "app": true, "email": "now", "push": true }
  ],
  "quiet": { "on": false, "start": "22:00", "end": "07:00" },
  "timeZone": "America/Chicago",
  "dailyAt": "08:00",
  "weeklyDay": 1,
  "pauseEmail": false,
  "pausePush": false,
  "clubs": [ { "id": "…", "name": "ArkLUG", "slug": "arklug", "mute": false, "email": true, "push": true } ],
  "emailAvailable": true,
  "pushAvailable": false
}
```

`PUT` merges what it's given onto what is stored, so two apps changing
different settings don't undo each other:

```json
{ "settings": {
  "types": { "club.role_changed": { "app": true, "email": "daily", "push": false } },
  "quiet": { "on": true, "start": "22:00", "end": "07:00" },
  "timeZone": "Europe/London",
  "dailyAt": "18:30",
  "weeklyDay": 5,
  "pauseEmail": false,
  "pausePush": false,
  "clubs": { "<orgId>": { "mute": false, "email": false, "push": true } }
} }
```

- Times are `HH:MM`, in `timeZone` (an IANA name). `timeZone` null means "not
  set yet": the web sets it to the browser's on first visit; until then the
  server uses UTC. `weeklyDay`: 0 Sunday … 6 Saturday; the weekly summary goes
  at `dailyAt` on that day.
- `clubs.<id>: null` forgets a club's choices. Only clubs you're in.
- Refused: `app: false` on a warning type; an email mode on an `emailApart`
  type; unknown types or keys.
- `emailAvailable` false: the site can't send email (choices are kept).
- Desktop 2.1.8 and older still send the old `emailJoinRequests` preference
  (`PUT /api/me/preferences`); it sets email `now` or `off` for
  `club.join_request`, `club.partner_request` and `club.offer_received`.

### Email

- Right away: sent within a minute, or, in quiet hours, when they end.
  Already read or answered in the app by then: not sent. More than 20 in an
  hour: the rest go in the next daily summary (warnings are never held back).
- Summaries: one email with what is unread since the last summary, once its
  time comes. A record is written before it goes, so a restart never sends
  one twice. Nothing new: no email.
- Every email has "Stop these emails" and a link to Settings › Notifications,
  and RFC 8058 headers (`List-Unsubscribe` with the one-click address below,
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click`). Right-away emails
  stop their type; summaries stop all notification email.
- Both run inside the server (an in-process job every minute, the same
  pattern as the privacy clean-up); nothing else is needed on the host.

| Method and path | Body | Sign-in | Answer |
|---|---|---|---|
| `GET /api/notifications/unsubscribe?t=<token>` | | none | `{ ok, scope, what }` (changes nothing: what the link would stop) |
| `POST /api/notifications/unsubscribe?t=<token>` | none, `List-Unsubscribe=One-Click` (form), or `{ "t": "<token>" }` | none | `{ ok, scope, what }`; 404 `invalid_link` |

The token is signed by the server and names the account and what it stops
(a type, or `all`). It can only turn email off. The web's `/unsubscribe?t=`
page asks before it stops anything.

## Browser pop-ups (Web Push)

A person can ask for a pop-up from their browser for the types with push on
(Settings › Notifications, or the bell panel's one-time offer; never on page
load). The web registers its service worker (`/sw.js`, which only shows
pop-ups and caches nothing) at that moment. Pop-ups follow quiet hours like
email. Clicking one marks it read and opens the app at its link. The desktop
shows its own system notifications instead and doesn't use these routes.

| Method and path | Body | Answer |
|---|---|---|
| `GET /api/push/key` | | `{ enabled, publicKey }` (the public VAPID key; null while push is off) |
| `GET /api/push/subscriptions` | | `{ subscriptions: [{ id, name, createdAt, lastUsedAt, service }] }` |
| `POST /api/push/subscriptions` | `{ endpoint, keys: { p256dh, auth }, name? }` (a browser's `PushSubscription.toJSON()`) | 201 `{ id }`; 400 `invalid_endpoint`, `unknown_push_service`, `invalid_keys`; 409 `push_off` |
| `DELETE /api/push/subscriptions/:id` | | `{ ok: true }`; 404 |

Signed-in browsers only (no desktop tokens).

- **Endpoints:** https, port 443, no user info, on a known push service:
  `fcm.googleapis.com`, `android.googleapis.com`,
  `updates.push.services.mozilla.com`, `push.services.mozilla.com`,
  `web.push.apple.com`, `push.apple.com`, `*.notify.windows.com` (and their
  subdomains). The host must resolve only to public addresses, checked when
  saved and again as each connection is made (no private, loopback,
  link-local, CGNAT or multicast address). Redirects are never followed.
- At most 10 browsers per person (the oldest goes). A push service answering
  404 or 410 means the browser is gone: it's deleted. Every send times out
  after 10 seconds.
- **What is sent:** `{ id, title, body, link }`: the notification's title, its
  body cut to 140 characters, its link, its id. Nothing the person can't see
  in the app.
- **Keys:** the server makes a VAPID key pair on first use and keeps it in
  `platform_settings`, the private key encrypted with the server's secret key
  (it is never sent, logged, or put in a download or backup in the clear).
  `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (both) replace it, for several
  servers serving one site; `VAPID_SUBJECT` is the contact push services may
  use (`mailto:` or `https:`; `PUBLIC_URL` by default).
- **Site switch:** Admin › Settings › Notifications turns pop-ups off for
  everyone; `PUSH_ENABLED` forces it on or off (the page says so).
- If the server's secret key changes, the stored private key can't be read:
  the server makes a new pair and forgets the old browsers (they can't be
  reached with a new key), and people turn pop-ups on again.

## Live updates

The event stream (`GET /api/events`, any token scope) sends
`{"kind":"notification","action":"…"}` to a person whenever their
notifications change: a new one (`create`), one answered or brought up to
date (`update`), or marked read, unread or acknowledged in another tab or
app (`update:read`, `update:unread`, `update:read-all`, `update:act`,
`update:acknowledge`), or their settings changed (`update:settings`). The hint carries no content: refetch the count and
the list. On reconnecting, refetch them once.

## Older desktop apps

Desktop 2.1.8 and older use `GET /api/notices`, `POST
/api/notices/:id/acknowledge` and `POST /api/notices/acknowledge-all`, and
listen for the `warning` hint. They keep working with the same JSON. A
notice's `acknowledgedAt` is now when *you* acknowledged it, and
acknowledging there acknowledges your notification too. Those routes list
warnings and notes only, not the other types.

## Checking the backfill on a live database

Migration 0055 gives each warning or note nobody had acknowledged one
notification per person who should see it. Right after it runs (before
anything new is sent), both of these give the same number:

Expected: unacknowledged warnings and notes × their recipients.

```sql
WITH held AS (
  SELECT mr.org_id, mr.user_id, cr.key AS role_key, cr.permissions AS perms
  FROM member_roles mr JOIN club_roles cr ON cr.id = mr.role_id
), bare AS (
  SELECT om.org_id, om.user_id, cr.key, cr.permissions FROM org_members om
  JOIN club_roles cr ON cr.org_id = om.org_id AND cr.key = om.role
  WHERE NOT EXISTS (SELECT 1 FROM held h WHERE h.org_id = om.org_id AND h.user_id = om.user_id)
), legacy AS (
  SELECT om.org_id, om.user_id, om.role, NULL FROM org_members om
  WHERE NOT EXISTS (SELECT 1 FROM held h WHERE h.org_id = om.org_id AND h.user_id = om.user_id)
    AND NOT EXISTS (SELECT 1 FROM club_roles cr WHERE cr.org_id = om.org_id AND cr.key = om.role)
), roles AS (SELECT * FROM held UNION ALL SELECT * FROM bare UNION ALL SELECT * FROM legacy),
access AS (
  SELECT org_id, user_id, MAX(role_key = 'admin') AS is_admin,
    MAX(CASE WHEN perms IS NULL THEN role_key IN ('admin','manager') WHEN json_valid(perms) THEN (SELECT COUNT(*) > 0 FROM json_each(perms) WHERE value IN ('invite','manage_members')) ELSE 0 END) AS runs_people,
    MAX(CASE WHEN perms IS NULL THEN role_key IN ('admin','manager') WHEN json_valid(perms) THEN (SELECT COUNT(*) > 0 FROM json_each(perms) WHERE value = 'delete_items') ELSE 0 END) AS runs_things
  FROM roles GROUP BY org_id, user_id
)
SELECT
  (SELECT COUNT(*) FROM warnings WHERE acknowledged_at IS NULL AND subject_user_id IS NOT NULL)
  + (SELECT COUNT(*) FROM warnings w JOIN access a ON a.org_id = w.subject_org_id
     WHERE w.acknowledged_at IS NULL
       AND (a.is_admin = 1 OR (w.scope = 'site' AND a.runs_people = 1) OR (w.scope = 'club' AND a.runs_things = 1)))
  AS expected;
```

Inserted:

```sql
SELECT COUNT(*) AS inserted FROM notifications WHERE subject_kind = 'warning';
```

(Later, `inserted` grows as new warnings and notes are sent.) The migration
test (`apps/server/src/db/notificationsMigration.test.ts`) checks the same on
a seeded database.
