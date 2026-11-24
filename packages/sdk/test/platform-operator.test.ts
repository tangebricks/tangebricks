import { describe, expect, it } from "vitest";
import {
  WORKSPACE_ADMIN_ROLES,
  WORKSPACE_OWNER_ROLES,
  isPlatformOperator,
  platformOperatorIds,
  platformOperatorRefusal,
  workspaceRoleRefusal,
} from "../src/index.ts";

describe("isPlatformOperator (story 0.6)", () => {
  it("accepts a user id listed in PX_PLATFORM_OPERATORS", () => {
    const env = { PX_PLATFORM_OPERATORS: "op-1, op-2 ,op-3" };
    expect(isPlatformOperator(env, "op-1")).toBe(true);
    expect(isPlatformOperator(env, "op-2")).toBe(true);
    expect(isPlatformOperator(env, "op-3")).toBe(true);
  });

  it("refuses a user id that is not listed, including prefixes and substrings", () => {
    const env = { PX_PLATFORM_OPERATORS: "op-1,op-2" };
    expect(isPlatformOperator(env, "op")).toBe(false);
    expect(isPlatformOperator(env, "op-12")).toBe(false);
    expect(isPlatformOperator(env, "op-1,op-2")).toBe(false);
  });

  it("fails closed when the env var is unset, empty or not a string (NO_OPERATORS_CONFIGURED)", () => {
    expect(isPlatformOperator({}, "op-1")).toBe(false);
    expect(isPlatformOperator(undefined, "op-1")).toBe(false);
    expect(isPlatformOperator(null, "op-1")).toBe(false);
    expect(isPlatformOperator({ PX_PLATFORM_OPERATORS: "" }, "op-1")).toBe(false);
    expect(isPlatformOperator({ PX_PLATFORM_OPERATORS: " , ," }, "")).toBe(false);
    expect(isPlatformOperator({ PX_PLATFORM_OPERATORS: ["op-1"] }, "op-1")).toBe(false);
    expect(platformOperatorIds({ PX_PLATFORM_OPERATORS: " , ," })).toEqual([]);
  });

  it("refuses a missing user id", () => {
    const env = { PX_PLATFORM_OPERATORS: "op-1" };
    expect(isPlatformOperator(env, undefined)).toBe(false);
    expect(isPlatformOperator(env, null)).toBe(false);
    expect(isPlatformOperator(env, "")).toBe(false);
  });
});

describe("workspaceRoleRefusal / platformOperatorRefusal (story 0.6)", () => {
  const ctx = (role: string) => Object.freeze({ userId: "u1", workspaceId: "ws1", role });

  it("401 with no user and no context; 403 with a user but no verified context", () => {
    expect(workspaceRoleRefusal(undefined, undefined, WORKSPACE_ADMIN_ROLES)?.status).toBe(401);
    expect(workspaceRoleRefusal({ uid: "u1" }, undefined, WORKSPACE_ADMIN_ROLES)?.status).toBe(403);
  });

  it("checks the role from the verified context only", () => {
    expect(workspaceRoleRefusal({ uid: "u1" }, ctx("member"), WORKSPACE_ADMIN_ROLES)?.status).toBe(403);
    expect(workspaceRoleRefusal({ uid: "u1" }, ctx("admin"), WORKSPACE_ADMIN_ROLES)).toBeUndefined();
    expect(workspaceRoleRefusal({ uid: "u1" }, ctx("owner"), WORKSPACE_ADMIN_ROLES)).toBeUndefined();
    expect(workspaceRoleRefusal({ uid: "u1" }, ctx("admin"), WORKSPACE_OWNER_ROLES)?.status).toBe(403);
    expect(workspaceRoleRefusal({ uid: "u1" }, ctx("owner"), WORKSPACE_OWNER_ROLES)).toBeUndefined();
    // A role claimed on the user object is never read.
    expect(workspaceRoleRefusal({ uid: "u1", roles: ["owner"], role: "owner" }, ctx("member"), WORKSPACE_OWNER_ROLES)?.status).toBe(403);
  });

  it("operator: 401 with no user, 403 for a workspace owner not listed, allowed when listed or by the extra source", async () => {
    const env = { PX_PLATFORM_OPERATORS: "op" };
    expect((await platformOperatorRefusal(env, undefined, undefined))?.status).toBe(401);
    expect((await platformOperatorRefusal(env, { uid: "u1" }, ctx("owner")))?.status).toBe(403);
    expect((await platformOperatorRefusal({}, { uid: "op" }, undefined))?.status).toBe(403);
    expect(await platformOperatorRefusal(env, { uid: "op" }, undefined)).toBeUndefined();
    expect(await platformOperatorRefusal({}, { uid: "u1" }, ctx("member"), async (id) => id === "u1")).toBeUndefined();
    expect((await platformOperatorRefusal({}, { uid: "u2" }, undefined, async (id) => id === "u1"))?.status).toBe(403);
    // An empty ctx.userId falls back to the session user (same rule as the oauth-server route).
    expect(await platformOperatorRefusal(env, { uid: "op" }, Object.freeze({ userId: "", workspaceId: "ws1", role: "member" }))).toBeUndefined();
  });
});
