#!/usr/bin/env node
// Test fixture: reports how it was started — arguments, stdin, working
// directory and the environment variables named in REPORT_ENV — as one JSON
// line of answer text, so a test can assert on the whole invocation.
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

const names = (process.env["REPORT_ENV"] ?? "").split(",").filter(Boolean);
const env = Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]));

process.stdout.write(
  `${JSON.stringify({
    args: process.argv.slice(2),
    stdin: Buffer.concat(chunks).toString("utf8"),
    cwd: process.cwd(),
    env,
  })}\n`,
);
