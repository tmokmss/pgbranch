import type { ResolvedConfig } from './config.js';
import { DbOps, type Logger, silentLogger } from './db-ops.js';
import type { Driver } from './driver/types.js';
import { parseDuration } from './duration.js';
import { checkDumpTools, dumpDatabase, restoreDatabase, type DumpFile } from './dump.js';
import { hookEnv, runHook, type HookRunner } from './hooks.js';
import {
  branchSource,
  buildMetadata,
  parseMetadata,
  parseSource,
  TEMPLATE_SOURCE,
  type BranchMetadata,
} from './metadata.js';
import {
  branchDbName,
  branchDbPrefix,
  templateName,
  templateNextName,
  templateOldName,
} from './names.js';
import { fillUrlTemplate, withDatabase } from './url.js';

export interface PgBranchOptions {
  config: ResolvedConfig;
  driver: Driver;
  dryRun?: boolean;
  log?: Logger;
  /** For tests. Defaults to running the command in a shell. */
  hookRunner?: HookRunner;
  /** How long to wait for a lock before giving up. Default 30 minutes. */
  lockTimeoutMs?: number;
  /** For tests. */
  now?: () => Date;
}

export interface CreateOptions {
  /** Copy this branch DB instead of the template. */
  from?: string;
  /** Skip the migrate hook. */
  migrate?: boolean;
  /** Do not fail if the DB exists. The migrate hook still runs on it. */
  ifNotExists?: boolean;
}

export interface BranchResult {
  branch: string;
  database: string;
  url?: string;
  source: string;
  created: boolean;
  migrated: boolean;
  dryRun: boolean;
  actions: string[];
}

export interface DeleteResult {
  branch: string;
  database: string;
  deleted: boolean;
  dryRun: boolean;
  actions: string[];
}

export interface ListEntry {
  branch: string | null;
  database: string;
  createdAt: string | null;
  source: string | null;
  sizeBytes: number | null;
}

export interface GcResult {
  ttl: string;
  dropped: ListEntry[];
  kept: ListEntry[];
  skipped: ListEntry[];
  dryRun: boolean;
  actions: string[];
}

export interface TemplateRefreshResult {
  database: string;
  fromEmpty: boolean;
  migrated: boolean;
  seeded: boolean;
  dryRun: boolean;
  actions: string[];
}

export class PgBranchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PgBranchError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PgBranch {
  readonly config: ResolvedConfig;
  readonly ops: DbOps;
  private readonly log: Logger;
  private readonly hookRunner: HookRunner;
  private readonly lockTimeoutMs: number;
  private readonly now: () => Date;

  constructor(options: PgBranchOptions) {
    this.config = options.config;
    this.log = options.log ?? silentLogger;
    this.ops = new DbOps(options.driver, options.config.prefix, options.dryRun ?? false, this.log);
    this.hookRunner = options.hookRunner ?? runHook;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 30 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
  }

  get dryRun(): boolean {
    return this.ops.dryRun;
  }

  private get driver(): Driver {
    return this.ops.driver;
  }

  // ---------------------------------------------------------------- locks

  private lockKey(scope?: string): string {
    return scope ? `pgbranch:${this.config.prefix}:${scope}` : `pgbranch:${this.config.prefix}`;
  }

  /**
   * Run `fn` while holding an advisory lock. The main lock (no scope) only
   * covers create / rename / drop. Scoped locks (one branch, or template
   * refresh) cover a whole command, hooks included.
   * Lock order is always: scoped lock first, then the main lock.
   */
  private async withLock<T>(fn: () => Promise<T>, scope?: string): Promise<T> {
    if (this.dryRun) return fn();
    const key = this.lockKey(scope);
    const deadline = Date.now() + this.lockTimeoutMs;
    let warned = false;
    while (!(await this.driver.tryLock(key))) {
      if (Date.now() > deadline) {
        throw new PgBranchError(`Timed out waiting for lock ${key}`);
      }
      if (!warned) {
        this.log.info(`Waiting for lock ${key} (another pgbranch command is running)...`);
        warned = true;
      }
      await sleep(500);
    }
    try {
      return await fn();
    } finally {
      await this.driver.unlock(key);
    }
  }

