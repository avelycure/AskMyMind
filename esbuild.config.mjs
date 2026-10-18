import esbuild from 'esbuild';
import process from 'process';
import { builtinModules } from 'node:module';

const prod = process.argv[2] === 'production';
const context = await esbuild.context({
  banner: { js: '/* Generated file. Source: https://github.com/avelycure/AI-Advent-RAG */' },
  entryPoints: ['src/main.ts'],
  bundle: true,
  loader: { '.md': 'text' },
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    'faiss-node',
    ...builtinModules,
    ...builtinModules.map((moduleName) => `node:${moduleName}`),
  ],
  format: 'cjs',
  target: 'es2021',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  minify: prod,
});

if (prod) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
