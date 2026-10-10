// Test hook: run the SQL given as arguments against $DATABASE_URL.
// Exit code 1 if any statement fails.
import pg from 'pg';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  for (const sql of process.argv.slice(2)) {
    await client.query(sql);
  }
} catch (err) {
  console.error(`sql hook failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
