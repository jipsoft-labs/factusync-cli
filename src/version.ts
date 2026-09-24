import { createRequire } from 'node:module';

/** `../package.json` from both `src/` (tests) and `dist/` (the published binary). */
export const CLI_VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
