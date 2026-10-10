// Runs the build, which is authored in TypeScript in scripts/build.ts (see there for what it does).
// Node strips that file's types itself; this file only keeps `node scripts/build.mjs [--check]`, and
// with it npm run build, check-generated and prepack, working unchanged.
import './build.ts'