  // ---------------------------------------------------------------- helpers

  /** Connection URL for the app. undefined in Data API mode without appUrl. */
  urlFor(database: string): string | undefined {
    if (this.config.appUrl) return fillUrlTemplate(this.config.appUrl, database);
    if (this.config.adminUrl) return withDatabase(this.config.adminUrl, database);
    return undefined;
  }

  private async runHook(name: 'migrate' | 'seed', database: string, branch: string | undefined): Promise<boolean> {
    const command = this.config.hooks[name];
    if (!command) return false;
    this.ops.note(`run ${name} hook on ${database}: ${command}`);
    if (this.dryRun) return true;
    this.log.info(`Running ${name} hook on ${database}: ${command}`);
    await this.hookRunner(name, command, hookEnv(this.config, database, branch), this.config.rootDir);
    return true;
  }

  private async prepareStrategy(): Promise<void> {
    if (this.config.strategy === 'dump') {
      if (!this.config.adminUrl) {
        throw new PgBranchError('Strategy "dump" needs a direct connection (driver "pg")');
      }
      await checkDumpTools();
    }
  }

  /**
   * Copy `source` into a new database `target`. Call inside the main lock.
   * For the dump strategy this returns a dump file that must be restored
   * (outside the lock) with `finishCopy`.
   */
  private async startCopy(source: string, target: string, sourceIsBranch: boolean): Promise<DumpFile | undefined> {
    if (this.config.strategy === 'template') {
      if (sourceIsBranch) {
        this.log.warn(`Copying from ${source}: active connections to it will be terminated`);
        await this.ops.terminate(source);
      }
      await this.ops.create(target, { source, retries: sourceIsBranch ? 3 : 0 });
      return undefined;
    }
    // dump strategy
    await this.ops.create(target, { baseTemplate: 'template0' });
    this.ops.note(`pg_dump ${source}`);
    if (this.dryRun) return undefined;
    const info = await this.ops.get(source);
    const reopen = info !== undefined && !info.allowConnections;
    if (reopen) await this.ops.setAllowConnections(source, true);
    try {
      return await dumpDatabase(this.config.adminUrl!, source);
    } finally {
      if (reopen) await this.ops.setAllowConnections(source, false);
    }
  }

  private async finishCopy(file: DumpFile | undefined, target: string): Promise<void> {
    if (this.config.strategy !== 'dump') return;
    this.ops.note(`pg_restore into ${target}`);
    if (!file) return;
    try {
      await restoreDatabase(this.config.adminUrl!, target, file);
    } finally {
      await file.cleanup();
    }
  }

  private async dropAfterFailure(database: string): Promise<void> {
    try {
      await this.withLock(() => this.ops.drop(database));
    } catch (err) {
      this.log.warn(`Could not drop ${database} after failure: ${(err as Error).message}`);
    }
  }

  private checkOwner(database: string, comment: string | null, branch: string): BranchMetadata | undefined {
    const meta = parseMetadata(comment);
    if (meta && meta.branch !== branch) {
      throw new PgBranchError(
        `Database ${database} belongs to branch "${meta.branch}", not "${branch}" (names collide after sanitizing)`,
      );
    }
    return meta;
  }

  // ---------------------------------------------------------------- commands

  async create(branch: string, options: CreateOptions = {}): Promise<BranchResult> {
    const database = branchDbName(this.config.prefix, branch);
    return this.withLock(() => this.createLocked(branch, database, options), `branch:${database}`);
  }

