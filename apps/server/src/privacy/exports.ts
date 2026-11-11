// "Download my data": a zip of everything about a person (or a club),
// built in the background so a big library never holds up a request.
//
//   startExport()   adds a data_exports row ('building') and builds the zip
//                   on the next tick; the row becomes 'ready' (or 'failed',
//                   with why) and whoever asked gets a notice and an email.
//   exportPath()    where the zip lives: exports/<id>.zip next to the database.
//
// The zip holds a README.txt in plain words, data/*.json (every row about
// the person, see collect.ts) and their own files (exportFiles.ts). It is
// capped at the Privacy setting's size and kept for its number of days.
// Only the person who asked may download it.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { env } from '../env.js';
import type { DataExport } from '../db/schema.js';
import { collectOrgData, collectUserData, type DataSection } from './collect.js';
import { writeOwnedFiles, type FileCounts, type Owner } from './exportFiles.js';
import { privacySettings } from './settings.js';
import { ZipFileWriter, ZipTooBigError } from './zipWriter.js';
import { postPersonalNote } from '../routes/warnings.js';
import { sendNoticeEmail, siteUrl } from '../email/sendNotice.js';
import { publish } from '../events/audience.js';
import { privacyContact } from './page.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function exportsDir(): string {
  return join(dirname(env.dbPath), 'exports');
}

export function exportPath(id: string): string {
  return join(exportsDir(), `${id}.zip`);
}

/** Exports still building, by id, so tests (and shutdown) can wait for them. */
const running = new Map<string, Promise<void>>();

/** Wait for every export that is building (tests). */
export async function settleExports(): Promise<void> {
  while (running.size) await Promise.all([...running.values()]);
}

/** When `requestedBy` may ask for another download of `subject`, or null when they may now. */
export async function nextExportAllowedAt(requestedBy: string, subject: Owner, now = Date.now()): Promise<number | null> {
  const { exportEveryHours } = await privacySettings(now);
  const last = await db
    .select({ createdAt: schema.dataExports.createdAt, status: schema.dataExports.status })
    .from(schema.dataExports)
    .where(
      and(
        eq(schema.dataExports.requestedBy, requestedBy),
        eq(schema.dataExports.subjectKind, subject.kind),
        eq(schema.dataExports.subjectId, subject.id),
        gt(schema.dataExports.createdAt, new Date(now - exportEveryHours * HOUR_MS)),
      ),
    )
    .orderBy(desc(schema.dataExports.createdAt))
    .all();
  // A failed one doesn't count: asking again is the way to retry.
  const counted = last.find((r) => r.status !== 'failed');
  return counted ? counted.createdAt.getTime() + exportEveryHours * HOUR_MS : null;
}

export interface ExportOut {
  id: string;
  subjectKind: 'user' | 'org';
  subjectId: string;
  status: DataExport['status'];
  sizeBytes: number | null;
  error: string | null;
  createdAt: number;
  readyAt: number | null;
  expiresAt: number | null;
  downloadedAt: number | null;
  /** Where to download it (the person who asked only). */
  downloadUrl: string | null;
}

export function describeExport(r: DataExport, now = Date.now()): ExportOut {
  const live = r.status === 'ready' && !!r.expiresAt && r.expiresAt.getTime() > now;
  return {
    id: r.id,
    subjectKind: r.subjectKind,
    subjectId: r.subjectId,
    status: r.status === 'ready' && !live ? 'failed' : r.status,
    sizeBytes: r.sizeBytes,
    error: r.status === 'ready' && !live ? 'This download has expired. Ask for a new one.' : r.error,
    createdAt: r.createdAt.getTime(),
    readyAt: r.readyAt?.getTime() ?? null,
    expiresAt: r.expiresAt?.getTime() ?? null,
    downloadedAt: r.downloadedAt?.getTime() ?? null,
    downloadUrl: live ? `/api/privacy/exports/${r.id}/download` : null,
  };
}

/** Exports `requestedBy` asked for about `subject`, newest first. */
export async function listExports(requestedBy: string, subject: Owner): Promise<ExportOut[]> {
  const rows = await db
    .select()
    .from(schema.dataExports)
    .where(
      and(
        eq(schema.dataExports.requestedBy, requestedBy),
        eq(schema.dataExports.subjectKind, subject.kind),
        eq(schema.dataExports.subjectId, subject.id),
      ),
    )
    .orderBy(desc(schema.dataExports.createdAt))
    .limit(10)
    .all();
  return rows.map((r) => describeExport(r));
}

/**
 * Start building a download. The caller has checked who may ask; this
 * only writes the row and queues the work. `opts.inline` builds it before
 * returning (tests).
 */
export async function startExport(args: {
  subject: Owner;
  requestedBy: string;
  reason: DataExport['reason'];
  now?: Date;
}): Promise<DataExport> {
  const now = args.now ?? new Date();
  const row: DataExport = {
    id: randomUUID(),
    subjectKind: args.subject.kind,
    subjectId: args.subject.id,
    requestedBy: args.requestedBy,
    reason: args.reason,
    status: 'building',
    sizeBytes: null,
    error: null,
    createdAt: now,
    readyAt: null,
    expiresAt: null,
    downloadedAt: null,
  };
  await db.insert(schema.dataExports).values(row);
  const job = new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => buildExport(row.id))
    .catch((err) => console.error('[privacy] export failed:', err))
    .finally(() => running.delete(row.id));
  running.set(row.id, job);
  return row;
}

