import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { withDatabase } from './url.js';

export class ToolMissingError extends Error {
  constructor(tool: string) {
    super(
      `"${tool}" was not found in PATH. The "dump" strategy needs pg_dump and pg_restore ` +
        '(install the PostgreSQL client tools, same major version as the server).',
    );
    this.name = 'ToolMissingError';
  }
}

function output(tool: string, args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(tool, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(err.code === 'ENOENT' ? new ToolMissingError(tool) : err);
    });
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${tool} failed with exit code ${code}${stderr ? `:\n${stderr.trim()}` : ''}`));
    });
  });
}

async function run(tool: string, args: string[], env: Record<string, string>): Promise<void> {
  await output(tool, args, env);
}

/** Check that pg_dump and pg_restore can be started. */
export async function checkDumpTools(): Promise<void> {
  await run('pg_dump', ['--version'], {});
  await run('pg_restore', ['--version'], {});
}

/**
 * Connection args without the password in argv (so it does not show in `ps`).
 * The password goes in PGPASSWORD.
 */
export function connection(adminUrl: string, database: string): { dbname: string; env: Record<string, string> } {
  const u = new URL(withDatabase(adminUrl, database));
  const password = decodeURIComponent(u.password);
  u.password = '';
  const env: Record<string, string> = {};
  if (password) env.PGPASSWORD = password;
  return { dbname: u.toString(), env };
}

export interface DumpFile {
  path: string;
  cleanup(): Promise<void>;
}

export function dumpDatabase(adminUrl: string, database: string): Promise<DumpFile> {
  return dump(adminUrl, database, []);
}

/** Dump the definitions only, no table data. */
export function dumpSchema(adminUrl: string, database: string): Promise<DumpFile> {
  return dump(adminUrl, database, ['--schema-only']);
}

async function dump(adminUrl: string, database: string, args: string[]): Promise<DumpFile> {
  const dir = await mkdtemp(join(tmpdir(), 'pgbranch-'));
  const path = join(dir, 'dump.pgc');
  const cleanup = () => rm(dir, { recursive: true, force: true });
  const { dbname, env } = connection(adminUrl, database);
  try {
    await run('pg_dump', ['--format=custom', ...args, `--file=${path}`, `--dbname=${dbname}`], env);
  } catch (err) {
    await cleanup();
    throw err;
  }
  return { path, cleanup };
}

/** Matches table-of-contents lines of `pg_restore --list` for schemas and their grants. */
const SCHEMA_ENTRY = /^\d+; \d+ \d+ (SCHEMA|ACL - SCHEMA) /;

/** Table-of-contents lines of the dump, narrowed by pg_restore selection flags such as `--section`. */
export async function tocEntries(file: DumpFile, args: string[]): Promise<string[]> {
  return (await output('pg_restore', ['--list', ...args, file.path], {})).split('\n').filter((line) => /^\d+;/.test(line));
}

export function schemaEntries(entries: string[]): string[] {
  return entries.filter((line) => SCHEMA_ENTRY.test(line));
}

/** Restore only the given table-of-contents lines, in one pg_restore run. */
export async function restoreList(adminUrl: string, database: string, file: DumpFile, name: string, entries: string[]): Promise<void> {
  if (entries.length === 0) return;
  const { dbname, env } = connection(adminUrl, database);
  const list = join(dirname(file.path), `${name}.list`);
  await writeFile(list, `${entries.join('\n')}\n`);
  await run('pg_restore', ['--exit-on-error', `--use-list=${list}`, `--dbname=${dbname}`, file.path], env);
}

/**
 * Restore in two passes: schemas and their grants first, then the rest.
 * pg_restore applies grants after all other objects. A non-superuser can only give an object to a
 * role that has CREATE on its schema, so in one pass `ALTER ... OWNER TO` fails when the owner gets
 * CREATE on the schema by a grant.
 */
export async function restoreDatabase(adminUrl: string, database: string, file: DumpFile): Promise<void> {
  const entries = await tocEntries(file, []);
  const schemas = schemaEntries(entries);
  await restoreList(adminUrl, database, file, 'schemas', schemas);
  await restoreList(adminUrl, database, file, 'objects', entries.filter((line) => !schemas.includes(line)));
}
