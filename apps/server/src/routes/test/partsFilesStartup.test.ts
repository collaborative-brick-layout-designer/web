// What the server says about parts at start (routes/partsFiles.ts). The
// Docker image has no library at PARTS_DIR/parts: admins install them into
// libraries/. That used to warn "parts library not found … /parts/*
// disabled" on every such install, as if something were broken.

import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installedLibraries, registerPartFiles } from '../partsFiles.js';

interface Line {
  level: number;
  msg: string;
}
const INFO = 30;
const WARN = 40;

let dir: string;
let app: FastifyInstance;
let lines: Line[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cbld-parts-start-'));
  lines = [];
  app = Fastify({ logger: { level: 'info', stream: { write: (s: string) => lines.push(JSON.parse(s) as Line) } } });
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const about = (level: number): string[] => lines.filter((l) => l.level === level && /part/i.test(l.msg)).map((l) => l.msg);

describe('the start-up line about part libraries', () => {
  it('warns, and says where to install one, only when no parts library is installed at all', async () => {
    await registerPartFiles(app, dir);
    expect(about(WARN)).toHaveLength(1);
    expect(about(WARN)[0]).toContain('no parts library is installed');
    expect(about(WARN)[0]).toContain('Admin › Part libraries');
    expect(about(WARN)[0]).not.toContain('disabled');
    expect(about(INFO)).toEqual([]);
  });

  it('is a plain info line when the default library was installed through Admin (the Docker setup)', async () => {
    mkdirSync(join(dir, 'libraries', 'bluebrickparts-default'), { recursive: true });
    writeFileSync(join(dir, 'libraries', 'bluebrickparts-default', '3001.1.xml'), '<part/>');
    await registerPartFiles(app, dir);
    expect(about(WARN)).toEqual([]);
    expect(about(INFO)).toEqual([expect.stringContaining('1 installed part library is served from')]);
  });

  it('counts only libraries that hold files', async () => {
    mkdirSync(join(dir, 'libraries', 'empty'), { recursive: true });
    expect(installedLibraries(join(dir, 'libraries'))).toBe(0);
    mkdirSync(join(dir, 'libraries', 'town'), { recursive: true });
    writeFileSync(join(dir, 'libraries', 'town', 'a.xml'), '<part/>');
    mkdirSync(join(dir, 'libraries', 'train'), { recursive: true });
    writeFileSync(join(dir, 'libraries', 'train', 'b.xml'), '<part/>');
    expect(installedLibraries(join(dir, 'libraries'))).toBe(2);
    await registerPartFiles(app, dir);
    expect(about(WARN)).toEqual([]);
    expect(about(INFO)).toEqual([expect.stringContaining('2 installed part libraries are served from')]);
  });

  it('says nothing when the base library is at PARTS_DIR/parts', async () => {
    mkdirSync(join(dir, 'parts'), { recursive: true });
    await registerPartFiles(app, dir);
    expect(about(WARN)).toEqual([]);
    expect(about(INFO)).toEqual([]);
  });
});
