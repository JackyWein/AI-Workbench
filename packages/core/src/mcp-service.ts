import { eq } from "drizzle-orm";
import type { Database } from "@ai-workbench/database";
import {
  mcpServers,
  sessionMcpServers,
  sessions,
  type McpServerRow,
} from "@ai-workbench/database";
import type { McpGateway, McpGatewayRoute, McpManager, McpOAuth, McpOAuthTarget } from "@ai-workbench/mcp";
import type { ProviderToolAccess } from "@ai-workbench/provider-base";
import { ToolBridge } from "./tool-bridge.js";
import {
  mcpServerSaveInputSchema,
  parseMcpServerConfig,
  type McpServerSaveInput,
  type Logger,
  type McpServerConfig,
  type McpServerConfigInput,
  type McpServerStatus,
  type ProviderCapabilities,
} from "@ai-workbench/shared";

export interface McpServiceOptions {
  readonly db: Database;
  readonly logger: Logger;
  readonly manager: McpManager;
  /** Signs in to servers that use OAuth; without it they cannot be used. */
  readonly oauth?: McpOAuth;
  /**
   * The local gateway tools reach servers that need a credential through,
   * so the credential stays in the main process.
   */
  readonly gateway?: Pick<McpGateway, "endpointFor" | "endpointForAll">;
  /**
   * Where remote auth secrets come from. Only the credential reference is
   * ever stored or sent anywhere; the secret is resolved here, in the main
   * process, at connect time (spec §57).
   */
  readonly credentials?: McpCredentialSource;
  /**
   * The application's own read-only servers, whose tools a tool may run
   * without asking (see ProviderToolAccess). Only ids listed here.
   */
  readonly trustedServerIds?: readonly string[];
}

/** Anything that can turn a credential reference into its secret. */
export interface McpCredentialSource {
  resolve(reference: string): Promise<string | null>;
  /** Stores a secret (replacing the one under `reference`); returns its reference. */
  store?(label: string, secret: string, reference?: string): Promise<string>;
  delete?(reference: string): Promise<void>;
}

/**
 * Where a remote server's credential reference lives until the database grows
 * its own column: remote transports have no process environment, so their
 * otherwise unused env bag carries the reference under a reserved key. Only
 * the reference is stored there, never the secret (spec §57).
 */
const CREDENTIAL_ENV_KEY = "AI_WORKBENCH_MCP_CREDENTIAL_REFERENCE";
/** Kept next to the reference the same way: which header the key goes in. */
const CREDENTIAL_HEADER_KEY = "AI_WORKBENCH_MCP_CREDENTIAL_HEADER";
/**
 * Secret variables of a server — names and credential references, never a
 * value — and where an imported server came from, kept in the same bag under
 * reserved keys until the database grows columns for them. Both are taken out
 * again before the configuration reaches anything else.
 */
const SECRET_ENV_KEY = "AI_WORKBENCH_MCP_SECRET_ENV";
const ORIGIN_KEY = "AI_WORKBENCH_MCP_ORIGIN";
const RESERVED_ENV_KEYS = [CREDENTIAL_ENV_KEY, CREDENTIAL_HEADER_KEY, SECRET_ENV_KEY, ORIGIN_KEY];

/**
 * Stores MCP server configurations, keeps the connections in step with them and
 * records which servers each session may use (spec §37, §38).
 */
export class McpService {
  readonly #db: Database;
  readonly #logger: Logger;
  readonly #manager: McpManager;
  readonly #oauth: McpOAuth | undefined;
  readonly #gateway: Pick<McpGateway, "endpointFor" | "endpointForAll"> | undefined;
  readonly #credentials: McpCredentialSource | undefined;
  readonly #trusted: ReadonlySet<string>;
  readonly #toolBridge = new ToolBridge();

