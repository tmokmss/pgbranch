import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.js';

const ADMIN = 'postgresql://admin:secret@db.example.com:5432/postgres';

function dirWith(config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'pgbranch-config-'));
  if (config !== undefined) {
    writeFileSync(join(dir, 'pgbranch.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  return dir;
}

describe('loadConfig', () => {
  it('loads the file and applies defaults', () => {
    const dir = dirWith({ prefix: 'app', hooks: { migrate: 'npm run migrate' } });
    const config = loadConfig({ cwd: dir, env: { PGBRANCH_ADMIN_URL: ADMIN } });
    expect(config).toMatchObject({
      prefix: 'app',
      maintenanceDatabase: 'postgres',
      strategy: 'template',
      driver: 'pg',
      hooks: { migrate: 'npm run migrate', seed: undefined },
      gc: { ttl: '7d' },
      adminUrl: ADMIN,
      rootDir: dir,
      configPath: join(dir, 'pgbranch.json'),
    });
  });

  it('works without a file when the prefix comes from env', () => {
    const dir = dirWith();
    const config = loadConfig({ cwd: dir, env: { PGBRANCH_ADMIN_URL: ADMIN, PGBRANCH_PREFIX: 'ci' } });
    expect(config.prefix).toBe('ci');
    expect(config.rootDir).toBe(dir);
    expect(config.configPath).toBeUndefined();
  });

  it('env overrides the file, flags override env', () => {
    const dir = dirWith({ prefix: 'file', strategy: 'template', gc: { ttl: '1d' }, maintenanceDatabase: 'm1' });
    const env = {
      PGBRANCH_ADMIN_URL: ADMIN,
      PGBRANCH_PREFIX: 'env',
      PGBRANCH_STRATEGY: 'dump',
      PGBRANCH_GC_TTL: '2d',
      PGBRANCH_HOOKS_MIGRATE: 'env-migrate',
    };
    const fromEnv = loadConfig({ cwd: dir, env });
    expect(fromEnv).toMatchObject({ prefix: 'env', strategy: 'dump', gc: { ttl: '2d' }, maintenanceDatabase: 'm1' });
    expect(fromEnv.hooks.migrate).toBe('env-migrate');

    const fromFlags = loadConfig({
      cwd: dir,
      env,
      overrides: { prefix: 'flag', strategy: 'template', gcTtl: '3d', migrateHook: 'flag-migrate', maintenanceDatabase: 'm2' },
    });
    expect(fromFlags).toMatchObject({ prefix: 'flag', strategy: 'template', gc: { ttl: '3d' }, maintenanceDatabase: 'm2' });
    expect(fromFlags.hooks.migrate).toBe('flag-migrate');
  });

  it('empty env vars are ignored', () => {
    const dir = dirWith({ prefix: 'app' });
    expect(loadConfig({ cwd: dir, env: { PGBRANCH_ADMIN_URL: ADMIN, PGBRANCH_PREFIX: '' } }).prefix).toBe('app');
  });

  it('loads a config given with --config and uses its directory as root', () => {
    const dir = dirWith();
    const sub = dirWith({ prefix: 'app' });
    writeFileSync(join(sub, 'custom.json'), JSON.stringify({ prefix: 'custom' }));
    const config = loadConfig({ cwd: dir, env: { PGBRANCH_ADMIN_URL: ADMIN }, overrides: { config: join(sub, 'custom.json') } });
    expect(config.prefix).toBe('custom');
    expect(config.rootDir).toBe(sub);
  });

  it('fails when an explicit config file is missing', () => {
    expect(() => loadConfig({ cwd: dirWith(), env: { PGBRANCH_ADMIN_URL: ADMIN }, overrides: { config: 'nope.json' } })).toThrow(
      /not found/,
    );
  });

  it.each([
    ['bad json', '{', /Cannot read config file/],
    ['unknown key', { prefix: 'app', extra: 1 }, /extra|Unrecognized/i],
    ['bad strategy', { prefix: 'app', strategy: 'copy' }, /strategy/],
    ['bad hook type', { prefix: 'app', hooks: { migrate: 1 } }, /hooks\.migrate/],
  ])('rejects %s', (_name, content, pattern) => {
    expect(() => loadConfig({ cwd: dirWith(content), env: { PGBRANCH_ADMIN_URL: ADMIN } })).toThrow(pattern);
  });

  it('requires a prefix', () => {
    expect(() => loadConfig({ cwd: dirWith({}), env: { PGBRANCH_ADMIN_URL: ADMIN } })).toThrow(/prefix/);
  });

  it('validates the prefix', () => {
    expect(() => loadConfig({ cwd: dirWith({ prefix: 'My-App' }), env: { PGBRANCH_ADMIN_URL: ADMIN } })).toThrow(ConfigError);
  });

  it('requires an admin URL for the pg driver', () => {
    expect(() => loadConfig({ cwd: dirWith({ prefix: 'app' }), env: {} })).toThrow(/PGBRANCH_ADMIN_URL/);
  });

  it('rejects a non-postgres admin URL', () => {
    expect(() => loadConfig({ cwd: dirWith({ prefix: 'app' }), env: { PGBRANCH_ADMIN_URL: 'mysql://x@y/z' } })).toThrow(
      /Invalid admin URL/,
    );
  });

  it('validates the gc ttl', () => {
    expect(() => loadConfig({ cwd: dirWith({ prefix: 'app', gc: { ttl: 'forever' } }), env: { PGBRANCH_ADMIN_URL: ADMIN } })).toThrow(
      /gc.ttl/,
    );
  });

  it('requires {database} in appUrl', () => {
    expect(() =>
      loadConfig({ cwd: dirWith({ prefix: 'app', appUrl: 'postgresql://u@h/db' }), env: { PGBRANCH_ADMIN_URL: ADMIN } }),
    ).toThrow(/\{database\}/);
  });

  describe('data-api driver', () => {
    const arns = {
      PGBRANCH_RESOURCE_ARN: 'arn:aws:rds:us-east-1:123:cluster:c',
      PGBRANCH_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123:secret:s',
    };

    it('needs ARNs, not an admin URL', () => {
      const dir = dirWith({ prefix: 'app', driver: 'data-api' });
      expect(() => loadConfig({ cwd: dir, env: {} })).toThrow(/resource ARN/);
      const config = loadConfig({ cwd: dir, env: arns });
      expect(config.dataApi).toEqual({ resourceArn: arns.PGBRANCH_RESOURCE_ARN, secretArn: arns.PGBRANCH_SECRET_ARN, region: undefined });
      expect(config.adminUrl).toBeUndefined();
    });

    it('reads ARNs from the file', () => {
      const dir = dirWith({ prefix: 'app', driver: 'data-api', dataApi: { resourceArn: 'r', secretArn: 's', region: 'eu-west-1' } });
      expect(loadConfig({ cwd: dir, env: {} }).dataApi).toEqual({ resourceArn: 'r', secretArn: 's', region: 'eu-west-1' });
    });

    it('rejects the dump strategy', () => {
      const dir = dirWith({ prefix: 'app', driver: 'data-api', strategy: 'dump' });
      expect(() => loadConfig({ cwd: dir, env: arns })).toThrow(/not supported/);
    });
  });
});
