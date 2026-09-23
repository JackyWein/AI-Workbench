/**
 * Checks the command line tools installed on this machine the way the
 * application sees them, with the person's own accounts: version, sign-in,
 * the models each tool reports, its usage, and whether the status island is
 * set up for it. It only reads: no turn is started, no quota is spent, and
 * the application's own data is not touched (a throwaway state folder is
 * used and removed).
 *
 *   bun run check:providers
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderManager, createNullLogger } from "@ai-workbench/core";
import type { AIProviderAdapter } from "@ai-workbench/provider-base";
import { antigravityProfile, cliProviderFactory, parseProfile } from "@ai-workbench/provider-cli";
import { claudeCodeFactory } from "@ai-workbench/provider-claude";
import { codexFactory } from "@ai-workbench/provider-codex";
import { geminiFactory } from "@ai-workbench/provider-gemini";
import { opencodeFactory } from "@ai-workbench/provider-opencode";
import type { ProviderUsageSnapshot, UsageLimit } from "@ai-workbench/shared";

const USAGE_WAIT_MS = 60_000;

/** Prints a line; the lint rule keeps console.log out of the application. */
function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function limitText(limit: UsageLimit): string {
  const unit = limit.unit === "percent" ? "%" : limit.unit === "usd" ? " USD" : ` ${limit.unit}`;
  const used = limit.used === undefined ? "" : `${Math.round(limit.used * 100) / 100}${unit} used`;
  const left =
    limit.remaining === undefined ? "" : `${Math.round(limit.remaining * 100) / 100}${unit} left`;
  const reset = limit.resetsAt ? `, resets ${limit.resetsAt.toLocaleString()}` : "";
  return `${limit.label}: ${[used, left].filter(Boolean).join(", ") || "reported"}${reset}`;
}

/** Usage as the tool reports it; a first reading may take a moment. */
async function usageOf(adapter: AIProviderAdapter): Promise<ProviderUsageSnapshot | null> {
  if (!adapter.getUsage) {
    return null;
  }
  const deadline = Date.now() + USAGE_WAIT_MS;
  let usage = await adapter.getUsage();
  while (usage.state === "unavailable" && usage.note?.includes("still being read") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    usage = await adapter.getUsage();
  }
  return usage;
}

async function check(adapter: AIProviderAdapter): Promise<string[]> {
  const lines: string[] = [];
  const installation = await adapter.detectInstallation();
  if (installation.state !== "installed") {
    return [`  not installed${installation.detail ? ` (${installation.detail})` : ""}`];
  }
  lines.push(
    `  installed: ${installation.version ?? "version unknown"} at ${installation.executablePath ?? "?"}`,
  );

  const auth = await adapter.getAuthenticationStatus();
  lines.push(
    `  sign-in: ${auth.state}${auth.accountLabel ? ` as ${auth.accountLabel}` : ""}${auth.plan ? ` (${auth.plan})` : ""}${auth.detail ? ` (${auth.detail})` : ""}`,
  );

  const models = (await adapter.refreshModels?.()) ?? (await adapter.listModels());
  const reported = models.filter((model) => model.source === "provider");
  const groups = new Set(models.map((model) => model.group).filter(Boolean));
  lines.push(
    `  models: ${models.length} (${reported.length} reported by the tool${
      groups.size > 1 ? `, from ${groups.size} providers` : ""
    }): ${models
      .slice(0, 6)
      .map((model) => model.id)
      .join(", ")}${models.length > 6 ? ", ..." : ""}`,
  );
  const note = adapter.getModelsNote?.();
  if (note) {
    lines.push(`  models note: ${note}`);
  }

  const usage = await usageOf(adapter);
  if (usage) {
    lines.push(`  usage: ${usage.state}${usage.plan ? ` (${usage.plan})` : ""}${usage.note ? ` — ${usage.note}` : ""}`);
    for (const limit of usage.limits) {
      lines.push(`    ${limitText(limit)}`);
    }
  }

  const integration = await adapter.getIntegration?.();
  if (integration) {
    lines.push(
      `  ${integration.name.toLowerCase()}: ${integration.state}${
        integration.state === "ready" ? "" : " — set it up on the Providers screen"
      }`,
    );
  }
  return lines;
}

async function main(): Promise<void> {
  const state = await mkdtemp(join(tmpdir(), "ai-workbench-check-"));
  const providers = new ProviderManager({ logger: createNullLogger(), stateDirectory: state });
  const factories = [
    claudeCodeFactory(),
    codexFactory(),
    geminiFactory(),
    opencodeFactory(),
    cliProviderFactory(parseProfile(antigravityProfile)),
  ];
  try {
    for (const factory of factories) {
      await providers.registerFactory(factory, {});
      const adapter = providers.get(factory.family);
      say(`\n${factory.displayName}`);
      if (!adapter) {
        say("  not registered");
        continue;
      }
      try {
        for (const line of await check(adapter)) {
          say(line);
        }
      } catch (error) {
        say(`  check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await providers.dispose();
    await rm(state, { recursive: true, force: true });
  }
}

await main();
