/*
 * Facts about this build, fixed when it was made (electron.vite.config.ts).
 * Read defensively, so tests and tools that load this file without the build
 * step still get an answer: no commit, not signed.
 */
declare const __BUILD_COMMIT__: string | undefined;
declare const __SIGNED_MAC__: boolean | undefined;

/** The commit this build was made from; empty when it is not known. */
export const BUILD_COMMIT: string = typeof __BUILD_COMMIT__ === "string" ? __BUILD_COMMIT__ : "";

/** True for a Mac build signed with a Developer ID, which may update itself. */
export const SIGNED_MAC: boolean = typeof __SIGNED_MAC__ === "boolean" ? __SIGNED_MAC__ : false;
