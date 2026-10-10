/** Return the admin URL with the database part replaced. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(database)}`;
  return u.toString();
}

/** Replace `{database}` in a URL template. */
export function fillUrlTemplate(template: string, database: string): string {
  return template.split('{database}').join(encodeURIComponent(database));
}

export function urlHasPassword(url: string): boolean {
  try {
    return new URL(url).password !== '';
  } catch {
    return false;
  }
}

export interface PgEnv {
  PGHOST: string;
  PGPORT: string;
  PGUSER: string;
  PGPASSWORD: string;
  PGDATABASE: string;
}

/** libpq env vars for a URL, with the database replaced. */
export function libpqEnv(url: string, database: string): PgEnv {
  const u = new URL(url);
  let host = decodeURIComponent(u.hostname);
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  return {
    PGHOST: host || 'localhost',
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: database,
  };
}

/** Hide the password in a URL for logs. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '<invalid url>';
  }
}
