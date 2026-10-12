import { spawn } from 'node:child_process';
import type { Logger } from './db-ops.js';
import { connection, dumpSchema, restoreList, schemaEntries, tocEntries } from './dump.js';
import type { Driver } from './driver/types.js';
import { quoteIdent } from './sql.js';

/** Per-table data rule: `false` copies no rows, a string is a WHERE condition. */
export type DataRules = Record<string, false | string>;

interface Table {
  /** `schema.table`, not quoted. Used as the key in `DataRules`. */
  key: string;
  sql: string;
  columns: string;
}

interface ForeignKey {
  child: string;
  parent: string;
  childColumns: string[];
  parentColumns: string[];
}

export interface CopyResult {
  tables: number;
  pruned: Record<string, number>;
}

/** Opens a connection to one database of the cluster. */
export type ConnectTo = (database: string) => Driver;

const PARALLEL_TABLES = 4;

async function listTables(source: Driver): Promise<Table[]> {
  const rows = await source.query<{ schema: string; name: string; columns: string }>(
    `select n.nspname as schema, c.relname as name,
            (select string_agg(quote_ident(a.attname), ', ' order by a.attnum)
               from pg_attribute a
              where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and a.attgenerated = '') as columns
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r'
        and n.nspname <> 'information_schema' and n.nspname not like 'pg\\_%'
        and not exists (select 1 from pg_depend d
                         where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
      order by pg_total_relation_size(c.oid) desc`,
  );
  return rows
    .filter((r) => r.columns !== null)
    .map((r) => ({ key: `${r.schema}.${r.name}`, sql: `${quoteIdent(r.schema)}.${quoteIdent(r.name)}`, columns: r.columns }));
}

async function listForeignKeys(source: Driver): Promise<ForeignKey[]> {
  const rows = await source.query<{ child: string; parent: string; child_columns: string[]; parent_columns: string[] }>(
    `select cn.nspname || '.' || c.relname as child,
            pn.nspname || '.' || p.relname as parent,
            array(select quote_ident(a.attname) from unnest(con.conkey) with ordinality k(attnum, i)
                    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum order by k.i) as child_columns,
            array(select quote_ident(a.attname) from unnest(con.confkey) with ordinality k(attnum, i)
                    join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum order by k.i) as parent_columns
       from pg_constraint con
       join pg_class c on c.oid = con.conrelid join pg_namespace cn on cn.oid = c.relnamespace
       join pg_class p on p.oid = con.confrelid join pg_namespace pn on pn.oid = p.relnamespace
      where con.contype = 'f' and c.relkind = 'r' and p.relkind = 'r'`,
  );
  return rows.map((r) => ({ child: r.child, parent: r.parent, childColumns: r.child_columns, parentColumns: r.parent_columns }));
}

