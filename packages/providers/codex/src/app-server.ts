import { z } from "zod";
import { JsonRpcStdioClient } from "@ai-workbench/transport-cli";
import type { CliExtensionContext } from "@ai-workbench/provider-cli";

/**
 * Codex's app server (`codex app-server`) speaks newline-delimited JSON-RPC on
 * stdio. It is how the tool's own editor integrations ask for the model list,
 * the signed-in account and the rate limits — all without starting a turn,
 * which is what lets this package show real facts instead of guesses
 * (spec §55, §56).
 *
 * Only the read methods are used. Everything that comes back is validated:
 * the protocol is marked experimental and changes between releases, so a field
 * that is missing or reshaped makes that one answer unknown rather than
 * crashing the probe.
 */

const reasoningEffortOptionSchema = z
  .object({
    reasoningEffort: z.string().min(1),
    description: z.string().nullish(),
  })
  .passthrough();

const appServerModelSchema = z
  .object({
    id: z.string().min(1),
    /** The slug `-m` takes. Equal to `id` in every release seen so far. */
    model: z.string().nullish(),
    displayName: z.string().nullish(),
    description: z.string().nullish(),
    hidden: z.boolean().nullish(),
    isDefault: z.boolean().nullish(),
    supportedReasoningEfforts: z.array(reasoningEffortOptionSchema).nullish(),
    defaultReasoningEffort: z.string().nullish(),
    serviceTiers: z
      .array(z.object({ id: z.string(), name: z.string().nullish() }).passthrough())
      .nullish(),
    additionalSpeedTiers: z.array(z.string()).nullish(),
  })
  .passthrough();
export type AppServerModel = z.infer<typeof appServerModelSchema>;

const modelListPageSchema = z.object({
  data: z.array(z.unknown()),
  nextCursor: z.string().nullish(),
});

const accountResponseSchema = z.object({
  account: z
    .object({
      type: z.string(),
      email: z.string().nullish(),
      planType: z.string().nullish(),
    })
    .passthrough()
    .nullable(),
  requiresOpenaiAuth: z.boolean().nullish(),
});
export type AccountResponse = z.infer<typeof accountResponseSchema>;

const rateLimitWindowSchema = z.object({
  usedPercent: z.number(),
  windowDurationMins: z.number().nullish(),
  /** Unix seconds. */
  resetsAt: z.number().nullish(),
});
export type RateLimitWindow = z.infer<typeof rateLimitWindowSchema>;

const rateLimitSnapshotSchema = z
  .object({
    limitId: z.string().nullish(),
    limitName: z.string().nullish(),
    primary: rateLimitWindowSchema.nullish(),
    secondary: rateLimitWindowSchema.nullish(),
    planType: z.string().nullish(),
    rateLimitReachedType: z.string().nullish(),
  })
  .passthrough();
export type RateLimitSnapshot = z.infer<typeof rateLimitSnapshotSchema>;

const rateLimitsResponseSchema = z
  .object({
    /** Null means the backend did not say; never inferred from percentages. */
    ordinaryUsageAllowed: z.boolean().nullish(),
    rateLimits: rateLimitSnapshotSchema.nullish(),
    rateLimitsByLimitId: z.record(rateLimitSnapshotSchema.nullish()).nullish(),
  })
  .passthrough();
export type RateLimitsResponse = z.infer<typeof rateLimitsResponseSchema>;

/** Everything one app server session learned; each part is null when unknown. */
export interface CodexProbe {
  readonly models: AppServerModel[] | null;
  readonly account: AccountResponse | null;
  readonly rateLimits: RateLimitsResponse | null;
  /** Why the app server could not be asked at all, when it could not. */
  readonly failure: string | null;
}

export interface ProbeOptions {
  /**
   * Arguments placed before `app-server`. Empty for the real tool; the tests
   * point the executable at Node and put a fixture script here.
   */
  readonly launchPrefix?: readonly string[];
  readonly requestTimeoutMs?: number;
  /** Upper bound on `model/list` pages, so a looping cursor cannot hang us. */
  readonly maxModelPages?: number;
}

/** How this application introduces itself to the app server. */
const CLIENT_INFO = { name: "ai-workbench", title: "AI Workbench", version: "0.3.0" };

/**
 * Starts one app server, asks it everything the extensions need, and stops it
 * again. One process serves all three questions, so the provider list costs a
 * single short-lived process per refresh rather than three (spec §108).
 */
export async function probeAppServer(
  context: CliExtensionContext,
  options: ProbeOptions = {},
): Promise<CodexProbe> {
  const executablePath = await context.locate();
  if (!executablePath) {
    return emptyProbe("The Codex CLI is not installed");
  }

  const logger = context.logger;
  const client = new JsonRpcStdioClient({
    executablePath,
    args: [...(options.launchPrefix ?? []), "app-server"],
    // The state directory keeps the tool from treating whatever directory the
    // application was started in as a project to load settings from.
    cwd: context.stateDirectory,
    env: { ...context.env },
    requestTimeoutMs: options.requestTimeoutMs ?? 20_000,
    logger,
  });

  try {
    try {
      await client.request("initialize", { clientInfo: CLIENT_INFO, capabilities: null });
      client.notify("initialized");
    } catch (error) {
      const reason = describe(error);
      logger.debug("The Codex app server did not initialize", { reason });
      return emptyProbe(reason);
    }

    const [models, account, rateLimits] = await Promise.all([
      settle("model/list", () => listModels(client, options.maxModelPages ?? 20), logger),
      settle(
        "account/read",
        async () =>
          accountResponseSchema.parse(await client.request("account/read", { refreshToken: false })),
        logger,
      ),
      settle(
        "account/rateLimits/read",
        async () =>
          rateLimitsResponseSchema.parse(await client.request("account/rateLimits/read")),
        logger,
      ),
    ]);
    return { models, account, rateLimits, failure: null };
  } finally {
    await client.close();
  }
}

/** Follows `nextCursor` until the list ends. Malformed entries are skipped. */
async function listModels(
  client: JsonRpcStdioClient,
  maxPages: number,
): Promise<AppServerModel[]> {
  const models: AppServerModel[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < maxPages; page += 1) {
    const response = modelListPageSchema.parse(
      await client.request("model/list", cursor === null ? {} : { cursor }),
    );
    for (const entry of response.data) {
      const parsed = appServerModelSchema.safeParse(entry);
      if (parsed.success) {
        models.push(parsed.data);
      }
    }
    cursor = response.nextCursor ?? null;
    if (cursor === null) {
      break;
    }
  }
  return models;
}

async function settle<T>(
  method: string,
  run: () => Promise<T>,
  logger: CliExtensionContext["logger"],
): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    // Only the method and the reason: answers may name the account.
    logger.debug("A Codex app server request failed", { method, reason: describe(error) });
    return null;
  }
}

function emptyProbe(failure: string): CodexProbe {
  return { models: null, account: null, rateLimits: null, failure };
}

function describe(error: unknown): string {
  if (error instanceof z.ZodError) {
    return "The answer did not have the expected shape";
  }
  return error instanceof Error ? error.message : String(error);
}
