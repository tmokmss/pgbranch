import { Command, CommanderError } from 'commander';
import { loadConfig, type ConfigOverrides } from './config.js';
import type { Logger } from './db-ops.js';
import { createDriver } from './driver/index.js';
import { formatTable, parseFormat, processIo, writeGithubOutputs, type Io, type OutputFormat } from './output.js';
import { PgBranch } from './pgbranch.js';
import { redactUrl } from './url.js';

export const VERSION = '0.1.0';

interface GlobalOptions extends Omit<ConfigOverrides, 'gcTtl'> {
  json?: boolean;
  format?: string;
  dryRun?: boolean;
}

interface Context {
  app: PgBranch;
  format: OutputFormat;
  io: Io;
}

function makeLogger(io: Io): Logger {
  return {
    info: (m) => io.stderr(`${m}\n`),
    warn: (m) => io.stderr(`warning: ${m}\n`),
  };
}

async function withApp(io: Io, cmd: Command, fn: (ctx: Context) => Promise<void>): Promise<void> {
  const opts = cmd.optsWithGlobals<GlobalOptions & { ttl?: string }>();
  const format = parseFormat(opts.format, opts.json);
  const overrides: ConfigOverrides = {
    config: opts.config,
    adminUrl: opts.adminUrl,
    prefix: opts.prefix,
    maintenanceDatabase: opts.maintenanceDatabase,
    strategy: opts.strategy,
    driver: opts.driver,
    migrateHook: opts.migrateHook,
    seedHook: opts.seedHook,
    appUrl: opts.appUrl,
    resourceArn: opts.resourceArn,
    secretArn: opts.secretArn,
    region: opts.region,
  };
  const config = loadConfig({ env: io.env, overrides });
  const log = makeLogger(io);
  const driver = createDriver(config);
  const app = new PgBranch({ config, driver, dryRun: opts.dryRun === true, log });
  try {
    await fn({ app, format, io });
  } finally {
    await driver.close();
  }
}

