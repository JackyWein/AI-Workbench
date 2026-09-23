/**
 * Services an agent can be connected to, each one a remote MCP server run by
 * the service itself. Picking one adds it as an MCP server; how it signs in
 * is the service's own (OAuth where it offers it, a key where it asks for
 * one), and the application never learns the person's password.
 *
 * Honest about what was checked: `tested` names the day an entry's endpoint
 * answered the MCP handshake and listed its tools from here. The others are
 * the addresses the services publish; they are shown as not tested yet.
 */
export interface ConnectorCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly publisher: string;
  readonly description: string;
  readonly url: string;
  readonly transport: "http" | "sse";
  /**
   * `oauth`: signs in in the browser, the app registers itself.
   * `oauth-client`: signs in in the browser with an OAuth client the person
   *   made at the service (Google registers no apps on its own).
   * `api-key`: a key or token from the service, sent as the Authorization header.
   * `none`: open to anyone.
   */
  readonly signIn: "oauth" | "oauth-client" | "api-key" | "none";
  /** Asked for at sign-in; the service's own list when absent. */
  readonly scopes?: readonly string[];
  /** What the person does at the service first, in a sentence. */
  readonly setup?: string;
  /** Where that is done. */
  readonly setupUrl?: string;
  /** The day the endpoint answered from here, ISO date; absent when not yet. */
  readonly tested?: string;
  /** A key the UI turns into the service's logo. */
  readonly icon: string;
  readonly category: "Productivity" | "Development" | "Knowledge" | "Business";
}

const GOOGLE_CLIENT_SETUP =
  "Google signs in only apps it knows, so it needs an OAuth client of your own: in Google Cloud, create an OAuth client ID of type “Desktop app” (and enable the service's MCP API in that project), then enter its client ID and secret here.";
const GOOGLE_CLIENT_URL = "https://console.cloud.google.com/apis/credentials";

