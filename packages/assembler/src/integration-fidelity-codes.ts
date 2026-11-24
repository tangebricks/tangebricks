/**
 * The single registry of importer fidelity report codes (UC2.8).
 *
 * Every `code` an import report entry can carry is declared here exactly once. The importer
 * emits codes through `FIDELITY_CODES.<NAME>.code`, so an unknown code is a compile error.
 * `defaultStatus` and `blocking` are the usual verdict for the code; a site may deviate where
 * noted (the report entry is always the source of truth for a given import).
 * `ownerStory` names the UC3 story that removes the loss, or null when the code is not a loss
 * a UC3 story is expected to remove.
 */
export type FidelityCodeStatus =
  | "mapped"
  | "normalized"
  | "curated"
  | "approximated"
  | "unsupported";

export interface FidelityCodeInfo<C extends string = string> {
  readonly code: C;
  readonly defaultStatus: FidelityCodeStatus;
  readonly blocking: boolean;
  readonly ownerStory: string | null;
}

function defineCodes<const T extends { readonly [K in keyof T & string]: FidelityCodeInfo<K> }>(
  codes: T,
): T {
  return codes;
}

export const FIDELITY_CODES = defineCodes({
  ALLOWED_HOSTS_NARROWED: { code: "ALLOWED_HOSTS_NARROWED", defaultStatus: "curated", blocking: false, ownerStory: null },
  AUTH_FROM_CURATION: { code: "AUTH_FROM_CURATION", defaultStatus: "curated", blocking: false, ownerStory: null },
  AUTH_MAPPED: { code: "AUTH_MAPPED", defaultStatus: "mapped", blocking: false, ownerStory: null },
  AUTH_NONE: { code: "AUTH_NONE", defaultStatus: "mapped", blocking: false, ownerStory: null },
  AUTH_SCHEME: { code: "AUTH_SCHEME", defaultStatus: "mapped", blocking: false, ownerStory: null },
  AUTH_SCHEME_UNSUPPORTED: { code: "AUTH_SCHEME_UNSUPPORTED", defaultStatus: "unsupported", blocking: true, ownerStory: "UC3.3" },
  BASEURL: { code: "BASEURL", defaultStatus: "mapped", blocking: false, ownerStory: null },
  BASEURL_CURATED: { code: "BASEURL_CURATED", defaultStatus: "curated", blocking: false, ownerStory: null },
  BODY_COMPOSED_DROPPED: { code: "BODY_COMPOSED_DROPPED", defaultStatus: "unsupported", blocking: true, ownerStory: "UC3.5" },
  BODY_FIELD_CAPPED: { code: "BODY_FIELD_CAPPED", defaultStatus: "unsupported", blocking: false, ownerStory: "UC3.5" },
  BODY_FIELD_MAPPED: { code: "BODY_FIELD_MAPPED", defaultStatus: "mapped", blocking: false, ownerStory: null },
  BODY_FREEFORM_DROPPED: { code: "BODY_FREEFORM_DROPPED", defaultStatus: "unsupported", blocking: true, ownerStory: "UC3.5" },
  BODY_NESTED_FLATTENED: { code: "BODY_NESTED_FLATTENED", defaultStatus: "approximated", blocking: false, ownerStory: "UC3.5" },
  BODY_REF_PROPERTY_UNRESOLVED: { code: "BODY_REF_PROPERTY_UNRESOLVED", defaultStatus: "approximated", blocking: false, ownerStory: "UC3.5" },
  BODY_REQUIRED_FIELD_CAPPED: { code: "BODY_REQUIRED_FIELD_CAPPED", defaultStatus: "unsupported", blocking: true, ownerStory: "UC3.5" },
  BODY_TOPLEVEL_ARRAY_DROPPED: { code: "BODY_TOPLEVEL_ARRAY_DROPPED", defaultStatus: "unsupported", blocking: true, ownerStory: "UC3.5" },
  COLLECTION_FORMAT_UNSUPPORTED: { code: "COLLECTION_FORMAT_UNSUPPORTED", defaultStatus: "unsupported", blocking: true, ownerStory: "UC3.7" },
  CONTENT_TYPE_MAPPED: { code: "CONTENT_TYPE_MAPPED", defaultStatus: "mapped", blocking: false, ownerStory: null },
  CONTENT_TYPE_UNSUPPORTED: { code: "CONTENT_TYPE_UNSUPPORTED", defaultStatus: "unsupported", blocking: true, ownerStory: "UC3.6" },
  DEEPOBJECT_ARRAY_CONVENTION: { code: "DEEPOBJECT_ARRAY_CONVENTION", defaultStatus: "normalized", blocking: false, ownerStory: null },
  ERROR_SHAPE: { code: "ERROR_SHAPE", defaultStatus: "mapped", blocking: false, ownerStory: null },
  IDENTIFIER_COLLISION: { code: "IDENTIFIER_COLLISION", defaultStatus: "unsupported", blocking: true, ownerStory: null },
  IDENTIFIER_COLLISION_DISAMBIGUATED: { code: "IDENTIFIER_COLLISION_DISAMBIGUATED", defaultStatus: "normalized", blocking: false, ownerStory: null },
  IDENTIFIER_NORMALIZED: { code: "IDENTIFIER_NORMALIZED", defaultStatus: "normalized", blocking: false, ownerStory: null },
  MEDIA_UPLOAD_UNSUPPORTED: { code: "MEDIA_UPLOAD_UNSUPPORTED", defaultStatus: "unsupported", blocking: false, ownerStory: "UC3.6" },
  MEDIA_UPLOAD_VARIANT: { code: "MEDIA_UPLOAD_VARIANT", defaultStatus: "normalized", blocking: false, ownerStory: null },
  OPERATION_CURATED_ONLY: { code: "OPERATION_CURATED_ONLY", defaultStatus: "curated", blocking: false, ownerStory: null },
  OPERATION_ID_COLLISION: { code: "OPERATION_ID_COLLISION", defaultStatus: "normalized", blocking: false, ownerStory: null },
  OPERATION_MAPPED: { code: "OPERATION_MAPPED", defaultStatus: "mapped", blocking: false, ownerStory: null },
  OPERATION_SERVER_OVERRIDE: { code: "OPERATION_SERVER_OVERRIDE", defaultStatus: "unsupported", blocking: true, ownerStory: null },
  OPERATION_SKIPPED: { code: "OPERATION_SKIPPED", defaultStatus: "unsupported", blocking: false, ownerStory: null },
  OVERLAY_ADDED: { code: "OVERLAY_ADDED", defaultStatus: "curated", blocking: false, ownerStory: null },
  OVERLAY_OVERRIDE: { code: "OVERLAY_OVERRIDE", defaultStatus: "curated", blocking: false, ownerStory: null },
  PAGINATION_MAPPED: { code: "PAGINATION_MAPPED", defaultStatus: "mapped", blocking: false, ownerStory: "UC3.8" },
  PAGINATION_UNMODELLED: { code: "PAGINATION_UNMODELLED", defaultStatus: "approximated", blocking: false, ownerStory: "UC3.8" },
  PARAM_DEFAULT_DROPPED: { code: "PARAM_DEFAULT_DROPPED", defaultStatus: "approximated", blocking: false, ownerStory: "UC3.4" },
  PARAM_ENUM_DROPPED: { code: "PARAM_ENUM_DROPPED", defaultStatus: "approximated", blocking: false, ownerStory: "UC3.4" },
  PARAM_ENUM_TRUNCATED: { code: "PARAM_ENUM_TRUNCATED", defaultStatus: "approximated", blocking: false, ownerStory: "UC3.4" },
  PARAM_LOCATION_UNSUPPORTED: { code: "PARAM_LOCATION_UNSUPPORTED", defaultStatus: "unsupported", blocking: false, ownerStory: "UC3.7" },  // blocking is per-site (a required swagger2/body parameter blocks)
  PARAM_MAPPED: { code: "PARAM_MAPPED", defaultStatus: "mapped", blocking: false, ownerStory: null },
  PARAM_STYLE_UNHONOURED: { code: "PARAM_STYLE_UNHONOURED", defaultStatus: "unsupported", blocking: true, ownerStory: "UC3.4" },
  REF_DEPTH_EXCEEDED: { code: "REF_DEPTH_EXCEEDED", defaultStatus: "approximated", blocking: false, ownerStory: null },
  RESPONSE_EMPTY: { code: "RESPONSE_EMPTY", defaultStatus: "mapped", blocking: false, ownerStory: null },
  RESPONSE_MAPPED: { code: "RESPONSE_MAPPED", defaultStatus: "mapped", blocking: false, ownerStory: null },
  RESPONSE_PROPERTY_NOT_PORT: { code: "RESPONSE_PROPERTY_NOT_PORT", defaultStatus: "normalized", blocking: false, ownerStory: null },
  RESPONSE_SCHEMA: { code: "RESPONSE_SCHEMA", defaultStatus: "mapped", blocking: false, ownerStory: null },
  RESPONSE_SCHEMA_IGNORED: { code: "RESPONSE_SCHEMA_IGNORED", defaultStatus: "unsupported", blocking: false, ownerStory: "UC3.2" },
  SCHEMA_COMPOSITION_ERASED: { code: "SCHEMA_COMPOSITION_ERASED", defaultStatus: "approximated", blocking: false, ownerStory: "UC3.5" },
  SCHEMA_DEPTH_LIMIT: { code: "SCHEMA_DEPTH_LIMIT", defaultStatus: "approximated", blocking: false, ownerStory: "UC3.5" },
  SCHEMA_NODE_LIMIT: { code: "SCHEMA_NODE_LIMIT", defaultStatus: "approximated", blocking: false, ownerStory: "UC3.5" },
  SERVER_VARIABLE_EXPANDED: { code: "SERVER_VARIABLE_EXPANDED", defaultStatus: "normalized", blocking: false, ownerStory: null },
  SPEC_HAND_TRIMMED: { code: "SPEC_HAND_TRIMMED", defaultStatus: "curated", blocking: false, ownerStory: null },
  SPEC_VERSION_UNSUPPORTED: { code: "SPEC_VERSION_UNSUPPORTED", defaultStatus: "unsupported", blocking: false, ownerStory: "UC3.7" },
  SUCCESS_ENVELOPE_UNCHECKED: { code: "SUCCESS_ENVELOPE_UNCHECKED", defaultStatus: "approximated", blocking: false, ownerStory: "UC3.8" },
  SWAGGER2_BODY_DROPPED: { code: "SWAGGER2_BODY_DROPPED", defaultStatus: "unsupported", blocking: true, ownerStory: "UC3.7" },
  SWAGGER2_UPCONVERTED: { code: "SWAGGER2_UPCONVERTED", defaultStatus: "normalized", blocking: false, ownerStory: "UC3.7" },
});

export type FidelityCodeName = keyof typeof FIDELITY_CODES;
