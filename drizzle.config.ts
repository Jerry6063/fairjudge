/**
 * drizzle-kit config — used for GENERATING migrations from schema.ts.
 *
 * Since M2 the on-disk database is SQLCipher-encrypted and drizzle-kit has no
 * way to pass a key, so anything that introspects the live database
 * (`drizzle-kit push`/`studio`) cannot open `data/fairjudge.db`. Schema changes
 * go: edit schema.ts → `npx drizzle-kit generate` → apply through a keyed
 * connection with `runMigrations()` (src/server/db) — which is what
 * `npm run seed:import` and the app already do on startup.
 */

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "./fairjudge.db",
  },
});