  constructor(options: McpServiceOptions) {
    this.#db = options.db;
    this.#logger = options.logger.child("MCP");
    this.#manager = options.manager;
    this.#oauth = options.oauth;
    this.#gateway = options.gateway;
    this.#credentials = options.credentials;
    this.#trusted = new Set(options.trustedServerIds ?? []);
    if (options.credentials) {
      const source = options.credentials;
      this.#manager.setCredentialResolver((reference) => source.resolve(reference));
    }
    this.#manager.setEndpointResolver(async (config) => {
      if (!config.oauth) {
        return null;
      }
      if (!(await this.#oauth?.isSignedIn(config.oauth.reference))) {
        return { signInRequired: `Sign in to ${config.name} to use it.` };
      }
      return this.#gateway ? this.#gateway.endpointFor(config.id) : null;
    });
  }

  /**
   * How the gateway reaches a server and signs its requests: with the
   * stored credential, or the OAuth token, renewed when it runs out.
   */
  async gatewayRoute(serverId: string): Promise<McpGatewayRoute | null> {
    const config = await this.get(serverId);
    if (!config?.url || config.transport === "stdio" || !config.enabled) {
      return null;
    }
    const oauth = config.oauth;
    if (oauth) {
      const service = this.#oauth;
      return {
        url: config.url,
        name: config.name,
        authorization: async (force) => {
          const token = await service?.accessToken(oauthTarget(config), { force });
          return token ? `Bearer ${token}` : null;
        },
      };
    }
    const reference = config.credentialReference;
    if (!reference) {
      return null;
    }
    const source = this.#credentials;
    const header = config.apiKeyHeader;
    return {
      url: config.url,
      name: config.name,
      ...(header ? { header } : {}),
      authorization: async () => {
        const secret = await source?.resolve(reference);
        if (!secret) {
          return null;
        }
        // A service's own key header takes the key as it is; Authorization
        // takes a scheme, Bearer unless the stored value names one.
        if (header) {
          return secret;
        }
        return /^\S+\s+\S/.test(secret) ? secret : `Bearer ${secret}`;
      },
    };
  }

  /**
   * Signs in to a server with OAuth in the person's browser, then connects
   * it. `clientSecret` is only for services that issue one with a client
   * the person registered; it is kept with the tokens.
   */
  async signIn(id: string, clientSecret?: string): Promise<McpServerStatus | null> {
    const config = await this.get(id);
    if (!config?.oauth || !config.url) {
      throw new Error("This connector does not sign in with OAuth.");
    }
    if (!this.#oauth) {
      throw new Error("Signing in is not available in this process.");
    }
    const reference = await this.#oauth.signIn({
      ...oauthTarget(config),
      ...(clientSecret ? { clientSecret } : {}),
    });
    await this.setOAuthReference(id, reference);
    return this.connect(id);
  }

  /** Forgets a server's sign-in; it asks for a new one before it is used. */
  async signOut(id: string): Promise<McpServerStatus | null> {
    const config = await this.get(id);
    if (!config?.oauth) {
      return null;
    }
    await this.#oauth?.signOut(config.oauth.reference);
    await this.setOAuthReference(id, null);
    await this.#manager.disconnect(id);
    return this.connect(id);
  }

  /**
   * What a provider gets for these servers: the servers themselves for a
   * tool that connects on its own — through the gateway when they need a
   * credential — or the tools the application runs for it.
   */
  async toolAccess(
    capabilities: ProviderCapabilities,
    serverIds: readonly string[],
  ): Promise<ProviderToolAccess | null> {
    if (serverIds.length === 0) {
      return null;
    }
    const plan = this.#toolBridge.plan({
      capabilities,
      enabledServerIds: serverIds,
      configs: await this.list(),
      statuses: this.statuses(),
      toolsFor: (ids) => this.#manager.toolsForSession(ids),
    });
    for (const entry of plan.unavailable) {
      this.#logger.debug("MCP server is enabled but unusable", {
        serverId: entry.id,
        reason: entry.reason,
      });
    }
    if (plan.kind === "none") {
      return null;
    }
    const combined =
      plan.kind === "provider-mcp" && this.#gateway
        ? this.#gateway.endpointForAll(plan.mcpServers.map((config) => config.id))
        : null;
    return {
      kind: plan.kind,
      mcpServers: plan.mcpServers.map((config) => this.#forTools(config)),
      ...(combined ? { combined } : {}),
      hostTools: plan.hostTools,
    };
  }

  #forTools(config: McpServerConfig): ProviderToolAccess["mcpServers"][number] {
    // A server with secret variables is never handed to a tool as a command:
    // the tool would need the values in its configuration. The application
    // runs it with them and serves its tools through the local gateway.
    if (config.transport === "stdio" && Object.keys(config.secretEnv).length > 0 && this.#gateway) {
      const endpoint = this.#gateway.endpointForAll([config.id]);
      return {
        id: config.id,
        name: config.name,
        transport: "http",
        args: [],
        env: {},
        url: endpoint.url,
        headers: endpoint.headers,
        ...(this.#trusted.has(config.id) ? { trusted: true } : {}),
      };
    }
    const signs = config.transport !== "stdio" && (config.oauth || config.credentialReference);
    const endpoint = signs && this.#gateway ? this.#gateway.endpointFor(config.id) : null;
    return {
      id: config.id,
      name: config.name,
      transport: config.transport,
      ...(config.command ? { command: config.command } : {}),
      args: config.args,
      env: config.env,
      ...(config.cwd ? { cwd: config.cwd } : {}),
      ...(endpoint
        ? { url: endpoint.url, headers: endpoint.headers }
        : config.url
          ? { url: config.url }
          : {}),
      ...(this.#trusted.has(config.id) ? { trusted: true } : {}),
    };
  }

  /** Usage instructions of the connected servers among these, from the servers. */
  instructionsFor(serverIds: readonly string[]): Array<{ serverId: string; instructions: string }> {
    return this.#manager.instructionsFor(serverIds);
  }

  get manager(): McpManager {
    return this.#manager;
  }

  async list(): Promise<McpServerConfig[]> {
    return (await this.#db.select().from(mcpServers)).map(toConfig);
  }

  async get(id: string): Promise<McpServerConfig | null> {
    const [row] = await this.#db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, id))
      .limit(1);
    return row ? toConfig(row) : null;
  }

  async save(input: McpServerConfigInput): Promise<McpServerConfig> {
    const config = parseMcpServerConfig(input);
    const now = new Date();
    const existing = await this.get(config.id);

    // stdio servers really spawn a process, so their env must stay exactly
    // what the user set; a credential reference is only honored (and only
    // stored) for remote transports.
    const env = { ...config.env };
    for (const key of RESERVED_ENV_KEYS) {
      delete env[key];
    }
    if (Object.keys(config.secretEnv).length > 0) {
      env[SECRET_ENV_KEY] = JSON.stringify(config.secretEnv);
    }
    if (config.origin) {
      env[ORIGIN_KEY] = JSON.stringify(config.origin);
    }
    if (config.credentialReference && config.transport !== "stdio") {
      env[CREDENTIAL_ENV_KEY] = config.credentialReference;
      if (config.apiKeyHeader) {
        env[CREDENTIAL_HEADER_KEY] = config.apiKeyHeader;
      } else {
        delete env[CREDENTIAL_HEADER_KEY];
      }
    } else {
      delete env[CREDENTIAL_ENV_KEY];
      delete env[CREDENTIAL_HEADER_KEY];
    }

    // A sign-in made before is kept when the form that saves the server does
    // not carry it: only signing out forgets it.
    const oauth = config.oauth
      ? {
          ...config.oauth,
          ...(config.oauth.reference === undefined && existing?.oauth?.reference
            ? { reference: existing.oauth.reference }
            : {}),
        }
      : null;

    const values = {
      id: config.id,
      name: config.name,
      transport: config.transport,
      command: config.command ?? null,
      args: config.args,
      env,
      url: config.url ?? null,
      cwd: config.cwd ?? null,
      enabled: config.enabled,
      availability: config.availability,
      workspaceIds: config.workspaceIds,
      catalogId: config.catalogId ?? null,
      oauth,
      createdAt: existing ? undefined : now,
      updatedAt: now,
    };

    await this.#db
      .insert(mcpServers)
      .values({ ...values, createdAt: values.createdAt ?? now })
      .onConflictDoUpdate({
        target: mcpServers.id,
        set: {
          name: values.name,
          transport: values.transport,
          command: values.command,
          args: values.args,
          env: values.env,
          url: values.url,
          cwd: values.cwd,
          enabled: values.enabled,
          availability: values.availability,
          workspaceIds: values.workspaceIds,
          catalogId: values.catalogId,
          oauth: values.oauth,
          updatedAt: now,
        },
      });

    return (await this.get(config.id)) ?? config;
  }

  /** Records where a server's sign-in is kept, or that it has none. */
  async setOAuthReference(id: string, reference: string | null): Promise<McpServerConfig | null> {
    const config = await this.get(id);
    if (!config) {
      return null;
    }
    const { reference: _previous, ...rest } = config.oauth ?? { scopes: [] };
    const oauth = { ...rest, ...(reference ? { reference } : {}) };
    await this.#db
      .update(mcpServers)
      .set({ oauth, updatedAt: new Date() })
      .where(eq(mcpServers.id, id));
    return this.get(id);
  }

  /**
   * Saves what the window sent: a new API key is stored here and only its
   * reference kept; a sign-in made before is kept. The server is connected
   * (or let go) to match.
   */
  async saveFromWindow(
    raw: McpServerSaveInput,
    extras: { readonly origin?: NonNullable<McpServerConfig["origin"]> } = {},
  ): Promise<McpServerConfig> {
    const input = mcpServerSaveInputSchema.parse(raw);
    const existing = await this.get(input.id);
    // Secret variables: the window names which to keep and sends new values;
    // the references never leave this process, so no window can attach a
    // stored secret to a server it defines.
    const secretEnv: Record<string, string> = {};
    const keep = new Set(input.keepSecretEnv ?? Object.keys(existing?.secretEnv ?? {}));
    for (const [name, reference] of Object.entries(existing?.secretEnv ?? {})) {
      if (keep.has(name) && !(name in (input.newSecretEnv ?? {}))) {
        secretEnv[name] = reference;
      } else if (!(name in (input.newSecretEnv ?? {}))) {
        await this.#credentials?.delete?.(reference);
      }
    }
    for (const [name, value] of Object.entries(input.newSecretEnv ?? {})) {
      if (!this.#credentials?.store) {
        throw new Error("Secrets cannot be stored in this process.");
      }
      secretEnv[name] = await this.#credentials.store(
        `${input.name} ${name}`,
        value,
        existing?.secretEnv[name],
      );
    }
    const env = { ...input.env };
    for (const name of Object.keys(secretEnv)) {
      delete env[name];
    }
    let credentialReference = existing?.credentialReference;
    if (input.apiKey) {
      if (!this.#credentials?.store) {
        throw new Error("API keys cannot be stored in this process.");
      }
      credentialReference = await this.#credentials.store(
        `${input.name} API key`,
        input.apiKey,
        credentialReference,
      );
    } else if (input.clearApiKey && credentialReference) {
      await this.#credentials?.delete?.(credentialReference);
      credentialReference = undefined;
    }
    // Leaving OAuth behind leaves nothing of the sign-in behind either.
    if (existing?.oauth?.reference && !input.oauth) {
      await this.#oauth?.signOut(existing.oauth.reference);
    }
    const {
      apiKey: _apiKey,
      clearApiKey: _clear,
      keepSecretEnv: _keep,
      newSecretEnv: _new,
      ...config
    } = input;
    const origin = extras.origin ?? existing?.origin;
    const saved = await this.save({
      ...config,
      env,
      secretEnv,
      ...(origin ? { origin } : {}),
      ...(credentialReference ? { credentialReference } : {}),
      ...(input.oauth
        ? {
            oauth: {
              ...input.oauth,
              ...(existing?.oauth?.reference ? { reference: existing.oauth.reference } : {}),
            },
          }
        : {}),
    });
    if (saved.enabled) {
      await this.connect(saved.id);
    } else {
      await this.#manager.disconnect(saved.id);
    }
    return saved;
  }

  async delete(id: string): Promise<boolean> {
    const config = await this.get(id);
    await this.#manager.disconnect(id);
    await this.#db.delete(mcpServers).where(eq(mcpServers.id, id));
    // Its key, its secret variables and its sign-in go with it.
    if (config?.credentialReference) {
      await this.#credentials?.delete?.(config.credentialReference);
    }
    for (const reference of Object.values(config?.secretEnv ?? {})) {
      await this.#credentials?.delete?.(reference);
    }
    await this.#oauth?.signOut(config?.oauth?.reference);
    return true;
  }

  /** Connects every enabled server. Failures are recorded, never thrown. */
  async connectEnabled(): Promise<McpServerStatus[]> {
    const configs = (await this.list()).filter((config) => config.enabled);
    const statuses: McpServerStatus[] = [];
    for (const config of configs) {
      statuses.push(await this.#manager.connect(config));
    }
    this.#logger.info("MCP servers connected", {
      requested: configs.length,
      connected: statuses.filter((status) => status.state === "connected").length,
    });
    return statuses;
  }

  async connect(id: string): Promise<McpServerStatus | null> {
    const config = await this.get(id);
    return config ? this.#manager.connect(config) : null;
  }

  async disconnect(id: string): Promise<boolean> {
    return this.#manager.disconnect(id);
  }

  statuses(): McpServerStatus[] {
    return this.#manager.statuses();
  }

  /**
   * Which servers a session may use (spec §38): every enabled server that is
   * available in its workspace, unless the session switched it off, plus any
   * the session switched on for itself.
   */
  /**
   * Which servers a session gets. `workspaceId` stands in for a session the
   * database does not know — a team member's — so the servers switched on
   * for its run's workspace reach it too.
   */
  async enabledForSession(sessionId: string, workspaceId?: string): Promise<string[]> {
    const [session] = await this.#db
      .select({ workspaceId: sessions.workspaceId })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    const rows = await this.#db
      .select()
      .from(sessionMcpServers)
      .where(eq(sessionMcpServers.sessionId, sessionId));
    const overrides = new Map(rows.map((row) => [row.serverId, row.enabled]));
    return availableServers(await this.list(), session?.workspaceId ?? workspaceId ?? null, overrides);
  }

  /** Which servers a terminal agent in this workspace gets. */
  async enabledForWorkspace(workspaceId: string | null): Promise<string[]> {
    return availableServers(await this.list(), workspaceId, new Map());
  }

  async setSessionAccess(
    sessionId: string,
    serverId: string,
    enabled: boolean,
  ): Promise<void> {
    await this.#db
      .insert(sessionMcpServers)
      .values({ sessionId, serverId, enabled })
      .onConflictDoUpdate({
        target: [sessionMcpServers.sessionId, sessionMcpServers.serverId],
        set: { enabled },
      });
  }

}

