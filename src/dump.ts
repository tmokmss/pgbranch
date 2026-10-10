import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDatabase } from './url.js';

export class ToolMissingError extends Error {
  constructor(tool: string) {
    super(
      `"${tool}" was not found in PATH. The "dump" strategy needs pg_dump and pg_restore ` +
        '(install the PostgreSQL client tools, same major version as the server or newer).',
    );
    this.name = 'ToolMissingError';
  }
}

function run(tool: string, args: string[], env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawn(tool, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(err.code === 'ENOENT' ? new ToolMissingError(tool) : err);
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${tool} failed with exit code ${code}${stderr ? `:\n${stderr.trim()}` : ''}`));
    });
  });
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
function connection(adminUrl: string, database: string): { dbname: string; env: Record<string, string> } {
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

export async function dumpDatabase(adminUrl: string, database: string): Promise<DumpFile> {
  const dir = await mkdtemp(join(tmpdir(), 'pgbranch-'));
  const path = join(dir, 'dump.pgc');
  const cleanup = () => rm(dir, { recursive: true, force: true });
  const { dbname, env } = connection(adminUrl, database);
  try {
    await run('pg_dump', ['--format=custom', `--file=${path}`, `--dbname=${dbname}`], env);
  } catch (err) {
    await cleanup();
    throw err;
  }
  return { path, cleanup };
}

export async function restoreDatabase(adminUrl: string, database: string, file: DumpFile): Promise<void> {
  const { dbname, env } = connection(adminUrl, database);
  await run('pg_restore', ['--exit-on-error', `--dbname=${dbname}`, file.path], env);
}
