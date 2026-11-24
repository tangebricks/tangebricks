// Vite helpers the tests rely on, declared here because pnpm does not expose vite's own types to these packages.
declare module "*?raw" {
  const text: string;
  export default text;
}

interface ImportMeta {
  glob(
    patterns: string | string[],
    options: { query?: string; import?: string; eager: true },
  ): Record<string, unknown>;
  glob(
    patterns: string | string[],
    options?: { query?: string; import?: string; eager?: false },
  ): Record<string, () => Promise<unknown>>;
}

// The Workers runtime's global env, importable by any code in the isolate. Used by H3 to show what that allows.
declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
}
