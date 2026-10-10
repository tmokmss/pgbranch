import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../../src/main.js';
import type { Io } from '../../src/output.js';
import { adminUrl, dropAllWithPrefix, enabled, ensureRole, sqlHook, uniquePrefix } from './helpers.js';

describe.skipIf(!enabled)('CLI', () => {
  const prefix = uniquePrefix('cli');
  const dir = mkdtempSync(join(tmpdir(), 'pgbranch-cli-'));
  const configPath = join(dir, 'pgbranch.json');

  async function run(args: string[], env: NodeJS.ProcessEnv = {}) {
    let stdout = '';
    let stderr = '';
    const io: Io = {
      stdout: (t) => void (stdout += t),
      stderr: (t) => void (stderr += t),
      env: { PGBRANCH_ADMIN_URL: adminUrl(), ...env },
    };
    const code = await main(['--config', configPath, ...args], io);
    return { code, stdout, stderr };
  }

  beforeAll(async () => {
    await ensureRole();
    writeFileSync(
      configPath,
      JSON.stringify({
        prefix,
        hooks: { migrate: sqlHook('create table if not exists t (id int)') },
        appUrl: 'postgresql://app_user@db.example.com:5432/{database}',
      }),
    );
  });
  afterAll(() => dropAllWithPrefix(prefix));

  it('runs the main flow with text and JSON output', async () => {
    expect((await run(['template', 'refresh'])).code).toBe(0);

    const created = await run(['create', 'feature/cli']);
    expect(created).toMatchObject({ code: 0, stdout: `postgresql://app_user@db.example.com:5432/${prefix}_br_feature_cli\n` });

    const json = await run(['create', 'feature/cli', '--if-not-exists', '--json']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ database: `${prefix}_br_feature_cli`, created: false, migrated: true });

    const list = await run(['list', '--format', 'json']);
    expect(JSON.parse(list.stdout)).toMatchObject([{ branch: 'feature/cli', database: `${prefix}_br_feature_cli` }]);

    const table = await run(['list']);
    expect(table.stdout).toContain('feature/cli');

    const url = await run(['url', 'feature/cli']);
    expect(url.stdout).toBe(`postgresql://app_user@db.example.com:5432/${prefix}_br_feature_cli\n`);

    const gc = await run(['gc', '--ttl', '0s', '--keep', 'feature/cli', '--json']);
    expect(JSON.parse(gc.stdout)).toMatchObject({ dropped: [], kept: [{ branch: 'feature/cli' }] });

    const dryDelete = await run(['--dry-run', 'delete', 'feature/cli']);
    expect(dryDelete.stdout).toBe(`[dry-run] Deleted ${prefix}_br_feature_cli\n`);
    expect(dryDelete.stderr).toContain(`[dry-run] DROP DATABASE IF EXISTS "${prefix}_br_feature_cli" WITH (FORCE)`);

    expect((await run(['delete', 'feature/cli'])).stdout).toBe(`Deleted ${prefix}_br_feature_cli\n`);
    expect((await run(['delete', 'feature/cli', '--if-exists'])).code).toBe(0);
  });

  it('writes GitHub outputs and masks the admin URL', async () => {
    const outFile = join(dir, 'github_output');
    writeFileSync(outFile, '');
    // No appUrl: the output is the admin URL, which has a password.
    const noApp = mkdtempSync(join(tmpdir(), 'pgbranch-cli-'));
    writeFileSync(join(noApp, 'pgbranch.json'), JSON.stringify({ prefix, hooks: {} }));
    let stdout = '';
    const code = await main(['--config', join(noApp, 'pgbranch.json'), 'create', 'gh', '--format', 'github'], {
      stdout: (t) => void (stdout += t),
      stderr: () => {},
      env: { PGBRANCH_ADMIN_URL: adminUrl(), GITHUB_OUTPUT: outFile },
    });
    expect(code).toBe(0);
    const url = new URL(adminUrl());
    url.pathname = `/${prefix}_br_gh`;
    expect(stdout.split('\n')[0]).toBe(`::add-mask::${url.toString()}`);
    expect(readFileSync(outFile, 'utf8')).toBe(`database=${prefix}_br_gh\nurl=${url.toString()}\n`);
    expect((await run(['delete', 'gh'])).code).toBe(0);
  });

  it('reports errors with exit code 1 and hides the admin password', async () => {
    const result = await run(['url', 'missing']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^pgbranch: error: Database .* does not exist/);

    const bad = await run(['list'], { PGBRANCH_ADMIN_URL: 'postgresql://pgbranch_it:wrong-password@localhost:1/postgres' });
    expect(bad.code).toBe(1);
    expect(bad.stderr).not.toContain('wrong-password');
  });

  it('rejects a bad command', async () => {
    const result = await run(['nope']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown command 'nope'");
  });
});
