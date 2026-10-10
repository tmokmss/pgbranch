import { appendFileSync } from 'node:fs';
import { urlHasPassword } from './url.js';
import type { ListEntry } from './pgbranch.js';

export type OutputFormat = 'text' | 'json' | 'github';

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  env: NodeJS.ProcessEnv;
}

export const processIo: Io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
};

export function parseFormat(value: string | undefined, json: boolean | undefined): OutputFormat {
  if (json) return 'json';
  const format = value ?? 'text';
  if (format !== 'text' && format !== 'json' && format !== 'github') {
    throw new Error(`Invalid --format "${format}": use text, json or github`);
  }
  return format;
}

/**
 * Write step outputs to $GITHUB_OUTPUT. Prints `::add-mask::` first for any
 * URL with a password, so it is hidden in the logs.
 */
export function writeGithubOutputs(io: Io, outputs: Record<string, string | undefined>): void {
  const file = io.env.GITHUB_OUTPUT;
  if (!file) {
    throw new Error('--format github needs the GITHUB_OUTPUT env var (run it inside GitHub Actions)');
  }
  let content = '';
  for (const [key, value] of Object.entries(outputs)) {
    if (value === undefined) continue;
    if (urlHasPassword(value)) {
      io.stdout(`::add-mask::${value}\n`);
    }
    if (value.includes('\n')) {
      const delimiter = `pgbranch_${Math.random().toString(36).slice(2)}`;
      content += `${key}<<${delimiter}\n${value}\n${delimiter}\n`;
    } else {
      content += `${key}=${value}\n`;
    }
  }
  if (content) appendFileSync(file, content);
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return '-';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

export function formatTable(entries: ListEntry[]): string {
  const header = ['BRANCH', 'DATABASE', 'CREATED', 'SIZE'];
  const rows = entries.map((e) => [e.branch ?? '?', e.database, e.createdAt ?? '-', formatSize(e.sizeBytes)]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cols: string[]) =>
    cols
      .map((c, i) => (i === cols.length - 1 ? c : c.padEnd(widths[i])))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)].join('\n') + '\n';
}
