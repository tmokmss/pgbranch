// The GitHub Action (action.yml). Reads the inputs and runs the CLI with
// `--format github`, so `database` and `url` become step outputs.
// The entry point is action-main.ts.
import { main } from './main.js';

const BRANCH_COMMANDS = new Set(['create', 'reset', 'delete', 'url']);

function input(name: string): string {
  return (process.env[`INPUT_${name.toUpperCase()}`] ?? '').trim();
}

function mask(value: string): void {
  if (value) process.stdout.write(`::add-mask::${value}\n`);
}

export function buildArgs(env: NodeJS.ProcessEnv): string[] {
  const read = (name: string) => (env[`INPUT_${name.toUpperCase()}`] ?? '').trim();
  const command = read('command').split(/\s+/).filter(Boolean);
  if (command.length === 0) {
    throw new Error('Input "command" is required (e.g. "create", "delete --if-exists", "gc", "template refresh")');
  }
  const args: string[] = [];
  const config = read('config');
  if (config) args.push('--config', config);
  args.push('--format', 'github', ...command);
  if (BRANCH_COMMANDS.has(command[0])) {
    // Default: the PR head branch, or the pushed branch.
    const branch = read('branch') || env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || '';
    if (!branch) throw new Error(`Input "branch" is required for "${command[0]}"`);
    args.push(branch);
  } else if (read('branch')) {
    throw new Error(`Input "branch" is not used by "${command[0]}"`);
  }
  return args;
}

export async function run(): Promise<number> {
  const adminUrl = input('admin-url');
  if (adminUrl) {
    mask(adminUrl);
    try {
      mask(decodeURIComponent(new URL(adminUrl).password));
    } catch {
      // Not a URL; the CLI will report it.
    }
    process.env.PGBRANCH_ADMIN_URL = adminUrl;
  }
  let args: string[];
  try {
    args = buildArgs(process.env);
  } catch (err) {
    process.stdout.write(`::error::${(err as Error).message}\n`);
    return 1;
  }
  return main(args);
}