function oauthTarget(config: McpServerConfig): McpOAuthTarget {
  return {
    id: config.id,
    name: config.name,
    url: config.url ?? "",
    reference: config.oauth?.reference,
    scopes: config.oauth?.scopes ?? [],
    clientId: config.oauth?.clientId,
  };
}

/**
 * The servers a place may use: enabled ones available everywhere or in its
 * workspace, then what a session decided for itself on top.
 */
export function availableServers(
  configs: readonly McpServerConfig[],
  workspaceId: string | null,
  overrides: ReadonlyMap<string, boolean>,
): string[] {
  return configs
    .filter((config) => {
      if (!config.enabled) {
        return false;
      }
      const decided = overrides.get(config.id);
      if (decided !== undefined) {
        return decided;
      }
      return (
        config.availability === "everywhere" ||
        (workspaceId !== null && config.workspaceIds.includes(workspaceId))
      );
    })
    .map((config) => config.id);
}

function toConfig(row: McpServerRow): McpServerConfig {
  const env = { ...row.env };
  const credentialReference = env[CREDENTIAL_ENV_KEY];
  const apiKeyHeader = env[CREDENTIAL_HEADER_KEY];
  const secretEnv = readJson(env[SECRET_ENV_KEY], isStringRecord) ?? {};
  const origin = readJson(env[ORIGIN_KEY], isOrigin);
  for (const key of RESERVED_ENV_KEYS) {
    delete env[key];
  }
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    ...(row.command === null ? {} : { command: row.command }),
    args: row.args,
    env,
    ...(row.url === null ? {} : { url: row.url }),
    ...(row.cwd === null ? {} : { cwd: row.cwd }),
    ...(typeof credentialReference === "string" && credentialReference.length > 0
      ? { credentialReference }
      : {}),
    ...(typeof apiKeyHeader === "string" && apiKeyHeader.length > 0 ? { apiKeyHeader } : {}),
    enabled: row.enabled,
    availability: row.availability,
    workspaceIds: row.workspaceIds,
    secretEnv,
    ...(origin ? { origin } : {}),
    ...(row.catalogId === null ? {} : { catalogId: row.catalogId }),
    ...(isOAuth(row.oauth) ? { oauth: row.oauth } : {}),
  };
}

function isOAuth(value: unknown): value is NonNullable<McpServerConfig["oauth"]> {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { scopes?: unknown }).scopes)
  );
}

function readJson<T>(raw: string | undefined, valid: (value: unknown) => value is T): T | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return valid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isOrigin(value: unknown): value is { key: string; source: string; fingerprint: string } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record["key"] === "string" && typeof record["source"] === "string" && typeof record["fingerprint"] === "string";
}
