import { FIDELITY_CODES } from "@poc/assembler";
import { escapeJsonPointer, type ImportReportElement } from "./report.ts";
import { isPlainObject } from "./util.ts";

export interface Swagger2UnsupportedEntry {
  readonly op: string | null;
  readonly element: ImportReportElement;
  readonly code: string;
  readonly pointer: string;
  readonly reason: string;
  readonly blocking: boolean;
}

export interface Swagger2ConversionResult {
  readonly spec: Record<string, any>;
  readonly pointerMap: Map<string, string>;
  readonly unsupportedEntries: Swagger2UnsupportedEntry[];
}

function deepRewriteRefs(val: unknown): unknown {
  if (!val || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(deepRewriteRefs);
  const obj = val as Record<string, any>;
  const res: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    res[k] = k === "$ref" && typeof v === "string" && v.startsWith("#/definitions/")
      ? v.replace(/^#\/definitions\//, "#/components/schemas/")
      : deepRewriteRefs(v);
  }
  return res;
}

export function translatePointer(pointerMap: Map<string, string>, ptr: string): string {
  if (pointerMap.has(ptr)) return pointerMap.get(ptr)!;
  let longestMatch = "";
  let longestTarget = "";
  for (const [oasPtr, origPtr] of pointerMap.entries()) {
    if (ptr.startsWith(oasPtr) && oasPtr.length > longestMatch.length) {
      longestMatch = oasPtr;
      longestTarget = origPtr;
    }
  }
  if (longestMatch) return `${longestTarget}${ptr.slice(longestMatch.length)}`;
  if (ptr.startsWith("#/components/schemas/")) return ptr.replace(/^#\/components\/schemas\//, "#/definitions/");
  if (ptr.startsWith("#/components/securitySchemes/")) return ptr.replace(/^#\/components\/securitySchemes\//, "#/securityDefinitions/");
  if (ptr.startsWith("#/servers")) return pointerMap.get("#/servers/0") ?? "#/host";
  return ptr;
}

export function swagger2ToOpenApi3(rawSwagger: Record<string, any>): Swagger2ConversionResult {
  const pointerMap = new Map<string, string>();
  const unsupportedEntries: Swagger2UnsupportedEntry[] = [];
  const oas3: Record<string, any> = {
    openapi: "3.0.3",
    info: rawSwagger.info ?? { title: "API", version: "1.0.0" },
    paths: {},
    components: { schemas: {}, securitySchemes: {} },
  };
  pointerMap.set("#/swagger", "#/swagger");
  pointerMap.set("#/info", "#/info");

  // 1. host / basePath / schemes -> servers
  const schemes = Array.isArray(rawSwagger.schemes) && rawSwagger.schemes.length > 0 ? rawSwagger.schemes : ["https"];
  const host = typeof rawSwagger.host === "string" ? rawSwagger.host : "";
  const basePath = typeof rawSwagger.basePath === "string"
    ? (rawSwagger.basePath.startsWith("/") ? rawSwagger.basePath : `/${rawSwagger.basePath}`)
    : "";
  let serverUrl = "/";
  let swaggerServerPtr = "#/basePath";
  if (host) {
    serverUrl = `${schemes[0]}://${host}${basePath}`.replace(/\/+$/, "") || "/";
    swaggerServerPtr = "#/host";
  } else if (basePath) {
    serverUrl = basePath.replace(/\/+$/, "") || "/";
  }
  oas3.servers = [{ url: serverUrl }];
  pointerMap.set("#/servers/0", swaggerServerPtr);
  pointerMap.set("#/servers", swaggerServerPtr);

  // 2. definitions -> components.schemas
  if (isPlainObject(rawSwagger.definitions)) {
    for (const [defName, defSchema] of Object.entries(rawSwagger.definitions)) {
      oas3.components.schemas[defName] = deepRewriteRefs(defSchema);
      pointerMap.set(`#/components/schemas/${escapeJsonPointer(defName)}`, `#/definitions/${escapeJsonPointer(defName)}`);
    }
  }

  // 3. securityDefinitions -> components.securitySchemes
  if (isPlainObject(rawSwagger.securityDefinitions)) {
    for (const [secName, secDefRaw] of Object.entries(rawSwagger.securityDefinitions)) {
      const secDef = isPlainObject(secDefRaw) ? secDefRaw : {};
      const origSecPtr = `#/securityDefinitions/${escapeJsonPointer(secName)}`;
      pointerMap.set(`#/components/securitySchemes/${escapeJsonPointer(secName)}`, origSecPtr);
      const desc = secDef.description ? { description: secDef.description } : {};

      if (secDef.type === "basic") {
        oas3.components.securitySchemes[secName] = { type: "http", scheme: "basic", ...desc };
      } else if (secDef.type === "apiKey") {
        oas3.components.securitySchemes[secName] = { type: "apiKey", name: secDef.name, in: secDef.in, ...desc };
      } else if (secDef.type === "oauth2") {
        const flows: Record<string, any> = {};
        const scopes = isPlainObject(secDef.scopes) ? secDef.scopes : {};
        if (secDef.flow === "accessCode") {
          flows.authorizationCode = { authorizationUrl: secDef.authorizationUrl, tokenUrl: secDef.tokenUrl, scopes };
        } else if (secDef.flow === "implicit") {
          flows.implicit = { authorizationUrl: secDef.authorizationUrl, scopes };
        } else if (secDef.flow === "password") {
          flows.password = { tokenUrl: secDef.tokenUrl, scopes };
        } else if (secDef.flow === "application") {
          flows.clientCredentials = { tokenUrl: secDef.tokenUrl, scopes };
        }
        oas3.components.securitySchemes[secName] = { type: "oauth2", flows, ...desc };
      }
    }
  }

  if (Array.isArray(rawSwagger.security)) oas3.security = rawSwagger.security;
  const rootConsumes = Array.isArray(rawSwagger.consumes) ? rawSwagger.consumes : [];
  const rootProduces = Array.isArray(rawSwagger.produces) ? rawSwagger.produces : [];

  // 4. Paths and Operations
  const rawPaths = isPlainObject(rawSwagger.paths) ? rawSwagger.paths : {};
  const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];

  for (const [rawPath, pathItemRaw] of Object.entries(rawPaths)) {
    if (!isPlainObject(pathItemRaw)) continue;
    const pathItem: Record<string, any> = {};
    oas3.paths[rawPath] = pathItem;
    const pathEsc = escapeJsonPointer(rawPath);

    for (const method of HTTP_METHODS) {
      const opRaw = pathItemRaw[method];
      if (!isPlainObject(opRaw)) continue;

      const opEsc = `${pathEsc}/${method}`;
      const opId = typeof opRaw.operationId === "string" ? opRaw.operationId : null;
      const opConsumes = Array.isArray(opRaw.consumes) && opRaw.consumes.length > 0 ? opRaw.consumes : rootConsumes;
      const opProduces = Array.isArray(opRaw.produces) && opRaw.produces.length > 0 ? opRaw.produces : rootProduces;

      const opParams: Array<{ param: any; origIndex: number }> = (
        Array.isArray(opRaw.parameters) ? opRaw.parameters : []
      ).map((param: any, origIndex: number) => ({ param, origIndex }));

      const bodyParams = opParams.filter((p) => isPlainObject(p.param) && p.param.in === "body");
      const formDataParams = opParams.filter((p) => isPlainObject(p.param) && p.param.in === "formData");
      const standardParams = opParams.filter(
        (p) => isPlainObject(p.param) && p.param.in !== "body" && p.param.in !== "formData",
      );

      const oas3Params: any[] = [];
      let newParamIdx = 0;
      for (const item of standardParams) {
        const p = item.param;
        const origParamPtr = `#/paths/${opEsc}/parameters/${item.origIndex}`;
        pointerMap.set(`#/paths/${opEsc}/parameters/${newParamIdx++}`, origParamPtr);

        const pCopy: Record<string, any> = {
          name: p.name,
          in: p.in,
          ...(p.description ? { description: p.description } : {}),
          ...(p.required !== undefined ? { required: p.required } : {}),
        };

        if (p.collectionFormat === "tsv") {
          unsupportedEntries.push({
            op: opId,
            element: "param",
            code: FIDELITY_CODES.COLLECTION_FORMAT_UNSUPPORTED.code,
            pointer: origParamPtr,
            reason: `collectionFormat "tsv" is unsupported in OpenAPI 3`,
            blocking: true,
          });
        } else if (p.collectionFormat === "multi") {
          pCopy.style = "form";
          pCopy.explode = true;
        } else if (p.collectionFormat === "ssv") {
          pCopy.style = "spaceDelimited";
          pCopy.explode = false;
        } else if (p.collectionFormat === "pipes") {
          pCopy.style = "pipeDelimited";
          pCopy.explode = false;
        } else if (p.collectionFormat === "csv") {
          pCopy.style = p.in === "path" || p.in === "header" ? "simple" : "form";
          pCopy.explode = false;
        }

        const schema: Record<string, any> = {
          ...(p.type ? { type: p.type } : {}),
          ...(p.format ? { format: p.format } : {}),
          ...(p.items ? { items: deepRewriteRefs(p.items) } : {}),
          ...(p.enum ? { enum: p.enum } : {}),
          ...(p.default !== undefined ? { default: p.default } : {}),
        };
        if (Object.keys(schema).length > 0) pCopy.schema = schema;
        oas3Params.push(pCopy);
      }

      let requestBody: Record<string, any> | undefined;

      if (bodyParams.length > 0) {
        const bp = bodyParams[0]!;
        const origParamPtr = `#/paths/${opEsc}/parameters/${bp.origIndex}`;
        const contentTypes = opConsumes.length > 0 ? opConsumes : ["application/json"];
        const content: Record<string, any> = {};
        for (const ct of contentTypes) {
          content[ct] = { schema: deepRewriteRefs(bp.param.schema ?? {}) };
          pointerMap.set(`#/paths/${opEsc}/requestBody/content/${escapeJsonPointer(ct)}/schema`, `${origParamPtr}/schema`);
        }
        requestBody = {
          ...(bp.param.description ? { description: bp.param.description } : {}),
          ...(bp.param.required !== undefined ? { required: bp.param.required } : {}),
          content,
        };
        const reqBodyPtr = `#/paths/${opEsc}/requestBody`;
        pointerMap.set(reqBodyPtr, origParamPtr);
        pointerMap.set(`${reqBodyPtr}/content`, origParamPtr);
      } else if (formDataParams.length > 0) {
        const hasFile = formDataParams.some((fp) => fp.param.type === "file");
        const contentType = hasFile
          ? "multipart/form-data"
          : (opConsumes.includes("multipart/form-data") ? "multipart/form-data" : "application/x-www-form-urlencoded");

        const properties: Record<string, any> = {};
        const required: string[] = [];

        for (const fp of formDataParams) {
          const p = fp.param;
          const origParamPtr = `#/paths/${opEsc}/parameters/${fp.origIndex}`;
          if (p.required === true) required.push(p.name);

          properties[p.name] = p.type === "file"
            ? { type: "string", format: "binary", ...(p.description ? { description: p.description } : {}) }
            : {
                ...(p.type ? { type: p.type } : { type: "string" }),
                ...(p.format ? { format: p.format } : {}),
                ...(p.items ? { items: deepRewriteRefs(p.items) } : {}),
                ...(p.description ? { description: p.description } : {}),
                ...(p.enum ? { enum: p.enum } : {}),
                ...(p.default !== undefined ? { default: p.default } : {}),
              };

          pointerMap.set(
            `#/paths/${opEsc}/requestBody/content/${escapeJsonPointer(contentType)}/schema/properties/${escapeJsonPointer(p.name)}`,
            origParamPtr,
          );
        }

        const schema: Record<string, any> = {
          type: "object",
          properties,
          ...(required.length > 0 ? { required } : {}),
        };

        requestBody = {
          required: required.length > 0,
          content: { [contentType]: { schema } },
        };

        const firstParamPtr = `#/paths/${opEsc}/parameters`;
        const reqBodyPtr = `#/paths/${opEsc}/requestBody`;
        pointerMap.set(reqBodyPtr, firstParamPtr);
        pointerMap.set(`${reqBodyPtr}/content`, firstParamPtr);
        pointerMap.set(`${reqBodyPtr}/content/${escapeJsonPointer(contentType)}/schema`, firstParamPtr);
      }

      // Responses
      const responses: Record<string, any> = {};
      if (isPlainObject(opRaw.responses)) {
        for (const [statusCode, respRaw] of Object.entries(opRaw.responses)) {
          if (!isPlainObject(respRaw)) continue;
          const origRespPtr = `#/paths/${opEsc}/responses/${escapeJsonPointer(statusCode)}`;
          const oas3RespPtr = `#/paths/${opEsc}/responses/${escapeJsonPointer(statusCode)}`;
          pointerMap.set(oas3RespPtr, origRespPtr);

          if (respRaw.schema) {
            const prodTypes = opProduces.length > 0 ? opProduces : ["application/json"];
            const content: Record<string, any> = {};
            for (const pt of prodTypes) {
              content[pt] = { schema: deepRewriteRefs(respRaw.schema) };
              pointerMap.set(`${oas3RespPtr}/content/${escapeJsonPointer(pt)}/schema`, `${origRespPtr}/schema`);
            }
            responses[statusCode] = { description: respRaw.description ?? "", content };
          } else {
            responses[statusCode] = { description: respRaw.description ?? "" };
          }
        }
      }

      pathItem[method] = {
        ...opRaw,
        parameters: oas3Params,
        ...(requestBody ? { requestBody } : {}),
        responses,
      };
    }
  }

  return { spec: oas3, pointerMap, unsupportedEntries };
}
