#!/usr/bin/env node
// Test fixture: replays a recorded provider stream so the parsing of a real
// CLI's output can be verified without making a paid call.
import { createReadStream } from "node:fs";

const file = process.env["REPLAY_FILE"];
if (!file) {
  process.stderr.write("REPLAY_FILE is not set\n");
  process.exit(2);
}

// Consume stdin so a writer never sees a broken pipe.
process.stdin.resume();
process.stdin.on("data", () => {});

createReadStream(file)
  .on("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  })
  .pipe(process.stdout)
  .on("finish", () => process.exit(0));
