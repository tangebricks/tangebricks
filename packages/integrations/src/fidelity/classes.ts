/**
 * Closed set of defect classes identified during the OpenAPI / Swagger / Discovery importer audit.
 * Each class has a one-line description detailing what importer fidelity loss it represents.
 */
export const DEFECT_CLASSES = {
  // Request bodies
  body_fields_dropped_by_6_cap: "Request body properties beyond the first 6 are silently dropped by the importer cap",
  required_body_fields_lost_by_cap: "Required request body property is dropped because its spec index is >= 6",
  body_fields_dropped_by_5_cap: "Google Discovery request body properties beyond the first 5 are silently dropped",
  body_nested_structure_flattened: "Nested object or array of objects in request body has its internal schema flattened or lost",
  "body_composed_schema(allOf/oneOf/anyOf)_dropped_or_partial": "Request body composition (allOf, oneOf, anyOf) is dropped or partially imported",
  body_toplevel_array_dropped: "Top-level array schema in request body is dropped",
  "body_no_properties_dropped(free-form)": "Free-form object body with no explicit properties is dropped",
  body_unsupported_content_type_silent_json_fallback: "Unsupported request body content-type (e.g. multipart/form-data) silently falls back to JSON",
  body_field_name_altered: "Request body property wire name is altered by identifier sanitization",
  "body_ref_prop_typed_string(no deref in discovery path)": "Google Discovery request body property with $ref is typed as string without dereferencing",
  swagger2_body_dropped_entirely: "Swagger 2.0 formData or body parameters are dropped by the OpenAPI 3 extractor",

  // Parameters & paths
  "param_dropped_location(cookie/formData/body)": "Parameter with location other than path, query, or header is dropped",
  "param_serialization_unhonoured(array/object/style/explode)": "Parameter serialization rules (style, explode, array, object) are unhonoured",
  "param_dropped_dedup(name collision / op-level override)": "Parameter is dropped due to name collision after sanitization or duplicate definition",
  enum_or_default_lost: "Parameter or body property enum choices or default value are lost",
  "type_erased_to_string(composition)": "Parameter composition (oneOf, anyOf, allOf) is erased to bare string type",
  header_name_altered: "Header parameter wire name is altered by identifier sanitization",
  path_query_name_altered: "Path or query parameter wire name is altered by identifier sanitization",
  "path_placeholder_nonidentifier(unsubstitutable)": "Path template placeholder contains characters that cannot be substituted as identifiers",
  "path_placeholder_vs_declared_param_mismatch(flatPath)": "Google Discovery flatPath placeholders do not match declared path parameters",

  // Operations & methods
  op_method_unsupported: "Operation HTTP method is not supported (only GET, POST, PUT, PATCH, DELETE)",
  op_method_coerced_to_GET: "Google Discovery method with non-standard HTTP method is coerced to GET",
  op_id_collision_overwrites: "Multiple operations sanitize to the same operationId, causing silent overwriting",

  // Responses & security (non-structural)
  binary_response_unmodelled: "Operation declares a binary response content type but response has no binary payload modelling",
  response_schema_ignored: "2xx response schema declared in spec is ignored by importer (manifest response is empty)",
  success_envelope_unchecked: "200 schema declares boolean ok property but operation/manifest has no errorWhen/successWhen predicate",
  pagination_unmodelled: "Response indicates pagination (has_more, next_cursor, nextPageToken, next, Link) but operation has no pagination declared",
  "security_declared_but_never_read(importer ignores all)": "Security requirements declared on operations or globally are ignored by importer",
  security_oauth_or_nonheader: "OAuth2, cookie, query, or OpenID Connect security scheme declared but unsupported",
  security_multi_or_alternative_schemes: "Multiple security schemes or alternative options declared but unsupported",

  // Discovery specific info
  media_upload_ignored: "Google Discovery method media upload capability is ignored",
  "flatPath_used_over_path(info)": "Google Discovery flatPath is used instead of path (informational)",
  op_id_synthesized: "Operation ID was synthesized from HTTP method and path because spec omitted operationId",

  // Server & baseUrl diff
  server_baseurl_mismatch: "Curated baseUrl differs from spec declared server URL",

  // Runtime replay
  request_shape_mismatch:
    "Runtime request recorded during synthetic replay differs from spec declared shape (method, path, query keys, header names, body keys, content type)",
} as const;

export type DefectClass = keyof typeof DEFECT_CLASSES;

/**
 * Classes that represent metadata, security declarations, or informational notices
 * rather than silent loss or corruption of request structures.
 * These are excluded when calculating `opsWithStructuralDefect`.
 */
export const NON_STRUCTURAL_CLASSES: ReadonlySet<DefectClass> = new Set<DefectClass>([
  "server_baseurl_mismatch",
  "binary_response_unmodelled",
  "response_schema_ignored",
  "success_envelope_unchecked",
  "pagination_unmodelled",
  "security_declared_but_never_read(importer ignores all)",
  "security_oauth_or_nonheader",
  "security_multi_or_alternative_schemes",
  "flatPath_used_over_path(info)",
  "op_id_synthesized",
]);
