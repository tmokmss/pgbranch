import { spawn } from 'node:child_process';
import type { ResolvedConfig } from './config.js';
import { libpqEnv, withDatabase } from './url.js';

export class HookError extends Error {
  constructor(
    readonly hook: string,
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
  ) {
    super(
      signal
        ? `Hook "${hook}" was killed by signal ${signal}`
        : `Hook "${hook}" failed with exit code ${exitCode}`,
    );
    this.name = 'HookError';
  }
}

/** Env vars passed to a hook for one database. */
export function hookEnv(config: ResolvedConfig, database: string, branch: string | undefined): Record<string, string> {
  const env: Record<string, string> = {
    PGBRANCH_DATABASE: database,
    PGBRANCH_BRANCH: branch ?? '',
  };
  if (config.driver === 'pg' && config.adminUrl) {
    Object.assign(env, libpqEnv(config.adminUrl, database));
    env.DATABASE_URL = withDatabase(config.adminUrl, database);
  } else if (config.dataApi) {
    env.PGBRANCH_RESOURCE_ARN = config.dataApi.resourceArn;
    env.PGBRANCH_SECRET_ARN = config.dataApi.secretArn;
  }
  return env;
}

export type HookRunner = (name: string, command: string, env: Record<string, string>, cwd: string) => Promise<void>;

/**
 * Run a hook command in a shell. Its stdout and stderr both go to our stderr,
 * so stdout stays clean for `--json` output.
 */
export const runHook: HookRunner = (name, command, env, cwd) =>
  new Promise((resolve, reject) => {
    const baseEnv = { ...process.env };
    // Do not leak variables meant for a different mode into the hook.
    for (const key of ['DATABASE_URL', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSERVICE']) {
      delete baseEnv[key];
    }
    const child = spawn(command, {
      cwd,
      env: { ...baseEnv, ...env },
      shell: true,
      stdio: ['ignore', process.stderr, process.stderr],
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new HookError(name, code, signal));
    });
  });
