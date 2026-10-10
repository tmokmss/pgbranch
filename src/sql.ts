/** Quote an identifier (database name) for use in SQL. */
export function quoteIdent(name: string): string {
  if (name.length === 0 || name.includes('\0')) {
    throw new Error(`Invalid identifier: ${JSON.stringify(name)}`);
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Quote a string literal. Uses the E'' form so the result is the same
 * whatever `standard_conforming_strings` is set to.
 */
export function quoteLiteral(value: string): string {
  if (value.includes('\0')) {
    throw new Error('String literal must not contain NUL');
  }
  return `E'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}
