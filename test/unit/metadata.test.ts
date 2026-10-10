import { describe, expect, it } from 'vitest';
import {
  branchSource,
  buildMetadata,
  parseMetadata,
  parseSource,
  serializeMetadata,
} from '../../src/metadata.js';
import { parseDuration } from '../../src/duration.js';

describe('metadata', () => {
  it('round-trips', () => {
    const meta = buildMetadata('feature/foo', 'template', new Date('2024-05-01T10:00:00Z'));
    const text = serializeMetadata(meta);
    expect(JSON.parse(text)).toEqual({
      pgbranch: 1,
      branch: 'feature/foo',
      createdAt: '2024-05-01T10:00:00.000Z',
      source: 'template',
    });
    expect(parseMetadata(text)).toEqual(meta);
  });

  it.each([
    [null],
    [undefined],
    [''],
    ['not json'],
    ['"a string"'],
    ['null'],
    ['{"branch":"x","createdAt":"2024-01-01"}'],
    ['{"pgbranch":2,"branch":"x","createdAt":"2024-01-01"}'],
    ['{"pgbranch":1,"createdAt":"2024-01-01"}'],
    ['{"pgbranch":1,"branch":"x"}'],
    ['{"pgbranch":1,"branch":"x","createdAt":"yesterday"}'],
    ['{"pgbranch":1,"branch":5,"createdAt":"2024-01-01"}'],
  ])('ignores %s', (comment) => {
    expect(parseMetadata(comment)).toBeUndefined();
  });

  it('defaults source to template', () => {
    expect(parseMetadata('{"pgbranch":1,"branch":"x","createdAt":"2024-01-01T00:00:00Z"}')?.source).toBe('template');
  });

  it('parses sources', () => {
    expect(parseSource('template')).toEqual({ kind: 'template' });
    expect(parseSource(branchSource('feature/a:b'))).toEqual({ kind: 'branch', branch: 'feature/a:b' });
    expect(() => parseSource('branch:')).toThrow();
    expect(() => parseSource('other')).toThrow();
  });
});

describe('parseDuration', () => {
  it.each([
    ['30s', 30_000],
    ['5m', 300_000],
    ['12h', 43_200_000],
    ['7d', 604_800_000],
    ['2w', 1_209_600_000],
    ['0s', 0],
    [' 1d ', 86_400_000],
  ])('%s', (input, ms) => {
    expect(parseDuration(input)).toBe(ms);
  });

  it.each(['', '7', 'd', '1.5d', '-1d', '7days', '1y'])('rejects %s', (input) => {
    expect(() => parseDuration(input)).toThrow(/Invalid duration/);
  });
});
