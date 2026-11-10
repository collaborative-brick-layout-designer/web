# Personal data map

What the server stores about people, where, and what happens to it.
Whoever runs a server is the data controller for it: this file is for
them, and for anyone answering a privacy request.

Kept in step with the code: `apps/server/src/privacy/collect.ts` reads
every table marked **Export: yes** for "Download my data", and
`privacyExport.test.ts` fails when a table is added that is neither read
there nor listed in `NO_PERSONAL_DATA`, or when a table is missing here.

Times are stored as Unix milliseconds. Nothing in the database records IP
addresses or browser user agents: the server reads the user agent only to
count browser vs desktop requests (`metrics/activity.ts`, counts only) and
to check the desktop app's version, and its web server log (stdout) is the
host's to keep or not.

## Accounts and sign-in

| Table | Personal data | Export | Notes |
|---|---|---|---|
| `users` | email, display name, avatar URL, password hash, admin/moderator flags, created and last-seen times, deletion and restriction dates | yes (no hash) | `last_seen_at` is one time, rounded, no history. |
| `sessions` | which browsers are signed in, since when (`created_at`) and until when, when each was last used (`last_used_at`, to the nearest 5 minutes) and a rough browser name (`device`, e.g. "Firefox on Linux") | yes (no ids) | The id is a hash of the cookie: a secret. `created_at` is kept so a sign-in ends at its longest (Admin › Site settings › Sign-in); sessions from before it existed got the upgrade's time. The full user agent is never stored. Shown to the person under Profile › Browsers and devices, where they can sign each out. |
| `api_tokens` | desktop sign-ins: name, prefix and last 4 characters, scopes, last used | yes (no hash) | Revoked rows are kept so the Devices list can show them. |
| `device_codes` | desktop sign-in codes a person approved or denied | yes (no codes) | Expire after minutes. |
| `oauth_accounts` | the Google / GitHub / OIDC account id linked | yes | |
| `email_verifications` | open "confirm your email" links | yes (no token) | |
| `password_resets` | open "Forgot password?" links: when asked for, when they end | yes (no token) | Only a hash of the link is kept. A link works once, for an hour; it's deleted when used, when a newer one is asked for, or when the password changes, and expired ones are swept with old sign-ins. |
| `user_preferences` | theme, text size, help and tour settings | yes | |

## Clubs

| Table | Personal data | Export | Notes |
|---|---|---|---|
| `orgs` | `created_by` (who started it) | as "clubs-started" | The club's own data otherwise. |
| `org_members` | membership and role | yes | |
| `member_roles` | which club roles a member holds | yes | Go with the membership. |
| `club_logos` | a club's logo picture (WebP), who set it and when | no (the club's own data; in the club's download as club-logo.webp) | |
| `club_roles` | a club's roles and what each allows | no (the club's own data; in the club's download) | |
| `org_invites` | invited email, who invited | yes (no token) | Either side's. |
| `org_join_requests` | request and its note | yes | |
| `org_part_libraries` | none | no | Club settings. |

## Things people make

