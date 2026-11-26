import { extractOpenApi3Operations } from "../importer.ts";
import { dereference, isObject, sanitizeIdentifier } from "./measure-util.ts";
import type { MeasureContext, ExtractedOps } from "./measure-types.ts";

/** Replays the OpenAPI 3 / Swagger 2 operations of a spec against the known defect classes. */
export function measureOpenApiOps(ctx: MeasureContext): ExtractedOps {
  const { flag, notes, spec0 } = ctx;
  let specOps = 0;
  const extracted = extractOpenApi3Operations(spec0);
  const seenIds = new Set<string>();
  const schemes =
    spec0.components?.securitySchemes ?? spec0.securityDefinitions ?? {};
  const globalSec = spec0.security;

  if (spec0.swagger) {
    notes.push(`SPEC IS SWAGGER ${spec0.swagger}`);
  }

  for (const [p, item] of Object.entries<any>(spec0.paths ?? {})) {
    if (!isObject(item)) continue;

    for (const m of ["get", "post", "put", "patch", "delete", "head", "options", "trace"]) {
      const op = item[m];
      if (!isObject(op)) continue;

      specOps++;
      const rawId =
        typeof op.operationId === "string" && op.operationId.trim()
          ? op.operationId
          : `${m}_${p.replace(/[^A-Za-z0-9]+/g, "_")}`;
      const id =
        rawId
          .replace(/[^A-Za-z0-9_]/g, "_")
          .replace(/_+/g, "_")
          .replace(/^_|_$/g, "")
          .slice(0, 64) || "operation";
      const key = `${m} ${p}`;

      if (!["get", "post", "put", "patch", "delete"].includes(m)) {
        flag("op_method_unsupported", key, { method: m });
        continue;
      }

      if (seenIds.has(id)) {
        flag("op_id_collision_overwrites", key, { sanitizedId: id });
      }
      seenIds.add(id);

      const all = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((x: any) =>
        dereference(spec0, x)
      );
      const seen = new Set<string>();

      for (const q of all) {
        const nm = q.name;
        const loc = q.in;
        if (!nm) continue;

        if (!["path", "query", "header"].includes(loc)) {
          flag("param_dropped_location(cookie/formData/body)", key, {
            src: { name: nm, in: loc },
          });
          continue;
        }

        const sanitized = sanitizeIdentifier(nm);
        if (sanitized !== nm) {
          flag(
            loc === "header" ? "header_name_altered" : "path_query_name_altered",
            key,
            { src: nm, gen: sanitized, in: loc }
          );
        }

        if (seen.has(sanitized)) {
          flag("param_dropped_dedup(name collision / op-level override)", key, {
            src: { name: nm, in: loc },
          });
          continue;
        }
        seen.add(sanitized);

        const sc = spec0.swagger ? q : dereference(spec0, q.schema);
        if (
          q.style === "label" ||
          q.style === "matrix"
        ) {
          flag(
            "param_serialization_unhonoured(array/object/style/explode)",
            key,
            { src: { name: nm, in: loc, style: q.style, explode: q.explode, type: sc.type } }
          );
        }

        if (Array.isArray(sc.enum) && sc.enum.length > 256) {
          flag("enum_or_default_lost", key, {
            src: { name: nm, enum: sc.enum?.slice(0, 4), default: sc.default },
          });
        }

        if (!sc.type && (sc.oneOf || sc.anyOf || sc.allOf)) {
          flag("type_erased_to_string(composition)", key, { name: nm });
        }
      }

      for (const mt of p.matchAll(/\{([^}]+)\}/g)) {
        const placeholder = mt[1] ?? "";
        if (!/^[A-Za-z0-9_]+$/.test(placeholder)) {
          flag("path_placeholder_nonidentifier(unsubstitutable)", key, { path: p });
        }
      }

      if (op.requestBody) {
        const rb = dereference(spec0, op.requestBody);
        const content = isObject(rb.content) ? rb.content : {};
        const cts = Object.keys(content);
        const hasJ = cts.includes("application/json");
        const hasF = cts.includes("application/x-www-form-urlencoded");

        if (!hasJ && !hasF && cts.length) {
          flag("body_unsupported_content_type_silent_json_fallback", key, { cts });
        }

        const ct = hasJ
          ? "application/json"
          : hasF
            ? "application/x-www-form-urlencoded"
            : (cts[0] ?? "application/json");
        const mo = content[ct] ?? {};
        const bs = dereference(spec0, mo.schema);
        const props = isObject(bs.properties) ? bs.properties : {};
        const pn = Object.keys(props);

        let importedOp = extracted.get(id);
        const normP = p.startsWith("/") ? p : `/${p}`;
        const normM = m.toUpperCase();
        if (!importedOp || importedOp.path !== normP || importedOp.method !== normM) {
          importedOp = undefined;
          for (const opVal of extracted.values()) {
            if (opVal.path === normP && opVal.method === normM) {
              importedOp = opVal;
              break;
            }
          }
        }
        const importedFields =
          importedOp?.body?.fields ??
          (importedOp?.body?.root?.schema?.properties
            ? Object.entries(importedOp.body.root.schema.properties).map(([name, schema]) => ({
                name,
                schema,
              }))
            : undefined);
        const actualImportedCount = Array.isArray(importedFields)
          ? importedFields.length
          : undefined;

        if (bs.allOf || bs.oneOf || bs.anyOf) {
          if (!importedOp?.body || (!importedOp.body.root && (!importedFields || importedFields.length === 0))) {
            flag("body_composed_schema(allOf/oneOf/anyOf)_dropped_or_partial", key, {
              keys: Object.keys(bs),
              nProps: pn.length,
            });
          }
        }

        if (bs.type === "array") {
          if (!importedOp?.body?.root || importedOp.body.root.dataType !== "array") {
            flag("body_toplevel_array_dropped", key);
          }
        }

        if (
          pn.length === 0 &&
          cts.length &&
          !(bs.allOf || bs.oneOf || bs.anyOf || bs.type === "array") &&
          !(bs.additionalProperties === false && isObject(bs.properties))
        ) {
          // UC3.6 maps text/plain and application/octet-stream bodies on purpose (a raw string or a blobRef): they have no
          // properties by nature, so they are handled, not dropped.
          const importedType = importedOp?.body?.contentType;
          const rawBody = importedType === "text/plain" || importedType === "application/octet-stream";
          if (!rawBody && (!importedOp?.body?.root || importedOp.body.root.dataType !== "object")) {
            flag("body_no_properties_dropped(free-form)", key);
          }
        }

        const isCapped =
          actualImportedCount !== undefined
            ? pn.length > actualImportedCount
            : pn.length > 6;

        if (isCapped) {
          const capBoundary = actualImportedCount ?? 6;
          flag("body_fields_dropped_by_6_cap", key, {
            total: pn.length,
            imported: actualImportedCount,
            dropped: pn.slice(capBoundary, capBoundary + 4),
          });
          const importedNames = new Set((importedFields ?? []).map((f: any) => f.name));
          const req = (Array.isArray(bs.required) ? bs.required : []).filter(
            (r: string) =>
              !importedNames.has(sanitizeIdentifier(r)) &&
              pn.indexOf(r) >= capBoundary
          );
          if (req.length) {
            flag("required_body_fields_lost_by_cap", key, { req });
          }
        }

        const fieldMap = new Map((importedFields ?? []).map((f: any) => [f.name, f]));
        const fieldsToInspect = ctx.options?.allFields ? pn : pn.slice(0, 6);

        for (const n of fieldsToInspect) {
          const s = dereference(spec0, props[n]);
          if (sanitizeIdentifier(n) !== n) {
            flag("body_field_name_altered", key, {
              src: n,
              gen: sanitizeIdentifier(n),
            });
          }

          const cleanN = sanitizeIdentifier(n);
          const importedField = fieldMap.get(cleanN);

          const it = dereference(spec0, s.items);
          const hasNestedInSpec =
            isObject(s.properties) ||
            (s.type === "array" &&
              (isObject(it.properties) || it.type === "array" || it.type === "object"));

          if (hasNestedInSpec) {
            const preserved =
              Boolean(importedField?.schema?.properties) ||
              Boolean(importedField?.schema?.items);
            if (!preserved) {
              flag("body_nested_structure_flattened", key, {
                field: n,
                type: s.type,
                sub: Object.keys(s.properties ?? it.properties ?? {}).slice(0, 4),
              });
            }
          }

          if (s.enum || s.default !== undefined) {
            const preservedEnumOrDefault =
              importedField?.schema?.enum !== undefined ||
              importedField?.schema?.default !== undefined;
            if (!preservedEnumOrDefault) {
              flag("enum_or_default_lost", key, {
                field: n,
                enum: s.enum?.slice(0, 4),
              });
            }
          }

          if (!s.type && (s.oneOf || s.anyOf || s.allOf)) {
            const preservedVariants = Boolean(importedField?.schema?.variants);
            if (!preservedVariants) {
              flag("type_erased_to_string(composition)", key, { field: n });
            }
          }
        }
      }

      if (spec0.swagger) {
        const fd = all.filter((q: any) => q.in === "formData" || q.in === "body");
        if (fd.length) {
          flag("swagger2_body_dropped_entirely", key, { n: fd.length });
        }
      }

      const resp = op.responses ?? {};
      const okk = Object.keys(resp).find((k) => k.startsWith("2"));
      if (okk) {
        const r = dereference(spec0, resp[okk]);
        const cc = r.content ?? {};
        const cts = Object.keys(cc);
        const hasJson = cts.some((ct) => /json/i.test(ct));
        const hasText = cts.some((ct) => ct.startsWith("text/"));
        if (!hasJson && !hasText && cts.length > 0) {
          flag("binary_response_unmodelled", key, { cts });
        }
        const schema = Object.values<any>(cc).find((v) => v?.schema)?.schema ?? r.schema;
        if (Object.values<any>(cc).some((v) => v?.schema) || r.schema) {
          flag("response_schema_ignored", key, { status: okk });
        }
        if (schema) {
          const derefSchema = dereference(spec0, schema);
          if (derefSchema && isObject(derefSchema.properties)) {
            const okProp = derefSchema.properties.ok;
            if (
              okProp &&
              (okProp.type === "boolean" ||
                (Array.isArray(okProp.type) && okProp.type.includes("boolean")))
            ) {
              flag("success_envelope_unchecked", key);
            }
            if (
              derefSchema.properties.has_more ||
              derefSchema.properties.next_cursor ||
              derefSchema.properties.nextPageToken ||
              derefSchema.properties.next
            ) {
              flag("pagination_unmodelled", key);
            }
          }
        }
        if (isObject(r.headers) && Object.keys(r.headers).some((h) => h.toLowerCase() === "link")) {
          flag("pagination_unmodelled", key);
        }
      }

      const sec = op.security ?? globalSec;
      if (sec && sec.length) {
        const types = new Set<string>();
        for (const req of sec) {
          for (const sn of Object.keys(req)) {
            const s = schemes[sn];
            if (!s) continue;
            types.add(
              s.type === "apiKey"
                ? `apiKey:${s.in}`
                : s.type === "http"
                  ? `http:${s.scheme}`
                  : s.type
            );
          }
        }

        if (
          [...types].some(
            (t) =>
              t === "oauth2" ||
              t === "apiKey:cookie" ||
              t === "apiKey:query" ||
              t === "openIdConnect"
          )
        ) {
          flag("security_oauth_or_nonheader", key, { types: [...types] });
        }
      }
    }
  }
  return { extracted, specOps };
}
