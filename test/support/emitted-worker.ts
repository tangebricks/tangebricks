// The brick tests that drive an assembled project (out/<project>/, written by global-setup.ts before the workerd tests
// start) load its entry through import.meta.glob, not a static import. out/ is generated and git-ignored, so a static
// import would make `pnpm typecheck` depend on a test run having happened first, and would typecheck generated code.
// The shapes below are what the tests call; each test's glob names one project.

/** The handlers an assembled worker exports, as the tests call them. */
export interface EmittedWorker {
  fetch(request: Request, env?: Record<string, unknown>): Response | Promise<Response>;
  scheduled(controller: unknown, env: Record<string, unknown>, ctx?: unknown): Promise<void>;
  queue(batch: unknown, env: Record<string, unknown>, ctx?: unknown): Promise<void>;
}

/** An assembled project whose default export is its app alone (fetch only). */
export type EmittedApp = Pick<EmittedWorker, "fetch">;

/**
 * Returns the default export of the one entry an eager `import.meta.glob` matched. Throws, naming the project, when
 * the glob matched nothing (the project was not assembled) or more than one file.
 */
export function emittedEntry<T>(entries: Record<string, unknown>, project: string): T {
  const modules = Object.values(entries);
  const mod = modules[0];
  if (modules.length !== 1 || typeof mod !== "object" || mod === null || !("default" in mod)) {
    throw new Error(`expected one emitted worker entry for out/${project}, found ${modules.length}`);
  }
  return mod.default as T;
}
