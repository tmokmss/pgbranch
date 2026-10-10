import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hookEnv } from '../../src/hooks.js';
import { formatTable, parseFormat, writeGithubOutputs, type Io } from '../../src/output.js';
import { fillUrlTemplate, libpqEnv, redactUrl, urlHasPassword, withDatabase } from '../../src/url.js';
import type { ResolvedConfig } from '../../src/config.js';

describe('url helpers', () => {
  it('replaces the database', () => {
    expect(withDatabase('postgresql://u:p@h:5432/postgres?sslmode=require', 'app_br_x')).toBe(
      'postgresql://u:p@h:5432/app_br_x?sslmode=require',
    );
    expect(withDatabase('postgres://u@h', 'db')).toBe('postgres://u@h/db');
  });

  it('fills the app URL template', () => {
    expect(fillUrlTemplate('postgresql://app@h:5432/{database}?x=1', 'app_br_x')).toBe('postgresql://app@h:5432/app_br_x?x=1');
  });

  it('builds libpq env', () => {
    expect(libpqEnv('postgresql://us%40er:p%3Ass@db.local:6543/postgres', 'app_br_x')).toEqual({
      PGHOST: 'db.local',
      PGPORT: '6543',
      PGUSER: 'us@er',
      PGPASSWORD: 'p:ss',
      PGDATABASE: 'app_br_x',
    });
    expect(libpqEnv('postgresql://u@[::1]/postgres', 'd')).toMatchObject({ PGHOST: '::1', PGPORT: '5432', PGPASSWORD: '' });
  });

  it('detects and hides passwords', () => {
    expect(urlHasPassword('postgresql://u:p@h/d')).toBe(true);
    expect(urlHasPassword('postgresql://u@h/d')).toBe(false);
    expect(urlHasPassword('not a url')).toBe(false);
    expect(redactUrl('postgresql://u:secret@h/d')).toBe('postgresql://u:***@h/d');
  });
});

describe('hookEnv', () => {
  const base: ResolvedConfig = {
    prefix: 'app',
    maintenanceDatabase: 'postgres',
    strategy: 'template',
    driver: 'pg',
    hooks: {},
    gc: { ttl: '7d' },
    rootDir: '/repo',
  };

  it('gives a URL and libpq vars in pg mode', () => {
    const env = hookEnv({ ...base, adminUrl: 'postgresql://a:b@h:5432/postgres' }, 'app_br_x', 'feature/x');
    expect(env).toEqual({
      DATABASE_URL: 'postgresql://a:b@h:5432/app_br_x',
      PGHOST: 'h',
      PGPORT: '5432',
      PGUSER: 'a',
      PGPASSWORD: 'b',
      PGDATABASE: 'app_br_x',
      PGBRANCH_BRANCH: 'feature/x',
      PGBRANCH_DATABASE: 'app_br_x',
    });
  });

  it('gives ARNs and no URL in Data API mode', () => {
    const env = hookEnv({ ...base, driver: 'data-api', dataApi: { resourceArn: 'r', secretArn: 's' } }, 'app_template_next', undefined);
    expect(env).toEqual({
      PGBRANCH_RESOURCE_ARN: 'r',
      PGBRANCH_SECRET_ARN: 's',
      PGBRANCH_DATABASE: 'app_template_next',
      PGBRANCH_BRANCH: '',
    });
  });
});

describe('output', () => {
  function io(env: NodeJS.ProcessEnv = {}): Io & { out: string } {
    const result = { out: '', stdout: (t: string) => void (result.out += t), stderr: () => {}, env };
    return result;
  }

  it('parses formats', () => {
    expect(parseFormat(undefined, undefined)).toBe('text');
    expect(parseFormat('github', undefined)).toBe('github');
    expect(parseFormat('text', true)).toBe('json');
    expect(() => parseFormat('yaml', undefined)).toThrow();
  });

  it('writes GitHub outputs and masks URLs with a password', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgbranch-gh-'));
    const file = join(dir, 'output');
    writeFileSync(file, 'before=1\n');
    const target = io({ GITHUB_OUTPUT: file });
    writeGithubOutputs(target, { database: 'app_br_x', url: 'postgresql://u:p@h/app_br_x', skipped: undefined });
    expect(target.out).toBe('::add-mask::postgresql://u:p@h/app_br_x\n');
    expect(readFileSync(file, 'utf8')).toBe('before=1\ndatabase=app_br_x\nurl=postgresql://u:p@h/app_br_x\n');
  });

  it('does not mask URLs without a password', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgbranch-gh-'));
    const target = io({ GITHUB_OUTPUT: join(dir, 'o') });
    writeGithubOutputs(target, { url: 'postgresql://app@h/app_br_x' });
    expect(target.out).toBe('');
  });

  it('needs GITHUB_OUTPUT', () => {
    expect(() => writeGithubOutputs(io(), { database: 'x' })).toThrow(/GITHUB_OUTPUT/);
  });

  it('formats a table', () => {
    const text = formatTable([
      { branch: 'main', database: 'app_br_main', createdAt: '2024-01-01T00:00:00.000Z', source: 'template', sizeBytes: 7_700_000 },
      { branch: null, database: 'app_br_x', createdAt: null, source: null, sizeBytes: null },
    ]);
    expect(text).toBe(
      [
        'BRANCH  DATABASE     CREATED                   SIZE',
        'main    app_br_main  2024-01-01T00:00:00.000Z  7.3 MB',
        '?       app_br_x     -                         -',
        '',
      ].join('\n'),
    );
  });
});