/** Pipe `COPY ... TO STDOUT` on the source into `COPY ... FROM STDIN` on the target, with psql. */
function pipeCopy(adminUrl: string, source: string, target: string, from: string, to: string): Promise<void> {
  const psql = (database: string, copy: string) => {
    const { dbname, env } = connection(adminUrl, database);
    return spawn('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', `--dbname=${dbname}`, '-c', 'SET row_security = off', '-c', copy], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  };
  const reader = psql(source, from);
  const writer = psql(target, to);
  reader.stdout.pipe(writer.stdin);
  writer.stdin.on('error', () => {});
  const wait = (child: ReturnType<typeof psql>, name: string) =>
    new Promise<void>((resolve, reject) => {
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${name} failed with exit code ${code}${stderr ? `:\n${stderr.trim()}` : ''}`));
      });
    });
  return Promise.all([wait(reader, `copy out of ${source}`), wait(writer, `copy into ${target}`)]).then(() => undefined);
}

async function copyTables(adminUrl: string, source: string, target: string, tables: Table[], rules: DataRules, log: Logger): Promise<void> {
  const queue = tables.filter((t) => rules[t.key] !== false);
  const worker = async () => {
    for (let table = queue.shift(); table; table = queue.shift()) {
      const rule = rules[table.key];
      const select =
        typeof rule === 'string'
          ? `COPY (SELECT ${table.columns} FROM ${table.sql} WHERE ${rule}) TO STDOUT (FORMAT binary)`
          : `COPY ${table.sql} (${table.columns}) TO STDOUT (FORMAT binary)`;
      log.info(`Copying ${table.key}${typeof rule === 'string' ? ` where ${rule}` : ''}`);
      await pipeCopy(adminUrl, source, target, select, `COPY ${table.sql} (${table.columns}) FROM STDIN (FORMAT binary)`);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL_TABLES }, worker));
}

async function copySequences(source: Driver, target: Driver): Promise<void> {
  const rows = await source.query<{ sql: string }>(
    `select format('select setval(%L, %s, %s)', quote_ident(schemaname) || '.' || quote_ident(sequencename), last_value, 'true') as sql
       from pg_sequences
      where last_value is not null and schemaname <> 'information_schema' and schemaname not like 'pg\\_%'`,
  );
  for (const { sql } of rows) await target.query(sql);
}

const quoteKey = (key: string) => {
  const dot = key.indexOf('.');
  return `${quoteIdent(key.slice(0, dot))}.${quoteIdent(key.slice(dot + 1))}`;
};

/**
 * Delete rows whose parent row was not copied, until no foreign key has a missing parent.
 * Only foreign keys whose parent table lost rows are checked.
 */
async function pruneOrphans(target: Driver, foreignKeys: ForeignKey[], filtered: string[], log: Logger): Promise<Record<string, number>> {
  const pruned: Record<string, number> = {};
  const byParent = new Map<string, ForeignKey[]>();
  for (const fk of foreignKeys) byParent.set(fk.parent, [...(byParent.get(fk.parent) ?? []), fk]);
  const work = filtered.flatMap((t) => byParent.get(t) ?? []);
  await target.query('SET row_security = off');
  for (let fk = work.shift(); fk; fk = work.shift()) {
    const notNull = fk.childColumns.map((c) => `c.${c} IS NOT NULL`).join(' AND ');
    const match = fk.childColumns.map((c, i) => `p.${fk.parentColumns[i]} = c.${c}`).join(' AND ');
    const rows = await target.query<{ n: number }>(
      `WITH d AS (DELETE FROM ${quoteKey(fk.child)} c WHERE ${notNull}
                    AND NOT EXISTS (SELECT 1 FROM ${quoteKey(fk.parent)} p WHERE ${match}) RETURNING 1)
       SELECT count(*)::int AS n FROM d`,
    );
    const n = rows[0]?.n ?? 0;
    if (n > 0) {
      pruned[fk.child] = (pruned[fk.child] ?? 0) + n;
      work.push(...(byParent.get(fk.child) ?? []));
    }
  }
  for (const [table, n] of Object.entries(pruned)) log.info(`Deleted ${n} rows of ${table} whose parent row was not copied`);
  return pruned;
}

/**
 * Copy the live database `source` into the empty database `target`. `source` is only read.
 * Tables are created without indexes and constraints, filled with COPY (filtered by `rules`),
 * cleaned of rows whose parent was not copied, and then get their indexes and constraints.
 */
export async function copyDatabase(options: {
  adminUrl: string;
  source: string;
  target: string;
  rules: DataRules;
  connectTo: ConnectTo;
  log: Logger;
}): Promise<CopyResult> {
  const { adminUrl, source, target, rules, connectTo, log } = options;
  const src = connectTo(source);
  const dst = connectTo(target);
  const file = await dumpSchema(adminUrl, source);
  try {
    await src.query('SET row_security = off');
    const tables = await listTables(src);
    const unknown = Object.keys(rules).filter((key) => !tables.some((t) => t.key === key));
    if (unknown.length > 0) throw new Error(`"data" has tables that ${source} does not have: ${unknown.join(', ')}`);
    const foreignKeys = await listForeignKeys(src);

    const all = await tocEntries(file, []);
    const pre = new Set(await tocEntries(file, ['--section=pre-data']));
    const post = new Set(await tocEntries(file, ['--section=post-data']));
    const schemas = schemaEntries(all);
    await restoreList(adminUrl, target, file, 'schemas', schemas);
    await restoreList(adminUrl, target, file, 'pre-data', all.filter((e) => pre.has(e) && !schemas.includes(e)));

    await copyTables(adminUrl, source, target, tables, rules, log);
    await copySequences(src, dst);
    const pruned = await pruneOrphans(dst, foreignKeys, Object.keys(rules), log);

    await restoreList(adminUrl, target, file, 'post-data', all.filter((e) => post.has(e)));
    await restoreList(adminUrl, target, file, 'rest', all.filter((e) => !pre.has(e) && !post.has(e) && !schemas.includes(e)));
    return { tables: tables.length, pruned };
  } finally {
    await file.cleanup();
    await src.close();
    await dst.close();
  }
}
