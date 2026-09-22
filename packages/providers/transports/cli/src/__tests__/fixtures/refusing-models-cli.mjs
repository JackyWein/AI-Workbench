#!/usr/bin/env node
/*
 * A tool whose model list command answers with a complaint rather than a
 * list — what a CLI does when it is installed but not signed in. The
 * application must report that, not invent models out of the sentence.
 */
process.stdout.write("You are not signed in. Run `agy login` first.\n");
process.exit(0);
