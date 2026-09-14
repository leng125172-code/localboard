#!/usr/bin/env node
import { runPrePush } from '../src/core/git-hooks.mjs';

try {
  await runPrePush();
} catch (error) {
  console.error(`LocalBoard pre-push failed: ${error.message}`);
  process.exit(1);
}