function printJson(io: Io, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function printBranch(ctx: Context, result: { database: string; url?: string; actions?: string[]; dryRun?: boolean }): void {
  if (ctx.format === 'json') {
    printJson(ctx.io, result);
    return;
  }
  if (ctx.format === 'github') {
    writeGithubOutputs(ctx.io, { database: result.database, url: result.url });
  }
  ctx.io.stdout(`${result.url ?? result.database}\n`);
}

export function buildProgram(io: Io = processIo): Command {
  const program = new Command();
  program
    .name('pgbranch')
    .description('Per-branch databases on an existing Postgres / Aurora PostgreSQL cluster')
    .version(VERSION)
    .option('-c, --config <path>', 'config file (default: pgbranch.json)')
    .option('--admin-url <url>', 'admin connection URL (env PGBRANCH_ADMIN_URL)')
    .option('--prefix <prefix>', 'name prefix of managed databases')
    .option('--maintenance-database <name>', 'database the admin connection uses (default: postgres)')
    .option('--strategy <strategy>', 'copy strategy: template or dump')
    .option('--driver <driver>', 'pg or data-api')
    .option('--app-url <url>', 'URL template for the app, with {database}')
    .option('--migrate-hook <command>', 'migrate hook command')
    .option('--seed-hook <command>', 'seed hook command')
    .option('--resource-arn <arn>', 'Aurora cluster ARN (data-api driver)')
    .option('--secret-arn <arn>', 'Secrets Manager secret ARN (data-api driver)')
    .option('--region <region>', 'AWS region (data-api driver)')
    .option('--json', 'print JSON (same as --format json)')
    .option('--format <format>', 'output format: text, json or github')
    .option('--dry-run', 'print the actions, change nothing')
    .showHelpAfterError()
    .configureOutput({
      writeOut: (s) => io.stdout(s),
      writeErr: (s) => io.stderr(s),
    })
    .exitOverride();

  const template = program.command('template').description('manage the template database');
  template
    .command('refresh')
    .description('build or update the template database')
    .action(async (_opts, cmd: Command) => {
      await withApp(io, cmd, async (ctx) => {
        const result = await ctx.app.templateRefresh();
        if (ctx.format === 'json') return printJson(io, result);
        if (ctx.format === 'github') writeGithubOutputs(io, { database: result.database });
        io.stdout(`${result.dryRun ? '[dry-run] ' : ''}Template ${result.database} is ready${result.fromEmpty ? ' (built from empty)' : ''}\n`);
      });
    });

  program
    .command('create')
    .description('create a branch database')
    .argument('<branch>', 'branch name')
    .option('--from <branch>', 'copy another branch database instead of the template')
    .option('--no-migrate', 'do not run the migrate hook')
    .option('--if-not-exists', 'do not fail if the database exists (the migrate hook still runs)')
    .action(async (branch: string, opts: { from?: string; migrate: boolean; ifNotExists?: boolean }, cmd: Command) => {
      await withApp(io, cmd, async (ctx) => {
        printBranch(ctx, await ctx.app.create(branch, opts));
      });
    });

  program
    .command('reset')
    .description('drop a branch database and create it again from the same source')
    .argument('<branch>', 'branch name')
    .option('--no-migrate', 'do not run the migrate hook')
    .action(async (branch: string, opts: { migrate: boolean }, cmd: Command) => {
      await withApp(io, cmd, async (ctx) => {
        printBranch(ctx, await ctx.app.reset(branch, opts));
      });
    });

  program
    .command('delete')
    .description('delete a branch database')
    .argument('<branch>', 'branch name')
    .option('--if-exists', 'do not fail if the database does not exist')
    .action(async (branch: string, opts: { ifExists?: boolean }, cmd: Command) => {
      await withApp(io, cmd, async (ctx) => {
        const result = await ctx.app.delete(branch, opts);
        if (ctx.format === 'json') return printJson(io, result);
        if (ctx.format === 'github') writeGithubOutputs(io, { database: result.database });
        const prefix = result.dryRun ? '[dry-run] ' : '';
        io.stdout(result.deleted ? `${prefix}Deleted ${result.database}\n` : `${result.database} does not exist\n`);
      });
    });

  program
    .command('list')
    .description('list branch databases')
    .action(async (_opts, cmd: Command) => {
      await withApp(io, cmd, async (ctx) => {
        const entries = await ctx.app.list();
        if (ctx.format === 'json') return printJson(io, entries);
        io.stdout(entries.length === 0 ? 'No branch databases\n' : formatTable(entries));
      });
    });

  program
    .command('url')
    .description('print the connection URL of a branch database')
    .argument('<branch>', 'branch name')
    .action(async (branch: string, _opts, cmd: Command) => {
      await withApp(io, cmd, async (ctx) => {
        const result = await ctx.app.url(branch);
        if (ctx.format !== 'json' && result.url === undefined) {
          throw new Error('No URL in Data API mode. Set "appUrl" in the config to print one');
        }
        printBranch(ctx, result);
      });
    });

  program
    .command('gc')
    .description('drop branch databases older than the TTL')
    .option('--ttl <duration>', 'age limit, e.g. 7d (default: gc.ttl in config, or 7d)')
    .option('--keep <branch...>', 'branches to keep')
    .action(async (opts: { ttl?: string; keep?: string[] }, cmd: Command) => {
      await withApp(io, cmd, async (ctx) => {
        const result = await ctx.app.gc({ ttl: opts.ttl, keep: opts.keep });
        if (ctx.format === 'json') return printJson(io, result);
        const prefix = result.dryRun ? '[dry-run] ' : '';
        for (const e of result.dropped) io.stdout(`${prefix}Dropped ${e.database} (${e.branch}, created ${e.createdAt})\n`);
        io.stdout(`${prefix}${result.dropped.length} dropped, ${result.kept.length} kept, ${result.skipped.length} skipped\n`);
      });
    });

  return program;
}

/** Run the CLI. Returns the exit code. */
export async function main(argv: string[], io: Io = processIo): Promise<number> {
  const program = buildProgram(io);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      return err.exitCode;
    }
    const message = err instanceof Error ? err.message : String(err);
    // Never print the admin password, even if a driver error contains the URL.
    const adminUrl = io.env.PGBRANCH_ADMIN_URL;
    const safe = adminUrl ? message.split(adminUrl).join(redactUrl(adminUrl)) : message;
    io.stderr(`pgbranch: error: ${safe}\n`);
    return 1;
  }
}
