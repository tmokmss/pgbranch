import { describe, expect, it } from 'vitest';
import {
  assertManaged,
  branchDbName,
  isManaged,
  MAX_IDENTIFIER_BYTES,
  maxPrefixLength,
  sanitizeBranchName,
  SafetyError,
  templateName,
  templateNextName,
  validatePrefix,
} from '../../src/names.js';

describe('sanitizeBranchName', () => {
  it.each([
    ['main', 'main'],
    ['feature/Foo-Bar', 'feature_foo_bar'],
    ['feature//foo--bar', 'feature_foo_bar'],
    ['  spaces here  ', 'spaces_here'],
    ['dependabot/npm_and_yarn/pg-8.11.0', 'dependabot_npm_and_yarn_pg_8_11_0'],
    ['__x__', 'x'],
    ['UPPER', 'upper'],
    ['日本語', ''],
    ['feat/日本語-1', 'feat_1'],
  ])('%s -> %s', (input, expected) => {
    expect(sanitizeBranchName(input)).toBe(expected);
  });
});

describe('branchDbName', () => {
  it('builds <prefix>_br_<name>', () => {
    expect(branchDbName('app', 'feature/foo')).toBe('app_br_feature_foo');
  });

  it('uses a hash when nothing is left after sanitizing', () => {
    const name = branchDbName('app', '日本語');
    expect(name).toMatch(/^app_br_[0-9a-f]{8}$/);
    expect(branchDbName('app', '日本語')).toBe(name);
    expect(branchDbName('app', '中文')).not.toBe(name);
  });

  it('keeps names that fit in 63 bytes', () => {
    const branch = 'a'.repeat(MAX_IDENTIFIER_BYTES - 'app_br_'.length);
    expect(branchDbName('app', branch)).toBe(`app_br_${branch}`);
  });

  it('truncates long names and adds a hash', () => {
    const branch = `feature/${'x'.repeat(100)}`;
    const name = branchDbName('app', branch);
    expect(name.length).toBe(MAX_IDENTIFIER_BYTES);
    expect(name).toMatch(/^app_br_feature_x+_[0-9a-f]{8}$/);
  });

  it('gives different names to long branches with the same start', () => {
    const base = `feature/${'y'.repeat(80)}`;
    const a = branchDbName('app', `${base}-one`);
    const b = branchDbName('app', `${base}-two`);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(MAX_IDENTIFIER_BYTES);
    expect(b.length).toBeLessThanOrEqual(MAX_IDENTIFIER_BYTES);
  });

  it('does not leave a double underscore before the hash', () => {
    const branch = `${'a'.repeat(54)}_${'b'.repeat(20)}`;
    const name = branchDbName('app', branch);
    expect(name).not.toContain('__');
  });

  it('works with the longest prefix', () => {
    const prefix = `p${'x'.repeat(maxPrefixLength() - 1)}`;
    const name = branchDbName(prefix, 'some/very/long/branch/name/that/does/not/fit');
    expect(name.length).toBeLessThanOrEqual(MAX_IDENTIFIER_BYTES);
    expect(templateNextName(prefix).length).toBeLessThanOrEqual(MAX_IDENTIFIER_BYTES);
    expect(isManaged(prefix, name)).toBe(true);
  });

  it('rejects an empty branch', () => {
    expect(() => branchDbName('app', '')).toThrow(/empty/);
  });
});

describe('validatePrefix', () => {
  it.each(['app', 'my_app2', 'a'])('accepts %s', (p) => {
    expect(() => validatePrefix(p)).not.toThrow();
  });

  it.each(['', 'App', '1app', 'my-app', 'app"', 'x'.repeat(maxPrefixLength() + 1)])('rejects %s', (p) => {
    expect(() => validatePrefix(p)).toThrow();
  });
});

describe('assertManaged (safety rule)', () => {
  it.each(['app_template', 'app_template_next', 'app_br_feature', 'app_x'])('allows %s', (db) => {
    expect(() => assertManaged('app', db)).not.toThrow();
  });

  it.each([
    'postgres',
    'template0',
    'template1',
    'rdsadmin',
    'app',
    'app_',
    'apple_br_x',
    'other_br_x',
    'xapp_br_x',
    'APP_br_x',
    '',
  ])('refuses %s', (db) => {
    expect(() => assertManaged('app', db)).toThrow(SafetyError);
  });

  it('refuses reserved names even if the prefix matches', () => {
    expect(() => assertManaged('template', 'template_x')).not.toThrow();
    expect(() => assertManaged('template', 'template1')).toThrow(SafetyError);
  });

  it('refuses names longer than 63 bytes', () => {
    expect(() => assertManaged('app', `app_${'x'.repeat(60)}`)).toThrow(SafetyError);
  });

  it('refuses when the prefix itself is invalid', () => {
    expect(() => assertManaged('', 'x')).toThrow();
    expect(() => assertManaged('a"', 'a"_x')).toThrow();
  });

  it('template name passes the rule', () => {
    expect(isManaged('app', templateName('app'))).toBe(true);
  });
});
