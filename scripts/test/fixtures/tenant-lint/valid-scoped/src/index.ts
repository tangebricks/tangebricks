import { scoped } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";

export async function getT(db: D1Like, workspaceId: string, id: string) {
  return scoped(db, workspaceId).first("t", "id = ?", [id]);
}
