import { describe, expect, it } from "vitest";
import {
  assemble,
  computeArtifactHashes,
  computeBuildHash,
  computeCodeHash,
  computeGraphHash,
} from "@poc/assembler";
import type { Blueprint } from "@poc/assembler";
import {
  computeBlueprintBuildHash,
  computeBlueprintCodeHash,
  computeBlueprintGraphHash,
} from "@poc/blueprint";
import { catalog } from "../../assembler/catalog.generated.ts";
import { INVOICE_FLOW_BLUEPRINT } from "../../../test/support/blueprints.ts";
import {
  MockCloudflareControlPlane,
  createByocProvisioner,
} from "../src/index.ts";
import type { DeployTarget } from "../src/index.ts";

describe("Story 5.4 — Deterministic Hash Split & Graph-Only Hot-Apply Path (packages/deploy)", () => {
  it("preserves identical codeHash when only workflows[] or schedule triggers change, plans hot_apply_graphs, and updates D1 without calling putScript", async () => {
    const rev1Blueprint: Blueprint = {
      project: INVOICE_FLOW_BLUEPRINT.project,
      identity: "stub",
      bricks: [...INVOICE_FLOW_BLUEPRINT.bricks],
      entities: structuredClone([...INVOICE_FLOW_BLUEPRINT.entities]),
      workflows: [
        {
          id: "wf-invoice-approval",
          name: "Invoice Approval v1",
          nodes: [
            {
              id: "node-trigger",
              type: "trigger.schedule",
              data: { cron: "0 * * * *" },
            },
            {
              id: "node-code",
              type: "core.code",
              data: { code: "return { approved: true, version: 1 };" },
            },
          ],
          edges: [
            {
              id: "edge-1",
              source: "node-trigger",
              target: "node-code",
            },
          ],
        },
      ],
    };

    const rev2Blueprint: Blueprint = {
      ...structuredClone(rev1Blueprint),
      workflows: [
        {
          id: "wf-invoice-approval",
          name: "Invoice Approval v2",
          nodes: [
            {
              id: "node-trigger",
              type: "trigger.schedule",
              data: { cron: "*/15 * * * *" },
            },
            {
              id: "node-code",
              type: "core.code",
              data: { code: "return { approved: true, version: 2, fastTrack: true };" },
            },
          ],
          edges: [
            {
              id: "edge-1",
              source: "node-trigger",
              target: "node-code",
            },
          ],
        },
      ],
    };

    // 1. Verify @poc/blueprint deterministic hash split
    const bpCodeHash1 = computeBlueprintCodeHash(rev1Blueprint);
    const bpCodeHash2 = computeBlueprintCodeHash(rev2Blueprint);
    const bpGraphHash1 = computeBlueprintGraphHash(rev1Blueprint);
    const bpGraphHash2 = computeBlueprintGraphHash(rev2Blueprint);
    const bpBuildHash1 = computeBlueprintBuildHash(rev1Blueprint, "1.0.0");
    const bpBuildHash2 = computeBlueprintBuildHash(rev2Blueprint, "1.0.0");

    expect(bpCodeHash1).toBe(bpCodeHash2);
    expect(bpGraphHash1).not.toBe(bpGraphHash2);
    expect(bpBuildHash1).not.toBe(bpBuildHash2);

    // 2. Verify @poc/assembler deterministic hash split on emitted files
    const assembled1 = assemble(rev1Blueprint, catalog);
    const assembled2 = assemble(rev2Blueprint, catalog);
    expect(assembled1.ok).toBe(true);
    expect(assembled2.ok).toBe(true);
    if (!assembled1.ok || !assembled2.ok) return;

    const hashes1 = await computeArtifactHashes(assembled1.files, {
      catalogVersion: "1.0.0",
    });
    const hashes2 = await computeArtifactHashes(assembled2.files, {
      catalogVersion: "1.0.0",
    });

    expect(hashes1.codeHash).toBe(hashes2.codeHash);
    expect(hashes1.graphHash).not.toBe(hashes2.graphHash);
    expect(hashes1.buildHash).not.toBe(hashes2.buildHash);

    expect(await computeCodeHash(assembled1.files)).toBe(hashes1.codeHash);
    expect(
      await computeGraphHash(assembled1.files, { schedules: ["0 * * * *"] }),
    ).not.toBe(
      await computeGraphHash(assembled2.files, { schedules: ["*/15 * * * *"] }),
    );
    expect(await computeBuildHash(hashes1.codeHash, hashes1.graphHash, "1.0.0")).toBe(
      hashes1.buildHash,
    );

    // 3. Deploy rev1 to preview via provisioner
    const ACCOUNT_ID = "fedcba9876543210fedcba9876543210";
    const TOKEN_REF = "tok_hot_apply_test_01";

    const controlPlane = new MockCloudflareControlPlane();
    controlPlane.registerToken({
      token: "cf_valid_hot_apply_token_5678",
      accountId: ACCOUNT_ID,
      accountName: "Hot Apply Test Account",
    });

    const provisioner = createByocProvisioner({
      apiClient: controlPlane,
      resolveToken: async () => "cf_valid_hot_apply_token_5678",
    });

    const target: DeployTarget = {
      type: "byoc",
      accountId: ACCOUNT_ID,
      tokenRef: TOKEN_REF,
      envName: "preview",
    };

    const rev1Deploy = await provisioner.apply({
      target,
      project: "invoice-flow",
      actor: "usr_alice",
      deployId: "dep_rev1",
      buildHash: hashes1.buildHash,
      codeHash: hashes1.codeHash,
      graphHash: hashes1.graphHash,
      bundle: {
        code: assembled1.files["src/index.ts"] ?? "export default {};",
        sha256: hashes1.codeHash,
      },
      migrations: [],
      queues: [],
      cronTriggers: ["0 * * * *"],
      workflows: [{ name: "wf-invoice-approval", className: "GraphRunner" }],
      graphs: {
        "wf-invoice-approval": JSON.stringify(rev1Blueprint.workflows?.[0]),
      },
      schedules: ["0 * * * *"],
    });

    expect(rev1Deploy.action).toBe("create");
    expect(rev1Deploy.rebuiltWorker).toBe(true);
    expect(controlPlane.scriptUploadCount).toBe(1);
    const initialVersionId = rev1Deploy.versionId;

    // 4. Plan rev2 -> codeHash matches, graphHash differs -> action is "hot_apply_graphs"
    const rev2Plan = await provisioner.plan({
      target,
      project: "invoice-flow",
      buildHash: hashes2.buildHash,
      codeHash: hashes2.codeHash,
      graphHash: hashes2.graphHash,
      bundle: {
        code: assembled2.files["src/index.ts"] ?? "export default {};",
        sha256: hashes2.codeHash,
      },
      migrations: [],
      queues: [],
      cronTriggers: ["*/15 * * * *"],
      workflows: [{ name: "wf-invoice-approval", className: "GraphRunner" }],
    });

    expect(rev2Plan.action).toBe("hot_apply_graphs");
    expect(rev2Plan.noChanges).toBe(false);

    // 5. Apply rev2 -> updates D1 graphs & schedules directly without calling putScript
    const rev2Apply = await provisioner.apply(target, rev2Plan, {
      project: "invoice-flow",
      actor: "usr_alice",
      deployId: "dep_rev2_hot",
      buildHash: hashes2.buildHash,
      codeHash: hashes2.codeHash,
      graphHash: hashes2.graphHash,
      bundle: {
        code: assembled2.files["src/index.ts"] ?? "export default {};",
        sha256: hashes2.codeHash,
      },
      migrations: [],
      queues: [],
      cronTriggers: ["*/15 * * * *"],
      workflows: [{ name: "wf-invoice-approval", className: "GraphRunner" }],
      graphs: {
        "wf-invoice-approval": JSON.stringify(rev2Blueprint.workflows?.[0]),
      },
      schedules: ["*/15 * * * *"],
    });

    expect(rev2Apply.action).toBe("hot_apply_graphs");
    expect(rev2Apply.liveWithoutRedeploy).toBe(true);
    expect(rev2Apply.rebuiltWorker).toBe(false);
    expect(rev2Apply.versionId).toBe(initialVersionId);
    // Worker script was NOT uploaded a second time
    expect(controlPlane.scriptUploadCount).toBe(1);

    const dbSnapAfterApply = controlPlane.inspectDatabase(
      ACCOUNT_ID,
      "px-invoice-flow-preview-db",
    );
    expect(dbSnapAfterApply?.graphs["wf-invoice-approval"]?.graph).toContain(
      "fastTrack",
    );
    expect(dbSnapAfterApply?.schedules).toEqual([
      { id: "sched_1", cron_expression: "*/15 * * * *", active: 1 },
    ]);

    // 6. Also verify direct provisioner.putGraph(target, graphs, schedules) signature
    const directPutGraph = await provisioner.putGraph(
      target,
      {
        "wf-invoice-approval": JSON.stringify({
          ...(rev2Blueprint.workflows?.[0] as Record<string, unknown> | undefined),
          name: "Invoice Approval v3 Direct",
        }),
      },
      ["*/5 * * * *"],
      {
        project: "invoice-flow",
        actor: "usr_alice",
        graphHash: "sha256_graph_v3_direct",
      },
    );

    expect(directPutGraph.graphIds).toEqual(["wf-invoice-approval"]);
    expect(directPutGraph.schedulesUpdatedCount).toBe(1);
    expect(directPutGraph.rebuiltWorker).toBe(false);
    expect(directPutGraph.liveWithoutRedeploy).toBe(true);
    expect(controlPlane.scriptUploadCount).toBe(1);
  });
});
