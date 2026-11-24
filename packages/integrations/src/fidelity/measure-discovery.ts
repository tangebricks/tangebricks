import { extractGoogleDiscoveryOperations } from "../importer.ts";
import { isObject, sanitizeIdentifier } from "./measure-util.ts";
import type { MeasureContext, ExtractedOps } from "./measure-types.ts";

/** Replays the Google Discovery methods of a spec against the known defect classes. */
export function measureDiscoveryOps(ctx: MeasureContext): ExtractedOps {
  const { flag, rawDocs } = ctx;
  let specOps = 0;
  // Google Discovery
  const extracted = extractGoogleDiscoveryOperations({ apis: rawDocs });
  const seenIds = new Set<string>();

  for (const doc of rawDocs) {
    const visit = (res: any) => {
      for (const r of Object.values<any>(res ?? {})) {
        for (const mv of Object.values<any>(r.methods ?? {})) {
          specOps++;
          const key = mv.id;
          const id = sanitizeIdentifier(mv.id)
            .replace(/_+/g, "_")
            .replace(/^_|_$/g, "");

          if (seenIds.has(id)) {
            flag("op_id_collision_overwrites", key, { sanitizedId: id });
          }
          seenIds.add(id);

          const hm = (mv.httpMethod ?? "GET").toUpperCase();
          if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(hm)) {
            flag("op_method_coerced_to_GET", key, { method: hm });
          }

          const rp = mv.flatPath ?? mv.path;
          const ph = [...String(rp).matchAll(/\{\+?([^}]+)\}/g)].map((x) => x[1] ?? "");
          const declared = Object.entries<any>(mv.parameters ?? {});
          const pathDecl = declared
            .filter(([, v]) => v.location === "path")
            .map(([k]) => k);

          if (ph.some((x) => !pathDecl.includes(x)) || pathDecl.some((x) => !ph.includes(x))) {
            flag("path_placeholder_vs_declared_param_mismatch(flatPath)", key, {
              flatPath: mv.flatPath,
              path: mv.path,
              declared: pathDecl,
            });
          }

          if (mv.flatPath && mv.flatPath !== mv.path) {
            flag("flatPath_used_over_path(info)", key, {
              flatPath: mv.flatPath,
              path: mv.path,
            });
          }

          for (const [k, v] of declared) {
            if (sanitizeIdentifier(k) !== k) {
              flag("path_query_name_altered", key, { src: k, gen: sanitizeIdentifier(k) });
            }
            if (Array.isArray(v.enum) && v.enum.length > 256) {
              flag("enum_or_default_lost", key, {
                name: k,
                enum: v.enum?.slice(0, 4),
                default: v.default,
              });
            }
          }

          if (mv.request && hm !== "GET") {
            const importedOp = extracted.get(id) ?? extracted.get(key);
            const importedFields = importedOp?.body?.fields;
            const actualImportedCount = Array.isArray(importedFields)
              ? importedFields.length
              : undefined;
            const fieldMap = new Map((importedFields ?? []).map((f: any) => [f.name, f]));

            const rs = mv.request.$ref ? doc.schemas?.[mv.request.$ref] : mv.request;
            const props = Object.entries<any>(rs?.properties ?? {});
            if (props.length === 0) {
              if (!importedOp?.body?.root || importedOp.body.root.dataType !== "object") {
                flag("body_no_properties_dropped(free-form)", key);
              }
            }
            const isCapped =
              actualImportedCount !== undefined
                ? props.length > actualImportedCount
                : props.length > 5;
            if (isCapped) {
              flag("body_fields_dropped_by_5_cap", key, {
                total: props.length,
                dropped: props.slice(5, 9).map((x) => x[0]),
              });
            }
            const propsToInspect = ctx.options?.allFields ? props : props.slice(0, 5);
            propsToInspect.forEach(([n, s]: [string, any]) => {
              const cleanN = sanitizeIdentifier(n);
              const importedField = fieldMap.get(cleanN);

              if (s.$ref) {
                if (!importedField?.schema?.properties) {
                  flag("body_ref_prop_typed_string(no deref in discovery path)", key, {
                    field: n,
                    ref: s.$ref,
                  });
                }
              }
              const it = s.items;
              const target = s.$ref ? doc.schemas?.[s.$ref] : s;
              const hasNestedInSpec =
                Boolean(target?.properties) ||
                (s.type === "array" &&
                  (it?.$ref || it?.type === "object" || Boolean(it?.properties)));

              if (hasNestedInSpec) {
                const preserved =
                  Boolean(importedField?.schema?.properties) ||
                  Boolean(importedField?.schema?.items);
                if (!preserved) {
                  flag("body_nested_structure_flattened", key, {
                    field: n,
                    type: s.type,
                    items: it,
                  });
                }
              }
              if (s.enum || s.default !== undefined) {
                const preservedEnumOrDefault =
                  importedField?.schema?.enum !== undefined ||
                  importedField?.schema?.default !== undefined;
                if (!preservedEnumOrDefault) {
                  flag("enum_or_default_lost", key, { field: n });
                }
              }
            });
          }

          if (mv.supportsMediaUpload) {
            flag("media_upload_ignored", key);
          }
          if (mv.response) {
            flag("response_schema_ignored", key);
            if (typeof mv.response.$ref === "string") {
              const schemaObj = (doc.schemas as any)?.[mv.response.$ref];
              if (schemaObj && isObject(schemaObj.properties) && schemaObj.properties.nextPageToken) {
                flag("pagination_unmodelled", key);
              }
            }
          }
          if (mv.scopes?.length) {
            // Discovery OAuth2 scopes are read and mapped in UC3.3
          }
        }
        visit(r.resources);
      }
    };
    visit(doc.resources);
  }
  return { extracted, specOps };
}