| Table | Personal data | Export | Notes |
|---|---|---|---|
| `layouts` | owner, creator, title, the layout itself; `deleted_author_id` | yes, own layouts as `.bld-layout` files | Background pictures live on disk in `bgimages/<layout id>.<ext>` and go inside the `.bld-layout`. |
| `layout_updates` | recent edits waiting to be folded in | inside the layout file | |
| `layout_collaborators` | who a layout is shared with, and their role | yes | |
| `layout_invites` | invited email, who sent it | yes (no token) | Pending ones go when the layout changes hands. |
| `layout_transfers` | who offered a layout to which email | yes (no token) | |
| `modules` | owner, creator, title, the module, its picture | yes, own modules as `.bld-layout` + picture | |
| `module_versions` | who saved each version, and its note | yes (metadata) | |
| `module_collaborators` | shares | yes | |
| `module_transfers` | offers | yes (no token) | |
| `module_invites` | who invited which email to a module, and the role | yes (no token) | Pending ones go when the module changes hands. |
| `custom_parts` | owner, creator, the part's XML and picture | yes, own parts as XML + picture | The XML may name an author. |
| `custom_part_collaborators` | shares | yes | |
| `custom_part_invites` | who invited which email to a custom part, and the role | yes (no token) | Pending ones go when the part changes hands. |
| `custom_part_set_shares` | which custom parts someone has only because a set of them was shared with them | yes | Go with the set's share: taking the set back, leaving it or deleting it removes them, and the parts too. |
| `venue_library` | owner, creator, the venue | yes, own venues as JSON | |
| `trash_items` | a layout, module or venue its owner deleted (all of it, gzipped), who deleted it, when, and when it goes for good | yes (what, when and when it goes; not the contents) | Recently deleted: kept 30 days so it can be restored, then erased by the hourly privacy clean-up. Erasing an account or a club erases its trash with it. Deleting from Recently deleted erases it at once. |
| `part_libraries` | none | no | Installed by site admins. |

## Public catalog

| Table | Personal data | Export | Notes |
|---|---|---|---|
| `catalog_items` | owner, title, description, tags | yes | Public while published. Modules, parts, layouts and venues. |
| `catalog_item_versions` | who submitted and who reviewed, notes; a published layout or venue copy | yes (metadata; published layouts and venues as files in `catalog/`) | A published layout is a cleaned copy: no history, collaborators, comments, chat, local file paths, background picture or venue notes. A venue leaves out its notes. |
| `catalog_copies` | who added which item | yes | |
| `catalog_collections` | curator, title, description, notes | yes | |
| `catalog_collection_covers` | uploaded cover pictures, uploader | yes, pictures in `covers/` | Re-encoded, no picture metadata. |
| `catalog_item_covers` | uploaded cover pictures for catalog items, uploader | yes, pictures in `covers/` | Re-encoded, no picture metadata. Deleted with the item. |
| `catalog_collection_items`, `catalog_collection_modules`, `catalog_collection_parts` | none | no | Which things are in a collection. |

## Moderation, limits and records

| Table | Personal data | Export | Notes |
|---|---|---|---|
| `warnings` | warnings and notes to a person, the reason, who sent and read them | yes | Also used for "your download is ready" notes. |
| `limit_overrides` | a person's own limits, suspension and its reason | yes | |
| `usage_daily` | per-person daily counts (requests, uploads, bytes) | yes | Numbers only; swept after `USAGE_RETENTION_DAYS`. |
| `daily_stats` | none | no | Site-wide daily numbers. |
| `audit_events` | who did what to which thing, with a JSON payload; some payloads name an email (invites, admin actions) | yes | No IP addresses or user agents. A refused live edit notes the sender's app as a rough name ("Firefox on Linux", "Desktop app 2.0.12"), shown to site admins only and removed with the other personal fields after the audit retention period. A deleted layout's own rows stay (its `layout_id` has no foreign key), with a `layout_delete` (by its owner) or `admin_layout_delete` row naming who deleted it, its title and whether it was the person's or a club's; site admins read them under Admin › Audit log › Deleted layouts. They're kept, trimmed and scrubbed on account erasure like every other audit row. |
| `platform_settings` | `updated_by` (the admin who last saved) | as "site-settings-changes" | |
| `data_fixes` | none | no | Which one-time data fixes the server has run, when, and how many values each changed (counts only). |
| `data_exports` | data downloads: about whom, asked by whom, when | yes | Files in `exports/<id>.zip` next to the database. |
| `privacy_requests` | requests logged by admins: type, the account or (with no account) who asked in the admin's words, dates, notes | yes | Closed ones are deleted after the records setting. After an erasure the request keeps the pseudonym. |
| `privacy_request_events` | the history of a request (which admin did what) | with its request | |
| `erasures` | none: a pseudonym, when, how, counts | no | Deleted after the records setting. |

