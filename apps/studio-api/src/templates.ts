import { catalog } from "@poc/assembler/catalog";
import {
  computeReadiness,
  exportBlueprintBundle,
  normalizeBlueprintState,
  semanticHash,
} from "@poc/blueprint";
import type {
  BlueprintBundle,
  BlueprintState,
  ReadinessResult,
} from "@poc/blueprint";
import aiCreditsPreset from "../../../presets/ai-credits-saas.blueprint.json" with { type: "json" };
import b2bPreset from "../../../presets/b2b-workspace-app.blueprint.json" with { type: "json" };
import marketplacePreset from "../../../presets/marketplace.blueprint.json" with { type: "json" };
import stripeDiscordOpsPreset from "../../../presets/stripe-discord-ops.blueprint.json" with { type: "json" };

export const STARTER_TEMPLATE_IDS = [
  "ai-credits-saas",
  "b2b-workspace-app",
  "marketplace",
  "stripe-discord-ops",
] as const;

export type StarterTemplateId = (typeof STARTER_TEMPLATE_IDS)[number];

export interface StarterTemplateDescriptor {
  id: StarterTemplateId;
  name: string;
  description: string;
  maturity: "production";
  bricks: string[];
  entities: string[];
  workflows: string[];
  state: BlueprintState;
  blueprint: BlueprintState;
  bundle: BlueprintBundle;
  readiness: ReadinessResult;
  semanticHash: string;
}

const RAW_PRESETS: Record<StarterTemplateId, Record<string, unknown>> = {
  "ai-credits-saas": aiCreditsPreset as unknown as Record<string, unknown>,
  "b2b-workspace-app": b2bPreset as unknown as Record<string, unknown>,
  marketplace: marketplacePreset as unknown as Record<string, unknown>,
  "stripe-discord-ops": stripeDiscordOpsPreset as unknown as Record<string, unknown>,
};

function coercePresetToBlueprintState(
  raw: Record<string, unknown>,
  projectOverride?: string,
): BlueprintState {
  const bricks = (Array.isArray(raw.bricks) ? raw.bricks : []).map((b) =>
    typeof b === "string"
      ? { id: b, config: {} }
      : {
          id: String((b as { id: unknown }).id),
          config: (b as { config?: Record<string, string | number | boolean> }).config ?? {},
        },
  );
  const entities = (Array.isArray(raw.entities) ? raw.entities : []).map((e) => {
    const ent = e as { name: string; fields: Array<Record<string, unknown>> };
    return {
      name: ent.name,
      workspaceScoped: true as const,
      fields: ent.fields.map((f) => {
        if (f.type === "text") {
          return {
            ...f,
            required: Boolean(f.required ?? false),
            maxLength: typeof f.maxLength === "number" ? f.maxLength : 500,
          };
        }
        return {
          ...f,
          required: Boolean(f.required ?? false),
        };
      }),
    };
  });
  return normalizeBlueprintState({
    schemaVersion: 2,
    project: projectOverride ?? String(raw.project),
    identity: typeof raw.identity === "string" ? raw.identity : "stub",
    bricks,
    entities: entities as BlueprintState["entities"],
    workflows: (Array.isArray(raw.workflows) ? raw.workflows : []) as BlueprintState["workflows"],
    secretRefs: (Array.isArray(raw.secretRefs) ? raw.secretRefs : []) as BlueprintState["secretRefs"],
    metadata: (typeof raw.metadata === "object" && raw.metadata !== null
      ? raw.metadata
      : {}) as BlueprintState["metadata"],
  });
}

function buildTemplateDescriptor(id: StarterTemplateId): StarterTemplateDescriptor {
  const raw = RAW_PRESETS[id];
  const state = coercePresetToBlueprintState(raw);
  const readiness = computeReadiness(state, catalog);
  const bundle = exportBlueprintBundle(state, { revision: 1 });
  return {
    id,
    name: state.metadata?.displayName ?? id,
    description: state.metadata?.description ?? "",
    maturity: "production",
    bricks: state.bricks.map((b) => b.id),
    entities: state.entities.map((e) => e.name),
    workflows: state.workflows.map((w) => w.id),
    state,
    blueprint: state,
    bundle,
    readiness,
    semanticHash: semanticHash(state),
  };
}

export const STARTER_TEMPLATES: Record<StarterTemplateId, StarterTemplateDescriptor> = {
  "ai-credits-saas": buildTemplateDescriptor("ai-credits-saas"),
  "b2b-workspace-app": buildTemplateDescriptor("b2b-workspace-app"),
  marketplace: buildTemplateDescriptor("marketplace"),
  "stripe-discord-ops": buildTemplateDescriptor("stripe-discord-ops"),
};

export function listStarterTemplates(): StarterTemplateDescriptor[] {
  return STARTER_TEMPLATE_IDS.map((id) => STARTER_TEMPLATES[id]);
}

export function getStarterTemplate(templateId: string): StarterTemplateDescriptor | null {
  if (templateId in STARTER_TEMPLATES) {
    return STARTER_TEMPLATES[templateId as StarterTemplateId];
  }
  return null;
}

export function instantiateStarterTemplateForProject(
  templateId: string,
  projectSlug: string,
): {
  templateId: StarterTemplateId;
  state: BlueprintState;
  blueprint: BlueprintState;
  bundle: BlueprintBundle;
  readiness: ReadinessResult;
  semanticHash: string;
} | null {
  if (!(templateId in RAW_PRESETS)) {
    return null;
  }
  const id = templateId as StarterTemplateId;
  const state = coercePresetToBlueprintState(RAW_PRESETS[id], projectSlug);
  const readiness = computeReadiness(state, catalog);
  const bundle = exportBlueprintBundle(state, { revision: 1 });
  return {
    templateId: id,
    state,
    blueprint: state,
    bundle,
    readiness,
    semanticHash: semanticHash(state),
  };
}
