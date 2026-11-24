// The only part of Cloudflare's D1 interface the wallet bricks use, written out so the bricks and their tests
// do not depend on @cloudflare/workers-types. The real D1Database satisfies it.
export interface D1Result<Row = Record<string, unknown>> {
  results: Row[];
  success: boolean;
  meta: { changes: number; [key: string]: unknown };
}

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<Row = Record<string, unknown>>(): Promise<Row | null>;
  run(): Promise<D1Result>;
  all<Row = Record<string, unknown>>(): Promise<D1Result<Row>>;
}

export interface D1Like {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<D1Result[]>;
  exec(sql: string): Promise<unknown>;
}