## Files outside the database

| Where | What | Export |
|---|---|---|
| `bgimages/<layout id>.<ext>` | layout background pictures | inside the layout's `.bld-layout` |
| `exports/<id>.zip` | data downloads | n/a (it is the download) |
| `BACKUPS_DIR/cbld-*.sqlite.gz` | nightly database copies (7 daily, 3 weekly, 12 monthly) | no: they are copies of the above |

## The demo

"Try the demo" makes a private demo space for each visitor: a `users` row
with `is_demo_account` set, a made-up name ("Demo builder 7f3a"), a
`demo-…@demo.invalid` address (no real email, no password) and
`demo_expires_at`, the end of its one sign-in. Its `sessions` row records
no user agent, device name or IP. The space gets a copy of the samples, and anything the
visitor makes is stored like anyone's. It can't invite, share, make public
links, join clubs, send to the catalog, upload parts or connect a desktop
app, so nothing it makes outlives it; a background picture is at most 2 MB.

The space, everything it owns (layouts and their history, modules and their
versions, venues, background pictures, preferences) and its sign-in are
deleted when its time is up: at the next demo reset, or after 24 hours at
most, or a minute after its sign-in ends. The clean-up runs at start-up and
every few minutes, by the clock, so a closed tab or a restart leaves nothing
behind. Each deletion writes one `demo_space_deleted` audit event with the
counts (no names or contents); audit events are kept as above.

The samples live under the template account `demo-account`, which belongs
to nobody and is never signed in to, so it can't download its data.

## The desktop app

The desktop app keeps its layouts on the computer. On the server it has
only its sign-in (`api_tokens`, and the `device_codes` row it was approved
with) and whatever it publishes, which is stored like anything made on the
website. "Download my data" includes all of it.

## Deleting an account

"Delete my account" (Profile) waits first: 14 days by default, 7 to 30
in Admin › Settings › Privacy (`PRIVACY_DELETION_GRACE_DAYS` forces it).
The person is signed out of every browser; desktop sign-ins are refused
with `403 account_pending_deletion` (the desktop shows why). Signing back
in cancels it. An admin's "Delete" in Admin › Users erases at once.

When the account is erased (`privacy/accountDeletion.ts`):

| Data | What happens |
|---|---|
| `users`, `sessions`, `api_tokens`, `device_codes`, `oauth_accounts`, `email_verifications`, `password_resets`, `user_preferences` | deleted |
| `org_members`, `org_join_requests` | deleted. A club they were the **last admin** of gets a new admin, chosen by what their roles may do: someone who may manage members and roles, else someone who may invite people, else the longest-standing member (longest-standing first within each); they get a note. A club with **nobody else** in it is deleted. |
| `layouts`, `modules`, `custom_parts`, `venue_library`, `catalog_items`, personal `catalog_collections` they own alone | deleted (with their background pictures and data downloads on disk). Copies other people added from the catalog are theirs and stay. |
| Club things they made | stay with the club: `created_by` moves to a club admin, chosen the same way (it must name an account), `deleted_author_id` keeps the credit "Builder #…". A club collection they curate moves to them too. |
| `layout_collaborators`, `module_collaborators`, `custom_part_collaborators` | deleted: they leave share lists. Their edits to other people's layouts stay. |
| Invites and transfers they sent, or addressed to their email | deleted |
| `warnings` to them | deleted; warnings they sent keep `issued_by` empty |
| `usage_daily`, `limit_overrides` about them | deleted |
| `audit_events` | kept, pseudonymised: their rows get `actor_label` "Deleted user #abc123" and `user_id` empty; their email is replaced by "(erased)" in every payload, and their name in their own rows |
| `erasures` | a new row: kind, the pseudonym, how (self / admin / request), when, and counts only |

The last site admin can never be deleted.

## Privacy requests and restriction

