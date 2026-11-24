import { assemble } from "@poc/assembler";
import type { BrickManifestFile, Catalog } from "@poc/assembler";
import { validateGraph } from "@poc/sdk";
import type { Registry } from "@poc/sdk";
import { buildCatalogNodeRegistry } from "./apply.ts";
import { toAssemblerBlueprint } from "./schema.ts";
import type { BlueprintState } from "./schema.ts";

export interface ReadinessNeed {
  code: string;
  path: string;
  message: string;
  suggestedFix?: string;
}

export interface ReadinessResult {
  ready: boolean;
  needs: ReadinessNeed[];
}

const IDENTITY_CAPABILITY = "user-identity";

function takesEntities(manifest: BrickManifestFile): boolean {
  return manifest.worker.routes.some((route) =>
    Object.values(route.options).some((v) => typeof v === "object" && "$entities" in v),
  );
}

export function computeReadiness(
  state: BlueprintState,
  catalog: Catalog,
  nodeRegistry: Registry = buildCatalogNodeRegistry(catalog),
): ReadinessResult {
  const needs: ReadinessNeed[] = [];
  const available = Object.keys(catalog.bricks).sort();

  if (state.bricks.length === 0) {
    needs.push({
      code: "NO_BRICKS_ENABLED",
      path: "bricks",
      message: "no brick is enabled yet",
      suggestedFix: "Enable at least one brick using enable_brick",
    });
  }

  const chosen = state.bricks
    .map((b) => {
      const entry = catalog.bricks[b.id];
      return entry ? { id: b.id, manifest: entry.manifest, config: b.config } : null;
    })
    .filter((b): b is NonNullable<typeof b> => b !== null);

  for (const b of state.bricks) {
    if (!catalog.bricks[b.id]) {
      needs.push({
        code: "UNKNOWN_BRICK",
        path: `bricks.${b.id}`,
        message: `unknown brick "${b.id}" (available: ${available.join(", ") || "none"})`,
        suggestedFix: `Remove unknown brick "${b.id}" or replace with a valid catalog brick`,
      });
    }
  }

  // 1. Capability providers and requirements
  const providerOf = new Map<string, string>();
  for (const brick of chosen) {
    for (const cap of brick.manifest.provides) {
      const existing = providerOf.get(cap);
      if (existing) {
        needs.push({
          code: "DUPLICATE_CAPABILITY_PROVIDER",
          path: `bricks.${brick.id}.provides.${cap}`,
          message: `"${cap}" is provided by both ${existing} and ${brick.id}; enable only one`,
          suggestedFix: `Remove either "${existing}" or "${brick.id}"`,
        });
      } else {
        providerOf.set(cap, brick.id);
      }
    }
  }

  for (const brick of chosen) {
    for (const req of brick.manifest.requires) {
      if (providerOf.has(req)) continue;
      const offers = available.filter((id) =>
        catalog.bricks[id]!.manifest.provides.includes(req),
      );
      needs.push({
        code: "MISSING_CAPABILITY_PROVIDER",
        path: `bricks.${brick.id}.requires.${req}`,
        message: `${brick.id} requires "${req}", which no enabled brick provides${offers.length > 0 ? ` (enable one of: ${offers.join(", ")})` : ""}`,
        suggestedFix:
          offers.length > 0
            ? `Enable one of: ${offers.join(", ")}`
            : `Enable a brick that provides "${req}"`,
      });
    }
  }

  // 2. Identity brick checks
  if (state.identity !== "stub") {
    const enabledIdentity = chosen.find((b) => b.id === state.identity);
    const catalogIdentity = catalog.bricks[state.identity];
    if (!enabledIdentity) {
      needs.push({
        code: "MISSING_IDENTITY_BRICK",
        path: "identity",
        message: `identity "${state.identity}" requires brick "${state.identity}" to be enabled in bricks`,
        suggestedFix: `Enable brick "${state.identity}" with enable_brick or set identity to "stub"`,
      });
    } else if (!enabledIdentity.manifest.provides.includes(IDENTITY_CAPABILITY)) {
      needs.push({
        code: "INVALID_IDENTITY_BRICK",
        path: "identity",
        message: `identity "${state.identity}" does not provide "${IDENTITY_CAPABILITY}"`,
        suggestedFix: `Set identity to "stub", "core-auth", or a brick that provides "${IDENTITY_CAPABILITY}"`,
      });
    } else if (
      !enabledIdentity.manifest.worker.guard ||
      enabledIdentity.manifest.worker.guard.capability !== IDENTITY_CAPABILITY
    ) {
      needs.push({
        code: "INVALID_IDENTITY_BRICK",
        path: "identity",
        message: `identity "${state.identity}" must declare a worker.guard for "${IDENTITY_CAPABILITY}"`,
        suggestedFix: `Use a brick that exports a worker.guard for "${IDENTITY_CAPABILITY}"`,
      });
    } else if (!catalogIdentity) {
      needs.push({
        code: "MISSING_IDENTITY_BRICK",
        path: "identity",
        message: `unknown identity brick "${state.identity}"`,
        suggestedFix: `Set identity to "stub" or "core-auth"`,
      });
    }
  }

  // 3. Entity handler checks
  if (state.entities.length > 0) {
    const handlers = chosen.filter((b) => takesEntities(b.manifest));
    if (handlers.length === 0) {
      const offers = available.filter((id) => takesEntities(catalog.bricks[id]!.manifest));
      needs.push({
        code: "MISSING_ENTITY_HANDLER",
        path: "entities",
        message: `entities are declared but no enabled brick handles them${offers.length > 0 ? ` (enable one of: ${offers.join(", ")})` : ""}`,
        suggestedFix:
          offers.length > 0
            ? `Enable one of: ${offers.join(", ")}`
            : "Enable a brick that serves dynamic entities",
      });
    } else if (handlers.length > 1) {
      needs.push({
        code: "MULTIPLE_ENTITY_HANDLERS",
        path: "entities",
        message: `${handlers.map((b) => b.id).join(" and ")} both handle entities; enable only one`,
        suggestedFix: `Keep only one entity-serving brick enabled`,
      });
    }
  }

  // 4. Required brick secrets check
  for (const brick of chosen) {
    for (const secretName of brick.manifest.secrets ?? []) {
      const isBound = state.secretRefs.some(
        (s) =>
          s.targetKind === "brick" &&
          s.targetId === brick.id &&
          s.secretName === secretName &&
          s.ref.length > 0,
      );
      if (!isBound) {
        needs.push({
          code: "UNBOUND_BRICK_SECRET",
          path: `bricks.${brick.id}.secrets.${secretName}`,
          message: `brick "${brick.id}" requires secret "${secretName}" to be bound`,
          suggestedFix: `Bind secret "${secretName}" for brick "${brick.id}" using bind_secret_ref`,
        });
      }
    }
  }

  // 5. Workflow graph readiness checks
  for (const wf of state.workflows) {
    if (wf.nodes.length === 0) {
      needs.push({
        code: "no_trigger",
        path: `workflows.${wf.id}`,
        message: `workflow "${wf.id}" has no trigger or nodes`,
        suggestedFix: `Add a trigger node to workflow "${wf.id}" or remove the empty workflow`,
      });
      continue;
    }

    const { issues } = validateGraph(wf.nodes, wf.edges, nodeRegistry);
    for (const issue of issues) {
      needs.push({
        code: issue.code,
        path: issue.nodeId
          ? `workflows.${wf.id}.nodes.${issue.nodeId}`
          : `workflows.${wf.id}`,
        message: `workflow "${wf.id}": ${issue.message}`,
        suggestedFix: `Resolve "${issue.code}" in workflow "${wf.id}"`,
      });
    }

    for (const node of wf.nodes) {
      const connRef = node.data?.connectionRef;
      if (typeof connRef === "string" && connRef.trim().length > 0) {
        const trimmedRef = connRef.trim();
        const isBoundInSecretRefs = state.secretRefs.some((s) => s.ref === trimmedRef);
        if (!isBoundInSecretRefs) {
          needs.push({
            code: "UNBOUND_CONNECTION",
            path: `workflows.${wf.id}.nodes.${node.id}.data.connectionRef`,
            message: `workflow "${wf.id}" node "${node.id}" references connection "${trimmedRef}" which is not bound in secretRefs`,
            suggestedFix: `Bind connection "${trimmedRef}" in Connections Center or via bind_secret_ref`,
          });
        }
      }
    }
  }

  // 6. Dry-run assemble() check for any additional whole-project assembly constraints
  if (state.bricks.length > 0) {
    const assembled = assemble(toAssemblerBlueprint(state), catalog);
    if (!assembled.ok) {
      const existingMessages = new Set(needs.map((n) => n.message));
      for (const err of assembled.errors) {
        if (!existingMessages.has(err)) {
          needs.push({
            code: "ASSEMBLE_CHECK_FAILED",
            path: "project",
            message: err,
            suggestedFix: "Resolve the assembly constraint error before building",
          });
        }
      }
    }
  }

  return {
    ready: needs.length === 0,
    needs,
  };
}