  private async createLocked(branch: string, database: string, options: CreateOptions): Promise<BranchResult> {
    const source = options.from !== undefined ? branchSource(options.from) : TEMPLATE_SOURCE;
    const sourceDb = options.from !== undefined ? branchDbName(this.config.prefix, options.from) : templateName(this.config.prefix);
    if (sourceDb === database) {
      throw new PgBranchError('A branch cannot be created from itself');
    }
    const doMigrate = options.migrate !== false;
    await this.prepareStrategy();

    let existed = false;
    let dump: DumpFile | undefined;
    await this.withLock(async () => {
      const current = await this.ops.get(database);
      if (current) {
        this.checkOwner(database, current.comment, branch);
        if (!options.ifNotExists) {
          throw new PgBranchError(`Database ${database} already exists (use --if-not-exists or reset)`);
        }
        existed = true;
        return;
      }
      if (!(await this.ops.exists(sourceDb))) {
        throw new PgBranchError(
          options.from !== undefined
            ? `Source branch "${options.from}" has no database (${sourceDb})`
            : `Template database ${sourceDb} does not exist. Run "pgbranch template refresh" first`,
        );
      }
      dump = await this.startCopy(sourceDb, database, options.from !== undefined);
      await this.ops.setComment(database, buildMetadata(branch, source, this.now()));
    });

    let migrated = false;
    if (existed) {
      this.log.info(`Database ${database} already exists`);
      // Apply new migrations of this branch. Never drop an existing DB on failure.
      if (doMigrate) migrated = await this.runHook('migrate', database, branch);
    } else {
      try {
        await this.finishCopy(dump, database);
        if (doMigrate) migrated = await this.runHook('migrate', database, branch);
      } catch (err) {
        if (!this.dryRun) {
          this.log.warn(`Dropping ${database} because setup failed`);
          await this.dropAfterFailure(database);
        }
        throw err;
      }
    }

    return {
      branch,
      database,
      url: this.urlFor(database),
      source,
      created: !existed,
      migrated,
      dryRun: this.dryRun,
      actions: this.ops.actions,
    };
  }

  async reset(branch: string, options: { migrate?: boolean } = {}): Promise<BranchResult> {
    const database = branchDbName(this.config.prefix, branch);
    return this.withLock(async () => {
      const current = await this.ops.get(database);
      if (!current) {
        throw new PgBranchError(`Database ${database} does not exist (use create)`);
      }
      const meta = this.checkOwner(database, current.comment, branch);
      const source = parseSource(meta?.source ?? TEMPLATE_SOURCE);
      const from = source.kind === 'branch' ? source.branch : undefined;
      const sourceDb = from !== undefined ? branchDbName(this.config.prefix, from) : templateName(this.config.prefix);
      if (!(await this.ops.exists(sourceDb))) {
        throw new PgBranchError(`Source database ${sourceDb} does not exist, so ${database} was not reset`);
      }
      await this.prepareStrategy();
      await this.withLock(() => this.ops.drop(database));
      return this.createLocked(branch, database, { from, migrate: options.migrate });
    }, `branch:${database}`);
  }

  async delete(branch: string, options: { ifExists?: boolean } = {}): Promise<DeleteResult> {
    const database = branchDbName(this.config.prefix, branch);
    return this.withLock(
      () =>
        this.withLock(async () => {
          const current = await this.ops.get(database);
          if (!current) {
            if (!options.ifExists) {
              throw new PgBranchError(`Database ${database} does not exist`);
            }
            return { branch, database, deleted: false, dryRun: this.dryRun, actions: this.ops.actions };
          }
          this.checkOwner(database, current.comment, branch);
          await this.ops.drop(database);
          return { branch, database, deleted: true, dryRun: this.dryRun, actions: this.ops.actions };
        }),
      `branch:${database}`,
    );
  }

  async list(): Promise<ListEntry[]> {
    const rows = await this.ops.listByPrefix(branchDbPrefix(this.config.prefix));
    return rows.map((row) => {
      const meta = parseMetadata(row.comment);
      return {
        branch: meta?.branch ?? null,
        database: row.name,
        createdAt: meta?.createdAt ?? null,
        source: meta?.source ?? null,
        sizeBytes: row.sizeBytes,
      };
    });
  }

