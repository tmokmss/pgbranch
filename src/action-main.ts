import { run } from './action.js';

run().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stdout.write(`::error::${(err as Error).message}\n`);
    process.exitCode = 1;
  },
);
