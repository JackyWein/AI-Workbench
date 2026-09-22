#!/usr/bin/env node
/*
 * Replays what `claude auth status` printed on a machine with Claude Code
 * installed, so the profile's sign-in probe is exercised against the tool's
 * real output shape without spending any quota.
 *
 * `--logged-out` gives the same document with the flag flipped.
 */
const args = process.argv.slice(2);
const wants = args.includes("auth") && args.includes("status");
if (!wants) {
  process.stderr.write("usage: claude auth status\n");
  process.exit(1);
}

process.stdout.write(
  `${JSON.stringify(
    {
      loggedIn: !args.includes("--logged-out"),
      authMethod: "oauth_token",
      apiProvider: "firstParty",
      analyticsDisabled: false,
      projectsDirectory: "/root/.claude/projects",
      configDirectory: "/root/.claude",
    },
    null,
    2,
  )}\n`,
);
