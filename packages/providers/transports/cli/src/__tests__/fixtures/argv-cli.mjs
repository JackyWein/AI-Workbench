#!/usr/bin/env node
// Test fixture: prints the arguments it was given, so argument assembly can be
// asserted end to end instead of by inspecting internals.
process.stdout.write(`${JSON.stringify(process.argv.slice(2))}\n`);
process.exit(0);
