import * as esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// micro-flow ships unbundled ESM that imports Node's `crypto` and node-schedule
// (a CommonJS package that requires Node's `events`), so browsers can't load it
// straight from node_modules. Bundle it into one browser ESM file instead:
// `crypto` is swapped for a Web Crypto shim and `events` resolves to the
// `events` npm polyfill.
export async function bundleMicroFlow() {
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: ['@ronaldroe/micro-flow'],
    alias: { crypto: './lib/crypto-shim.js' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    minify: true,
    write: false,
    logLevel: 'warning',
  });

  return result.outputFiles[0].text;
}