export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = [
  {
    id: "gmail",
    name: "Gmail",
    publisher: "Google",
    description: "Search, read and label mail, and write drafts.",
    url: "https://gmailmcp.googleapis.com/mcp/v1",
    transport: "http",
    signIn: "oauth-client",
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    setup: GOOGLE_CLIENT_SETUP,
    setupUrl: GOOGLE_CLIENT_URL,
    tested: "2026-09-23",
    icon: "gmail",
    category: "Productivity",
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    publisher: "Google",
    description: "See your calendars, find free time, and create or answer events.",
    url: "https://calendarmcp.googleapis.com/mcp/v1",
    transport: "http",
    signIn: "oauth-client",
    scopes: ["https://www.googleapis.com/auth/calendar"],
    setup: GOOGLE_CLIENT_SETUP,
    setupUrl: GOOGLE_CLIENT_URL,
    tested: "2026-09-23",
    icon: "googlecalendar",
    category: "Productivity",
  },
  {
    id: "google-drive",
    name: "Google Drive",
    publisher: "Google",
    description: "Search, read and create files in your Drive.",
    url: "https://drivemcp.googleapis.com/mcp/v1",
    transport: "http",
    signIn: "oauth-client",
    scopes: ["https://www.googleapis.com/auth/drive"],
    setup: GOOGLE_CLIENT_SETUP,
    setupUrl: GOOGLE_CLIENT_URL,
    tested: "2026-09-23",
    icon: "googledrive",
    category: "Productivity",
  },
  {
    id: "notion",
    name: "Notion",
    publisher: "Notion",
    description: "Search, read and update pages and databases in your workspace.",
    url: "https://mcp.notion.com/mcp",
    transport: "http",
    signIn: "oauth",
    icon: "notion",
    category: "Productivity",
  },
  {
    id: "linear",
    name: "Linear",
    publisher: "Linear",
    description: "Find, create and update issues, projects and comments.",
    url: "https://mcp.linear.app/mcp",
    transport: "http",
    signIn: "oauth",
    icon: "linear",
    category: "Development",
  },
  {
    id: "github",
    name: "GitHub",
    publisher: "GitHub",
    description: "Repositories, issues, pull requests and Actions.",
    url: "https://api.githubcopilot.com/mcp/",
    transport: "http",
    signIn: "api-key",
    setup: "Create a personal access token on GitHub with the access your agents should have, and enter it here.",
    setupUrl: "https://github.com/settings/personal-access-tokens",
    icon: "github",
    category: "Development",
  },
  {
    id: "sentry",
    name: "Sentry",
    publisher: "Sentry",
    description: "Look into errors, issues and releases.",
    url: "https://mcp.sentry.dev/mcp",
    transport: "http",
    signIn: "oauth",
    icon: "sentry",
    category: "Development",
  },
  {
    id: "atlassian",
    name: "Atlassian",
    publisher: "Atlassian",
    description: "Search and update Jira issues and Confluence pages.",
    url: "https://mcp.atlassian.com/v1/mcp",
    transport: "http",
    signIn: "oauth",
    icon: "atlassian",
    category: "Business",
  },
  {
    id: "asana",
    name: "Asana",
    publisher: "Asana",
    description: "Work with tasks, projects and goals.",
    url: "https://mcp.asana.com/sse",
    transport: "sse",
    signIn: "oauth",
    icon: "asana",
    category: "Business",
  },
  {
    id: "stripe",
    name: "Stripe",
    publisher: "Stripe",
    description: "Customers, payments, invoices and Stripe's documentation.",
    url: "https://mcp.stripe.com",
    transport: "http",
    signIn: "oauth",
    icon: "stripe",
    category: "Business",
  },
  {
    id: "vercel",
    name: "Vercel",
    publisher: "Vercel",
    description: "Projects, deployments and their logs.",
    url: "https://mcp.vercel.com",
    transport: "http",
    signIn: "oauth",
    icon: "vercel",
    category: "Development",
  },
  {
    id: "supabase",
    name: "Supabase",
    publisher: "Supabase",
    description: "Databases, tables, migrations and edge functions.",
    url: "https://mcp.supabase.com/mcp",
    transport: "http",
    signIn: "oauth",
    icon: "supabase",
    category: "Development",
  },
  {
    id: "cloudflare-docs",
    name: "Cloudflare Docs",
    publisher: "Cloudflare",
    description: "Answers from Cloudflare's documentation.",
    url: "https://docs.mcp.cloudflare.com/mcp",
    transport: "http",
    signIn: "none",
    icon: "cloudflare",
    category: "Knowledge",
  },
  {
    id: "hugging-face",
    name: "Hugging Face",
    publisher: "Hugging Face",
    description: "Search models, datasets, Spaces and papers.",
    url: "https://huggingface.co/mcp",
    transport: "http",
    signIn: "none",
    icon: "huggingface",
    category: "Knowledge",
  },
  {
    id: "context7",
    name: "Context7",
    publisher: "Upstash",
    description: "Current documentation and code examples for libraries.",
    url: "https://mcp.context7.com/mcp",
    transport: "http",
    signIn: "none",
    icon: "context7",
    category: "Knowledge",
  },
  {
    id: "deepwiki",
    name: "DeepWiki",
    publisher: "Cognition",
    description: "Ask questions about public GitHub repositories.",
    url: "https://mcp.deepwiki.com/mcp",
    transport: "http",
    signIn: "none",
    icon: "deepwiki",
    category: "Knowledge",
  },
  {
    id: "intercom",
    name: "Intercom",
    publisher: "Intercom",
    description: "Search conversations, contacts and help articles.",
    url: "https://mcp.intercom.com/mcp",
    transport: "http",
    signIn: "oauth",
    icon: "intercom",
    category: "Business",
  },
  {
    id: "paypal",
    name: "PayPal",
    publisher: "PayPal",
    description: "Invoices, orders, payments and disputes.",
    url: "https://mcp.paypal.com/mcp",
    transport: "http",
    signIn: "oauth",
    icon: "paypal",
    category: "Business",
  },
];

export function catalogEntry(id: string | undefined): ConnectorCatalogEntry | undefined {
  return id ? CONNECTOR_CATALOG.find((entry) => entry.id === id) : undefined;
}
