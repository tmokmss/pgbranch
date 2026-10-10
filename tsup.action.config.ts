import { defineConfig } from 'tsup';

// Single-file bundle for the GitHub Action, with all dependencies inside,
// because an action runs without `npm install`.
export default defineConfig({
  entry: { index: 'src/action-main.ts' },
  outDir: 'action-dist',
  format: ['cjs'],
  target: 'node20',
  platform: 'node',
  noExternal: [/.*/],
  splitting: false,
  sourcemap: false,
  minify: true,
  clean: true,
});
