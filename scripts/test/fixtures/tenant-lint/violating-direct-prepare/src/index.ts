interface D1Like {
  prepare(query: string): {
    bind(...args: unknown[]): {
      first<T>(): Promise<T | null>;
    };
  };
}

export async function getT(db: D1Like, id: string) {
  return db.prepare("SELECT * FROM t WHERE id = ?").bind(id).first();
}
