interface D1Like {
  prepare(query: string): {
    all<T>(): Promise<{ results: T[] }>;
  };
}

export async function queryT(db: D1Like, status: string) {
  return db.prepare(`SELECT * FROM t WHERE status = '${status}'`).all();
}