const SECTION_README = (sections: DataSection[]) =>
  sections.map((s) => `  data/${s.name}.json  (${s.rows.length})  ${s.about}`).join('\n');

function readme(args: {
  club: boolean;
  about: string;
  sections: DataSection[];
  counts: FileCounts;
  when: Date;
  keepDays: number;
  contact: string | null;
}): string {
  const site = siteUrl('/');
  const c = args.counts;
  return [
    args.club ? `Your club's data from Collaborative Brick Layout Designer` : `Your data from Collaborative Brick Layout Designer`,
    `====================================`,
    ``,
    `This is a copy of ${args.about} on ${site}`,
    `It was made on ${args.when.toUTCString()}.`,
    ``,
    `What is in here`,
    `---------------`,
    ``,
    `data/        Everything the site's database holds, as JSON files you can open in any`,
    `             text editor. Times are in UTC. Pictures and layouts are left out of these`,
    `             files (they say only how big they are) because they are in the folders below.`,
    ``,
    SECTION_README(args.sections),
    ``,
    `layouts/     ${c.layouts} layout(s) as .bld-layout files. Open them with Collaborative Brick Layout Designer`,
    `             (the desktop app, or "Open a layout file" on the website).`,
    `modules/     ${c.modules} module(s) as .bld-layout files, with their pictures.`,
    `parts/       ${c.parts} custom part(s): each part's XML and its picture, as BlueBrick uses them.`,
    `venues/      ${c.venues} venue(s) (rooms), as JSON.`,
    `covers/      ${c.covers} cover picture(s) you uploaded for collections and catalog items.`,
    `catalog/     ${c.catalog} layout(s) and venue(s) as published in the public catalog.`,
    ...(c.deleted
      ? [
          `recently-deleted/`,
          `             ${c.deleted} layout(s), module(s) and venue(s) waiting in Recently deleted, as the same`,
          `             kinds of files. They are erased 30 days after they were deleted.`,
        ]
      : []),
    ...(c.raw ? [``, `${c.raw} item(s) had nothing drawn in them yet, so they are saved as raw .ydoc data.`] : []),
    ``,
    `What is not in here`,
    `-------------------`,
    ``,
    ...(args.club
      ? [
          `- Members' own things: their personal layouts and modules stay theirs.`,
          `- Invite links: they are secrets. data/invites.json says which invites exist.`,
          `- The member list holds email addresses: keep this file as carefully as the club's`,
          `  own records.`,
        ]
      : [
          `- Your password and sign-in keys. They are secrets: anyone holding them could sign in`,
          `  as you. The files say where one exists.`,
          `- Things that belong to a club. Club layouts and modules you made are listed in data/,`,
          `  but the files belong to the club. A club admin can download the club's data.`,
          `- Other people's layouts that were shared with you. data/ lists which ones.`,
        ]),
    ``,
    `This download is kept on the server for ${args.keepDays} day(s), then deleted.`,
    ...(args.contact ? [``, `Questions about your data: ${args.contact}`] : []),
    ``,
  ].join('\n');
}

/** Hooks later features add to the README (the site's privacy contact). */
export const exportHooks: { contact: () => Promise<string | null> } = { contact: async () => (await privacyContact()).value };

async function buildExport(id: string): Promise<void> {
  const row = await db.select().from(schema.dataExports).where(eq(schema.dataExports.id, id)).get();
  if (!row || row.status !== 'building') return;
  const settings = await privacySettings();
  const maxBytes = settings.exportMaxMb * 1024 * 1024;
  mkdirSync(exportsDir(), { recursive: true });
  const path = exportPath(id);
  const zip = new ZipFileWriter(path, maxBytes);
  let failure: string | null = null;
  try {
    const subject: Owner = { kind: row.subjectKind, id: row.subjectId };
    const sections = subject.kind === 'user' ? await collectUserData(subject.id) : await collectOrgData(subject.id);
    if (sections.length === 0) throw new Error('gone');
    // Files first, so the README can say how many of each.
    const counts = await writeOwnedFiles(zip, subject);
    for (const s of sections) zip.add(`data/${s.name}.json`, JSON.stringify({ about: s.about, rows: s.rows }, null, 2));
    zip.add(
      'README.txt',
      readme({
        club: subject.kind === 'org',
        about: subject.kind === 'user' ? 'everything about your account' : 'everything the club holds',
        sections,
        counts,
        when: new Date(),
        keepDays: settings.exportKeepDays,
        contact: await exportHooks.contact(),
      }),
    );
    zip.finish();
  } catch (err) {
    zip.close();
    try {
      unlinkSync(path);
    } catch {
      /* nothing written */
    }
    failure =
      err instanceof ZipTooBigError
        ? `The download would be bigger than ${settings.exportMaxMb} MB, the site's limit. Ask the site admin to raise it, or delete things you don't need and try again.`
        : (err as Error).message === 'gone'
          ? 'There is nothing to download: the account or club is gone.'
          : 'Something went wrong while making the download. Please try again later.';
    if (!(err instanceof ZipTooBigError) && (err as Error).message !== 'gone') console.error('[privacy] export build failed:', err);
  }
  const now = new Date();
  if (failure) {
    await db.update(schema.dataExports).set({ status: 'failed', error: failure }).where(eq(schema.dataExports.id, id));
  } else {
    await db
      .update(schema.dataExports)
      .set({ status: 'ready', sizeBytes: statSync(path).size, readyAt: now, expiresAt: new Date(now.getTime() + settings.exportKeepDays * DAY_MS) })
      .where(eq(schema.dataExports.id, id));
  }
  await tellRequester(id, !failure);
}


