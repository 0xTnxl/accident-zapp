// Vercel serves functions from the project root's api/ folder. The code lives in apps/relayer so it
// is tested with the rest of the workspace; this only exposes it at /api/drip on the site's origin.
//
// Imports the compiled output of `pnpm --filter @accident/relayer build` (apps/relayer/dist,
// gitignored), not the TypeScript source: Vercel's Node.js function builder transpiles only this
// entry file, then leaves every import it finds (this one, and everything apps/relayer/src and the
// @accident/* workspace packages import in turn) to Node's native module resolver at runtime,
// which cannot load a .ts file. See apps/relayer/tsconfig.build.json and each workspace package's
// own `build` script and `exports` field for the rest of the chain this depends on.
export { GET, POST } from '../apps/relayer/dist/api/drip.js';