  async url(branch: string): Promise<{ branch: string; database: string; url?: string }> {
    const database = branchDbName(this.config.prefix, branch);
    const current = await this.ops.get(database);
    if (!current) {
      throw new PgBranchError(`Database ${database} does not exist`);
    }
    this.checkOwner(database, current.comment, branch);
    return { branch, database, url: this.urlFor(database) };
  }

  async gc(options: { ttl?: string; keep?: string[] } = {}): Promise<GcResult> {
    const ttl = options.ttl ?? this.config.gc.ttl;
    const ttlMs = parseDuration(ttl);
    const keepBranches = new Set(options.keep ?? []);
    const keepDbs = new Set([...keepBranches].map((b) => branchDbName(this.config.prefix, b)));
    const cutoff = this.now().getTime() - ttlMs;

    return this.withLock(async () => {
      const entries = await this.list();
      const result: GcResult = { ttl, dropped: [], kept: [], skipped: [], dryRun: this.dryRun, actions: this.ops.actions };
      for (const entry of entries) {
        if (entry.createdAt === null) {
          this.log.warn(`Skipping ${entry.database}: no pgbranch metadata`);
          result.skipped.push(entry);
          continue;
        }
        const kept = keepDbs.has(entry.database) || (entry.branch !== null && keepBranches.has(entry.branch));
        if (kept || Date.parse(entry.createdAt) > cutoff) {
          result.kept.push(entry);
          continue;
        }
        await this.ops.drop(entry.database);
        result.dropped.push(entry);
      }
      return result;
    });
  }

  async templateRefresh(): Promise<TemplateRefreshResult> {
    const tmpl = templateName(this.config.prefix);
    const next = templateNextName(this.config.prefix);
    const old = templateOldName(this.config.prefix);

    return this.withLock(async () => {
      await this.prepareStrategy();

      // 1. Build _next from the current template, or empty.
      let fromEmpty = false;
      let dump: DumpFile | undefined;
      await this.withLock(async () => {
        // Clean up after a run that crashed half way.
        if (!(await this.ops.exists(tmpl)) && (await this.ops.exists(old))) {
          this.log.warn(`Found ${old} without ${tmpl}: restoring it from an earlier failed swap`);
          await this.ops.rename(old, tmpl);
          await this.ops.setTemplate(tmpl, true);
        }
        if (await this.ops.drop(next)) this.log.warn(`Dropped leftover ${next}`);
        if (await this.ops.drop(old)) this.log.warn(`Dropped leftover ${old}`);

        if (await this.ops.exists(tmpl)) {
          dump = await this.startCopy(tmpl, next, false);
        } else {
          fromEmpty = true;
          await this.ops.create(next);
        }
      });

      // 2. Run hooks on _next. 3. On failure drop _next and keep the old template.
      let migrated = false;
      let seeded = false;
      try {
        await this.finishCopy(dump, next);
        migrated = await this.runHook('migrate', next, undefined);
        if (fromEmpty) seeded = await this.runHook('seed', next, undefined);
      } catch (err) {
        if (!this.dryRun) {
          this.log.warn(`Template refresh failed, dropping ${next} and keeping the current template`);
          await this.dropAfterFailure(next);
        }
        throw err;
      }

      // 4. Swap.
      await this.withLock(async () => {
        // Lock the new one first, so nobody connects between the renames.
        await this.ops.setTemplate(next, true);
        const hasOld = await this.ops.exists(tmpl);
        if (hasOld) await this.ops.rename(tmpl, old);
        await this.ops.rename(next, tmpl);
        if (hasOld) await this.ops.drop(old);
      });

      return { database: tmpl, fromEmpty, migrated, seeded, dryRun: this.dryRun, actions: this.ops.actions };
    }, 'template');
  }
}
