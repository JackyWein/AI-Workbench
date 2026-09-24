import type { AuthStatus } from "@ai-workbench/shared";
import type { AccountResponse } from "./app-server.js";

const CODEX_LOGIN_HINT = "Run `codex login` once in a terminal.";

/**
 * Maps `account/read` onto a sign-in state (spec §14).
 *
 * The account comes from the tool's own store for this configuration home, so
 * it is the same account a turn would use. No account while the tool says it
 * needs an OpenAI sign-in means signing in is required; no account while it
 * does not (a custom model provider with its own key) means the question does
 * not apply.
 */
export function toAuthStatus(response: AccountResponse): AuthStatus {
  const account = response.account;
  if (account === null) {
    return response.requiresOpenaiAuth === false
      ? {
          state: "notApplicable",
          method: "cli",
          detail: "The configured model provider does not use an OpenAI sign-in.",
        }
      : { state: "authenticationRequired", method: "cli", detail: CODEX_LOGIN_HINT };
  }

  switch (account.type) {
    case "chatgpt": {
      const email = account.email?.trim();
      const plan = formatPlan(account.planType);
      return {
        state: "authenticated",
        method: "cli",
        ...(email ? { accountLabel: email } : {}),
        ...(plan === undefined ? {} : { plan }),
      };
    }
    case "apiKey":
      return { state: "authenticated", method: "cli", accountLabel: "API key" };
    case "amazonBedrock":
      return { state: "authenticated", method: "cli", accountLabel: "Amazon Bedrock" };
    default:
      // A sign-in kind this version does not know yet: signed in, as whom is
      // not something we can say.
      return { state: "authenticated", method: "cli" };
  }
}

/** Plan names the way people say them: "plus" -> "Plus", "edu_plus" -> "Edu Plus". */
export function formatPlan(planType: string | null | undefined): string | undefined {
  const raw = planType?.trim();
  if (!raw || raw.toLowerCase() === "unknown") {
    return undefined;
  }
  if (raw.toLowerCase() === "prolite") {
    return "Pro Lite";
  }
  return raw
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}
