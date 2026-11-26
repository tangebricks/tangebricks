// UC3.2 generator. Run: node scripts/generate-pack-responses.ts   (needs `pnpm fidelity:fetch` first)
// Copies the top-level response shape the importer extracts from the pinned
// upstream corpus specs into the hand-trimmed pack fixtures, so pack ops carry response schemas.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractGoogleDiscoveryOperations,
  extractOpenApi3Operations,
  parseSpecDocument,
  sanitizeOperationId,
} from "../packages/integrations/src/importer.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Outputs kept per op, chosen so every pack op stays within the 250-token get_node budget.
const DEFAULT_CAP = 4;
const PACK_CAPS: Record<string, number> = { github: 3, google: 2 };
let CURRENT = "";

function load(path: string): Record<string, unknown> {
  return parseSpecDocument(readFileSync(path, "utf8"));
}

function schemaFor(dataType: string): Record<string, unknown> {
  if (dataType === "array") return { type: "array", items: {} };
  return { type: dataType };
}

function nestedErrorSchema(shape: Record<string, string | undefined>): Record<string, unknown> {
  const root: Record<string, any> = { type: "object", properties: {} };
  for (const path of [shape.codePath, shape.messagePath, shape.typePath]) {
    if (!path) continue;
    const parts = path.split(".");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      node.properties ??= {};
      if (i === parts.length - 1) node.properties[part] = { type: "string" };
      else {
        node.properties[part] ??= { type: "object", properties: {} };
        node = node.properties[part];
      }
    }
  }
  return root;
}

const packs = ["stripe", "github", "discord", "slack"] as const;
for (const app of packs) {
  CURRENT = app;
  const dir = `${repo}/integrations/${app}`;
  const curation = JSON.parse(readFileSync(`${dir}/curation.config.json`, "utf8"));
  const upstream = load(`${repo}/corpus/real-specs/.cache/${curation.upstream.corpusSpec}.json`);
  const upOps = extractOpenApi3Operations(upstream as any);
  const fixturePath = `${dir}/openapi.json`;
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  let changed = 0;
  for (const [packOp, upId] of Object.entries<string>(curation.upstream.operationIds)) {
    const up = upOps.get(upId) ?? upOps.get(sanitizeOperationId(upId));
    if (!up) { console.log(app, packOp, "NO UPSTREAM", upId); continue; }
    for (const item of Object.values<any>(fixture.paths)) {
      for (const op of Object.values<any>(item)) {
        if (op?.operationId !== packOp) continue;
        const outs = (up.response.outputs ?? []).slice(0, (PACK_CAPS[CURRENT] ?? DEFAULT_CAP));
        const responses: Record<string, unknown> = {};
        const status = up.response.status;
        if (outs.length > 0) {
          responses[String(status ?? 200)] = {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: Object.fromEntries(outs.map((o: any) => [o.id, schemaFor(o.dataType)])),
                },
              },
            },
          };
        } else if (status === 204 || status === 205) {
          responses[String(status)] = { description: "No content" };
        } else {
          responses["200"] = { description: "OK" };
        }
        if (up.response.errorShape) {
          responses.default = {
            description: "Error",
            content: { "application/json": { schema: nestedErrorSchema(up.response.errorShape as any) } },
          };
        }
        op.responses = responses;
        changed++;
        console.log(app, packOp, "outputs:", outs.map((o: any) => o.id).join(","), "| err:", JSON.stringify(up.response.errorShape ?? null));
      }
    }
  }
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + "\n");
  console.log(app, "changed", changed);
}

// Google (Discovery)
CURRENT = "google";
const googleDir = `${repo}/integrations/google`;
const gCuration = JSON.parse(readFileSync(`${googleDir}/curation.config.json`, "utf8"));
const docs = ["google-calendar", "google-drive", "google-gmail", "google-sheets"].map((n) =>
  load(`${repo}/corpus/real-specs/.cache/${n}.json`),
);
const upOps = new Map<string, any>();
const rawRefs = new Map<string, string>();
for (const doc of docs) {
  for (const [k, v] of extractGoogleDiscoveryOperations(doc as any)) upOps.set(k, v);
  const walk = (r: any) => {
    for (const m of Object.values<any>(r.methods ?? {})) {
      if (typeof m.id === "string" && m.response?.$ref) rawRefs.set(sanitizeOperationId(m.id.replace(/\./g, "_")), m.response.$ref);
    }
    for (const sub of Object.values<any>(r.resources ?? {})) walk(sub);
  };
  walk(doc);
}
const gFixturePath = `${googleDir}/discovery.json`;
const gFixture = JSON.parse(readFileSync(gFixturePath, "utf8"));
gFixture.schemas ??= {};
const methodsById = new Map<string, any>();
const walkF = (r: any) => {
  for (const m of Object.values<any>(r.methods ?? {})) methodsById.set(sanitizeOperationId(String(m.id).replace(/\./g, "_")), m);
  for (const sub of Object.values<any>(r.resources ?? {})) walkF(sub);
};
walkF(gFixture);
for (const [packOp, upId] of Object.entries<string>(gCuration.upstream.operationIds)) {
  const up = upOps.get(upId);
  const ref = rawRefs.get(upId);
  const method = methodsById.get(packOp);
  if (!up || !method) { console.log("google", packOp, "MISSING", !!up, !!method); continue; }
  const outs = (up.response.outputs ?? []).slice(0, (PACK_CAPS[CURRENT] ?? DEFAULT_CAP));
  if (outs.length === 0 || !ref) { console.log("google", packOp, "no outputs / ref", ref); continue; }
  {
    gFixture.schemas[ref] = {
      id: ref,
      type: "object",
      properties: Object.fromEntries(outs.map((o: any) => [o.id, schemaFor(o.dataType)])),
    };
  }
  method.response = { $ref: ref };
  console.log("google", packOp, ref, outs.map((o: any) => o.id).join(","));
}
writeFileSync(gFixturePath, JSON.stringify(gFixture, null, 2) + "\n");
