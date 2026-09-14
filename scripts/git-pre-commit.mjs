#!/usr/bin/env node
import { runPreCommit } from '../src/core/git-hooks.mjs';

try {
  await runPreCommit();
} catch (error) {
  console.error(`LocalBoard pre-commit failed: ${error.message}`);
  process.exit(1);
}