/** Where the person who asked finds it. */
function pageFor(row: DataExport): string {
  if (row.reason === 'admin') return '/admin?tab=privacy';
  if (row.reason === 'club') return '/orgs';
  return '/profile#my-data';
}

async function tellRequester(id: string, ok: boolean): Promise<void> {
  const row = await db.select().from(schema.dataExports).where(eq(schema.dataExports.id, id)).get();
  if (!row?.requestedBy) return;
  const who = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, row.requestedBy)).get();
  if (!who) return;
  const page = pageFor(row);
  const what = row.reason === 'self' ? 'Your data download' : 'The data download you asked for';
  const until = row.expiresAt ? row.expiresAt.toUTCString() : '';
  const text = ok ? `${what} is ready. You can download it until ${until}.` : `${what} could not be made. ${row.error ?? ''}`.trim();
  await postPersonalNote(row.requestedBy, text, page);
  void publish({ kind: 'me', owner: { kind: 'user', id: row.requestedBy }, action: 'update:export' });
  if (row.reason === 'admin') void publish({ kind: 'admin', action: 'update:export' }, { ownerless: true });
  await sendNoticeEmail({
    to: who.email,
    subject: ok ? `${what} is ready` : `${what} could not be made`,
    paragraphs: [text, ok ? 'Only you can download it, while signed in.' : ''].filter(Boolean),
    link: { text: ok ? 'Download it here' : 'Try again here', path: page },
  });
}

/**
 * The server stopped while a download was building: mark those failed so
 * the person can ask again (called at start-up).
 */
export async function failInterruptedExports(): Promise<number> {
  const rows = await db.select({ id: schema.dataExports.id }).from(schema.dataExports).where(eq(schema.dataExports.status, 'building')).all();
  const stuck = rows.map((r) => r.id).filter((id) => !running.has(id));
  if (stuck.length === 0) return 0;
  await db
    .update(schema.dataExports)
    .set({ status: 'failed', error: 'The server restarted while making this download. Please ask again.' })
    .where(inArray(schema.dataExports.id, stuck));
  return stuck.length;
}

/** Delete expired downloads (rows and files) and stray files. Returns how many went. */
export async function purgeExpiredExports(now = new Date()): Promise<number> {
  const rows = await db.select().from(schema.dataExports).all();
  let gone = 0;
  const { exportKeepDays } = await privacySettings(now.getTime());
  for (const r of rows) {
    const expired = r.expiresAt ? r.expiresAt.getTime() <= now.getTime() : r.createdAt.getTime() + exportKeepDays * DAY_MS <= now.getTime();
    if (!expired || r.status === 'building') continue;
    removeExportFile(r.id);
    await db.delete(schema.dataExports).where(eq(schema.dataExports.id, r.id));
    gone++;
  }
  // Files with no row (an erased account's, or an interrupted build).
  const dir = exportsDir();
  if (existsSync(dir)) {
    const { readdirSync } = await import('node:fs');
    const ids = new Set((await db.select({ id: schema.dataExports.id }).from(schema.dataExports).all()).map((r) => r.id));
    for (const f of readdirSync(dir)) {
      const id = f.replace(/\.zip$/, '');
      if (!ids.has(id) && !running.has(id)) {
        try {
          unlinkSync(join(dir, f));
        } catch {
          /* best effort */
        }
      }
    }
  }
  return gone;
}

export function removeExportFile(id: string): void {
  try {
    unlinkSync(exportPath(id));
  } catch {
    /* already gone */
  }
}

/** Delete every download about, or asked for by, someone (their account is being erased). */
export async function removeExportsOf(subject: Owner): Promise<void> {
  const rows = await db
    .select({ id: schema.dataExports.id })
    .from(schema.dataExports)
    .where(and(eq(schema.dataExports.subjectKind, subject.kind), eq(schema.dataExports.subjectId, subject.id)))
    .all();
  const mine =
    subject.kind === 'user'
      ? await db.select({ id: schema.dataExports.id }).from(schema.dataExports).where(eq(schema.dataExports.requestedBy, subject.id)).all()
      : [];
  const ids = [...new Set([...rows, ...mine].map((r) => r.id))];
  for (const id of ids) removeExportFile(id);
  if (ids.length) await db.delete(schema.dataExports).where(inArray(schema.dataExports.id, ids));
}
