#!/usr/bin/env node
// Test fixture: a CLI that emits JSON lines the way a streaming provider does.
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1];
};

if (has("--version")) {
  process.stdout.write("json-cli 0.9.0\n");
  process.exit(0);
}

if (has("--auth-status")) {
  process.stdout.write(has("--logged-out") ? "Not logged in\n" : "Logged in as tester\n");
  process.exit(has("--logged-out") ? 1 : 0);
}

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const model = valueOf("--model", "default-model");
const resumed = valueOf("--resume", null);

const run = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const prompt = Buffer.concat(chunks).toString("utf8").trim();

  emit({ type: "session", session_id: resumed ?? "session-abc" });
  emit({ type: "status", status: "thinking" });

  if (prompt.includes("boom")) {
    emit({ type: "error", message: "model refused", code: "provider_error" });
    process.exit(1);
  }

  // Interleave noise the adapter has to ignore.
  process.stdout.write("this line is not json\n");

  const marker = resumed ? ` resumed:${resumed}` : "";
  for (const word of `answering ${prompt} with ${model}${marker}`.split(" ")) {
    emit({ type: "delta", text: `${word} ` });
    await new Promise((r) => setTimeout(r, Number(valueOf("--delay", "0"))));
  }

  emit({ type: "usage", input_tokens: 11, output_tokens: 22 });
  emit({ type: "done" });
  process.exit(0);
};

run();
