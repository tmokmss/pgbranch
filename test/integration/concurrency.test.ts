import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  databases,
  dropAllWithPrefix,
  enabled,
  ensureRole,
  makeApp,
  makeConfig,
  sqlHook,
  uniquePrefix,
  withApp,
} from './helpers.js';

describe.skipIf(!enabled)('concurrency', () => {
  const prefix = uniquePrefix('conc');
  const config = makeConfig(prefix, {
    hooks: { migrate: sqlHook('create table if not exists items (id int)', 'select pg_sleep(0.3)') },
  });

  beforeAll(async () => {
    await ensureRole();
    await withApp(config, (app) => app.templateRefresh());
  });
  afterAll(() => dropAllWithPrefix(prefix));

  /** Run each function with its own connection (own session, own locks). */
  async function inParallel<T>(fns: ((app: ReturnType<typeof makeApp>['app']) => Promise<T>)[]): Promise<PromiseSettledResult<T>[]> {
    const apps = fns.map(() => makeApp(config));
    try {
      return await Promise.allSettled(fns.map((fn, i) => fn(apps[i].app)));
    } finally {
      await Promise.all(apps.map((a) => a.close()));
    }
  }

  it('two creates of different branches both succeed', async () => {
    const results = await inParallel([(app) => app.create('para-a'), (app) => app.create('para-b')]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await databases(prefix)).toEqual([`${prefix}_br_para_a`, `${prefix}_br_para_b`, `${prefix}_template`]);
  });

  it('two creates of the same branch: one creates, the other sees it', async () => {
    const results = await inParallel([
      (app) => app.create('same', { ifNotExists: true }),
      (app) => app.create('same', { ifNotExists: true }),
    ]);
    const values = results.map((r) => (r.status === 'fulfilled' ? r.value.created : r.reason));
    expect(values.sort()).toEqual([false, true]);
  });

  it('two creates of the same branch without --if-not-exists: one fails cleanly', async () => {
    const results = await inParallel([(app) => app.create('race'), (app) => app.create('race')]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/already exists/);
    expect(await databases(prefix)).toContain(`${prefix}_br_race`);
  });

  it('gc skips a branch that another command is using', async () => {
    const later = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await withApp(config, (app) => app.create('busy'));
    const slow = makeConfig(prefix, { hooks: { migrate: sqlHook('select pg_sleep(1.5)') } });
    const busy = makeApp(slow);
    const gc = makeApp(config, { now: later });
    try {
      const migrating = busy.app.create('busy', { ifNotExists: true });
      await new Promise((r) => setTimeout(r, 700));
      const result = await gc.app.gc();
      expect(result.skipped.map((e) => e.branch)).toContain('busy');
      expect(result.dropped.map((e) => e.branch)).not.toContain('busy');
      await migrating;
    } finally {
      await busy.close();
      await gc.close();
    }
    expect(await databases(prefix)).toContain(`${prefix}_br_busy`);
  });

  it('create runs while a template refresh is running', async () => {
    const results = await inParallel<unknown>([(app) => app.templateRefresh(), (app) => app.create('during-refresh')]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
  });
});