Admin › Privacy requests logs requests that arrive by email, letter or in
person (access, erasure, rectification, restriction, objection, other),
each due a month after it arrived by default (`requestDueDays`). Overdue
and nearly-due ones (within 7 days) show a badge on the Admin menu entry
and a card on the dashboard. One-click answers, all audit-logged
(`privacy_request`) and kept in the request's history:

- **Export their data**: the same zip as "Download my data", for the admin to download and send.
- **Restrict**: `users.restricted_at`. The account is read only (every change refused with `403 account_restricted`, except signing in and out, reading notices, and downloading or deleting its own data), its live editing is read only, and what it owns alone is frozen for everyone (its role caps at viewer). Lifting it undoes all of that.
- **Erase now**: the erasure above, with no waiting time, after typing the account's email.

## Keeping data no longer than needed

Admin › Settings › Privacy, all adjustable, each forced by its env var
when set. The hourly privacy clean-up (`privacy/retention.ts`) applies them:

| Setting | Default | What goes |
|---|---|---|
| `exportKeepDays` | 7 days | data downloads (row and file) |
| `deletionGraceDays` | 14 days (7 to 30) | accounts waiting to be deleted are erased |
| `requestDueDays` | 30 days | (when a logged request is due) |
| `auditPersonalDays` | 365 days | email addresses, and any `ip` / `userAgent` field, in older audit payloads |
| `expiredSignInDays` | 30 days | expired sessions, revoked or expired desktop sign-ins, device codes, email confirmation links, unaccepted invites and offers |
| `recordsKeepDays` | 1095 days | erasure records, and closed privacy requests |
| always | | background pictures whose layout is gone |

`usage_daily` and `daily_stats` keep their own sweeps (`USAGE_RETENTION_DAYS`,
`ROLLUP_RETENTION_DAYS`). Backups keep 7 daily, 3 weekly and 12 monthly
copies; an erased account stays in older backups until they rotate out.

## Who sees email addresses

Display names never show an address (`publicName`). On a layout's,
module's or part's share list, addresses show only to the person
themselves, the owners (who manage sharing) and site admins; pending
invites (addresses only) show only to owners. Club member lists already
showed addresses only to the people whose roles may invite people or manage members.

## The privacy page

`/privacy` shows the notice an admin writes (markdown, Admin › Settings ›
Privacy) and the privacy contact (an email or web address;
`PRIVACY_CONTACT` forces it), with links to download your data and delete
your account. It is linked at the bottom of Home, on the sign-in page,
under Help in the menu, and on sign-up. The dashboard nudges while the
notice or contact is empty.

## Deleting a club

A club's admins delete it from its Settings; a site admin from Admin ›
Clubs. Before deleting, the admin can download the club's data (the same
zip format, about the club: members with their emails, invites, things,
collections, notices and its audit log; club admins only) and move all its
layouts or modules to a member or another club.

The confirmation lists what goes and asks what happens to anything the
club published in the public catalog: hand it to a member (the default;
they become its owner and it stays up) or take it down. Copies people
already added are theirs either way. Then the club's name is typed.

The club then **waits** (the same `deletionGraceDays` as accounts):

- it's hidden at once: its memberships move into `orgs.deletion_plan`
  (with whether it was listed and the catalog choice), so lists, pages,
  share links and access checks stop showing it; live editors close;
- every member gets a notice saying who deleted it, when it goes for good,
  and that its admins or a site admin can restore it;
- **Restore** (Clubs › Being deleted, or Admin › Clubs) puts the
  memberships back as they were, with each member's roles. If none of its
  admins is still here, one member becomes its admin, chosen as for a
  deleted account's club (above).

After the wait (or a site admin's **Erase now**, behind the typed name)
the catalog choice is applied and the club goes with everything it owns
(`layouts`, `modules`, `custom_parts`, `venue_library`, members-only
collections, invites, join requests, notices), its background pictures and
club data downloads, leaving an `erasures` row ("Deleted club #…", counts).
`orgs.deleted_by` holds the id of whoever deleted it, without a foreign key.
