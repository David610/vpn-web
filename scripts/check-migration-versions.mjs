#!/usr/bin/env node
import { readdir } from "node:fs/promises";

const directory = new URL("../supabase/migrations/", import.meta.url);
const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
const versions = new Map();
for (const file of files) {
  const match = /^(\d+)_.*\.sql$/.exec(file);
  if (!match) {
    console.error(`Invalid migration filename (missing numeric version prefix): ${file}`);
    process.exitCode = 1;
    continue;
  }
  const previous = versions.get(match[1]);
  if (previous) {
    console.error(`Duplicate migration version ${match[1]}: ${previous}, ${file}`);
    process.exitCode = 1;
  } else {
    versions.set(match[1], file);
  }
}
if (process.exitCode) process.exit(process.exitCode);
console.log(`check-migration-versions: OK (${files.length} unique versions)`);
