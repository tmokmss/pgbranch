import { describe, expect, it } from 'vitest';
import { buildArgs } from '../../src/action.js';

describe('action buildArgs', () => {
  it('passes the command, config and branch', () => {
    expect(buildArgs({ INPUT_COMMAND: 'create --if-not-exists', INPUT_BRANCH: 'feature/x', INPUT_CONFIG: 'db/pgbranch.json' })).toEqual([
      '--config',
      'db/pgbranch.json',
      '--format',
      'github',
      'create',
      '--if-not-exists',
      'feature/x',
    ]);
  });

  it('uses the PR head branch, then the pushed branch', () => {
    expect(buildArgs({ INPUT_COMMAND: 'delete', GITHUB_HEAD_REF: 'pr-branch', GITHUB_REF_NAME: '12/merge' }).at(-1)).toBe('pr-branch');
    expect(buildArgs({ INPUT_COMMAND: 'url', GITHUB_HEAD_REF: '', GITHUB_REF_NAME: 'main' }).at(-1)).toBe('main');
  });

  it('does not add a branch to commands without one', () => {
    expect(buildArgs({ INPUT_COMMAND: ' template   refresh ', GITHUB_HEAD_REF: 'x' })).toEqual(['--format', 'github', 'template', 'refresh']);
    expect(buildArgs({ INPUT_COMMAND: 'gc --ttl 3d' })).toEqual(['--format', 'github', 'gc', '--ttl', '3d']);
  });

  it('rejects missing or unused inputs', () => {
    expect(() => buildArgs({})).toThrow(/"command" is required/);
    expect(() => buildArgs({ INPUT_COMMAND: 'create' })).toThrow(/"branch" is required/);
    expect(() => buildArgs({ INPUT_COMMAND: 'list', INPUT_BRANCH: 'x' })).toThrow(/not used/);
  });
});
