#!/usr/bin/env node
// Test fixture: a CLI that streams lines, reads stdin, fails or hangs on demand.
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1];
};

if (has("--version")) {
  process.stdout.write("stream-cli 2.4.1 (test fixture)\n");
  process.exit(0);
}

if (has("--fail")) {
  process.stderr.write("something went wrong\n");
  process.exit(3);
}

if (has("--hang")) {
  // Never exits on its own; the test cancels or times it out.
  process.stdin.resume();
  setInterval(() => {}, 1000);
} else {
  const count = Number(valueOf("--lines", "3"));
  const delay = Number(valueOf("--delay", "0"));

  const readStdin = async () => {
    if (!has("--echo-stdin")) return "";
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8").trim();
  };

  readStdin().then(async (stdin) => {
    if (stdin) process.stdout.write(`stdin:${stdin}\n`);
    for (let i = 1; i <= count; i += 1) {
      // Deliberately written without a trailing newline on the last line so the
      // consumer has to flush its buffer.
      process.stdout.write(i === count ? `line ${i}` : `line ${i}\n`);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    }
    process.exit(0);
  });
}
