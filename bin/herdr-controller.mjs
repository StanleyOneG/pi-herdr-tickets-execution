#!/usr/bin/env node

import "tsx/esm";

const { runDaemon } = await import("../src/daemon-main.ts");

try {
  await runDaemon(process.argv.slice(2));
} catch {
  process.exitCode = 1;
}
