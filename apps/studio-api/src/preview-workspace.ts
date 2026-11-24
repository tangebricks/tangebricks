/**
 * The named workspace Studio's preview runs (Test Step, Test Workflow, re-run from a node) use when the caller names none.
 * Defined once here so the runtime itself never defaults a workspace (story 1.1, AD-S19): Studio passes this explicitly.
 */
export const STUDIO_PREVIEW_WORKSPACE = "ws_default";
