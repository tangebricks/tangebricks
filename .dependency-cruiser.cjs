// Import boundaries between bricks, packages and apps (story 1.30). Run with `pnpm lint:deps`; the rules, the reasons
// and every exception are written up in docs/import-boundaries.md.
//
// - A brick (bricks/<id>/src, test, client) imports only its own files by relative path, plus packages its own
//   package.json declares (dependencies, devDependencies or peerDependencies), through their entry point and `exports`,
//   plus node built-ins and cloudflare:* modules. @poc/sdk is declared by every brick.
// - No brick reaches into another brick's folder by path, and no package reaches into a brick's folder by path.
// - packages/* never import apps/*.
//
// Every existing violation that was not fixed is listed in EXCEPTIONS below: one source file, the exact files it may
// import, and the reason. There are no folder or wildcard exceptions; a new import is checked by the plain rule.
//
// SQL migrations are imported as `?raw` text (a file read, not a module). dependency-cruiser drops the `?raw` query
// before rules run, so `.sql` files are excluded outright; nothing else is excluded that way.

/** One exception: `from` may import each file in `to`, for the reason given. All paths are repo-relative and exact. */
const ticket = "story 1.30 (ticket 30)";

const REASON = {
  stubs:
    "multi-workspace's test stubs (stubWorkspaceContext, stubIdentity) are shared by other bricks' tests. They are test " +
    "code, so they are not in @poc/multi-workspace's exports or tarball; the proven bricks' copies of these imports also " +
    "feed the proof inputsHash. Follow-up: a shared test-support package.",
  sqliteD1:
    "credit-wallet's Node SQLite D1 adapter (client/test/support/sqlite-d1.ts) is test code reused by Node-side tests; it " +
    "is not part of @poc/credit-wallet's exports. Follow-up: move it to a shared test-support package.",
  repoTestHarness:
    "Repo-level test harness (test/support/*, scripts/max-compatible.ts) that assembles and runs emitted projects; brick " +
    "tests that check the assembled output use it. It is not a package to declare.",
  packageTestToApp:
    "Package integration test that drives the Studio API end to end. packages/*/test feeds the proof inputsHash, so moving " +
    "it under apps/ is a separate change. Test only; no package src imports an app.",
  packageTestToBrick:
    "Package test that imports brick source by path. packages/*/test feeds the proof inputsHash, so switching to the " +
    "@poc/<brick> entry is a separate change. Test only.",
  h12Glue:
    "H12 demo client and rehearsal: the file's sha256 is pinned by the recorded live H12 run (packages/deploy/src/h12.ts " +
    "GLUE_SCAN_FILES), so it must stay byte for byte. Demo client and test only; see the deploy -> credit-wallet decision.",
  h12Rehearsal: "H12 offline rehearsal world (deploy client test support): reuses the wallet's and workspace's test helpers. Test only.",
  h5Hosted:
    "H5 hosted-D1 proof harness: runs the wallet's own code and the local sweep's workload against hosted D1. Not part of " +
    "the deployed Worker; packages/deploy/src feeds the proof inputsHash, so it is left as recorded.",
};

const STUB_CTX = "bricks/multi-workspace/test/support/stub-workspace-context.ts";
const STUB_ID = "bricks/multi-workspace/test/support/stub-identity.ts";
const SQLITE_D1 = "bricks/credit-wallet/client/test/support/sqlite-d1.ts";
const EMITTED = "test/support/emitted-worker.ts";
const BLUEPRINTS = "test/support/blueprints.ts";
const STUDIO_API = "apps/studio-api/src/index.ts";
const HUMAN_SESSION = "apps/studio-api/test/human-session.ts";
const PROJECT_TOKEN = "apps/studio-api/test/project-token.ts";
const WALLET_CLIENT = "bricks/credit-wallet/client/wallet-client.ts";
const CREDIT_WIDGET = "bricks/credit-wallet/client/CreditWidget.tsx";

const EXCEPTIONS = {
  "brick-no-path-into-other-brick": [
    ...[
      "bricks/admin-console/test/admin.test.ts",
      "bricks/agent-sandbox/test/agent.test.ts",
      "bricks/audit-trail/test/audit.test.ts",
      "bricks/audit-trail/test/conformance.workerd.test.ts",
      "bricks/audit-trail/test/recorder.test.ts",
      "bricks/checkout-gateway/test/checkout-webhook.test.ts",
      "bricks/checkout-gateway/test/checkout.test.ts",
      "bricks/document-pdf/test/document.test.ts",
      "bricks/edge-traffic-armor/test/armor.test.ts",
      "bricks/identity-federation/test/federation.test.ts",
      "bricks/live-chat/test/chat.test.ts",
      "bricks/marketplace-splits/test/splits.test.ts",
      "bricks/metered-usage/test/metering.test.ts",
      "bricks/outbound-webhooks/test/outbound.test.ts",
      "bricks/product-analytics/test/analytics.test.ts",
      "bricks/queue-jobs/test/jobs.test.ts",
      "bricks/queue-jobs/test/tenant-scope.test.ts",
      "bricks/realtime-presence/test/presence.test.ts",
      "bricks/search-faceted/test/search.test.ts",
      "bricks/tabular-engine/test/tabular.test.ts",
      "bricks/threaded-discussions/test/threads.test.ts",
      "bricks/vector-memory/test/vectors.test.ts",
    ].map((from) => ({ from, to: [STUB_CTX], reason: REASON.stubs })),
    ...[
      "bricks/credit-wallet/client/test/credit-widget.test.tsx",
      "bricks/credit-wallet/test/H5.deduct-route.test.ts",
      "bricks/credit-wallet/test/H5.payment-routes.test.ts",
      "bricks/credit-wallet/test/milli-credits.test.ts",
      "bricks/dynamic-entities/test/H8.router.test.ts",
    ].map((from) => ({ from, to: [STUB_ID], reason: REASON.stubs })),
    {
      from: "bricks/integration-connections/client/test/connect-account-widget.test.tsx",
      to: [STUB_ID, SQLITE_D1],
      reason: `${REASON.stubs} ${REASON.sqliteD1}`,
    },
    { from: "bricks/scripting-sandbox/test/escape.node.test.ts", to: [SQLITE_D1], reason: REASON.sqliteD1 },
    { from: "bricks/scripting-sandbox/test/noninterference.node.test.ts", to: [SQLITE_D1], reason: REASON.sqliteD1 },
  ],
  "brick-no-path-outside-brick": [
    { from: "bricks/cron-alarms/test/cron.test.ts", to: [EMITTED], reason: REASON.repoTestHarness },
    {
      from: "bricks/data-privacy-gdpr/test/erasure-coverage.test.ts",
      to: ["scripts/max-compatible.ts", BLUEPRINTS, EMITTED],
      reason: REASON.repoTestHarness,
    },
    { from: "bricks/queue-jobs/test/jobs.test.ts", to: [EMITTED], reason: REASON.repoTestHarness },
    { from: "bricks/workflow-dag/test/workflow.test.ts", to: [BLUEPRINTS, EMITTED], reason: REASON.repoTestHarness },
  ],
  "package-no-app": [
    { from: "packages/assembler/test/openapi-emission.test.ts", to: [STUDIO_API], reason: REASON.packageTestToApp },
    {
      from: "packages/deploy/test/data-browser-isolation.test.ts",
      to: ["apps/studio-api/src/telemetry-reads.ts"],
      reason: REASON.packageTestToApp,
    },
    { from: "packages/harness/test/cohort-1-simulation.test.ts", to: [STUDIO_API], reason: REASON.packageTestToApp },
    { from: "packages/mcp-server/test/deploy-real-client.node.test.ts", to: [STUDIO_API], reason: REASON.packageTestToApp },
    {
      from: "packages/mcp-server/test/self-correction.test.ts",
      to: [STUDIO_API, HUMAN_SESSION, PROJECT_TOKEN],
      reason: REASON.packageTestToApp,
    },
    {
      from: "packages/mcp-server/test/tools-surface.test.ts",
      to: [STUDIO_API, HUMAN_SESSION, PROJECT_TOKEN],
      reason: REASON.packageTestToApp,
    },
  ],
  "package-no-path-into-brick": [
    {
      from: "packages/assembler/test/llm-gateway-billing.test.ts",
      to: ["bricks/llm-gateway/src/index.ts"],
      reason: REASON.packageTestToBrick,
    },
    {
      from: "packages/assembler/test/oidc-denial.test.ts",
      to: [
        "bricks/credit-wallet/src/routes.ts",
        "bricks/multi-workspace/src/middleware.ts",
        "bricks/multi-workspace/src/routes.ts",
        "bricks/oidc-verify/src/index.ts",
      ],
      reason: REASON.packageTestToBrick,
    },
    {
      from: "packages/core-nodes/test/core-nodes.conformance.test.ts",
      to: [
        "bricks/credit-wallet/src/index.ts",
        "bricks/dynamic-entities/src/index.ts",
        "bricks/in-app-notifications/src/index.ts",
        "bricks/omnichannel-outbound/src/index.ts",
        "bricks/scripting-sandbox/src/index.ts",
        "bricks/webhook-gateway/src/index.ts",
      ],
      reason: REASON.packageTestToBrick,
    },
    {
      from: "packages/integrations/test/pack-v1-contract.workerd.test.ts",
      to: ["bricks/webhook-gateway/src/index.ts"],
      reason: REASON.packageTestToBrick,
    },
    { from: "packages/mcp-server/test/discovery.node.test.ts", to: [SQLITE_D1], reason: REASON.sqliteD1 },
    { from: "packages/mcp-server/test/interop.node.test.ts", to: [SQLITE_D1], reason: REASON.sqliteD1 },
    { from: "packages/mcp-server/test/support/session.ts", to: [SQLITE_D1], reason: REASON.sqliteD1 },
    {
      from: "packages/mcp-server/test/mcp.test.ts",
      to: ["bricks/dynamic-entities/src/index.ts"],
      reason: REASON.packageTestToBrick,
    },
    {
      from: "packages/runtime/test/case-a-connections.test.ts",
      to: ["bricks/webhook-gateway/src/gateway.ts", "bricks/webhook-gateway/src/index.ts", "bricks/webhook-gateway/src/routes.ts"],
      reason: REASON.packageTestToBrick,
    },
    // packages/deploy -> credit-wallet (see docs/import-boundaries.md, "packages/deploy and credit-wallet").
    { from: "packages/deploy/client/demo-entry.tsx", to: [CREDIT_WIDGET, WALLET_CLIENT], reason: REASON.h12Glue },
    { from: "packages/deploy/client/support/widget-driver.tsx", to: [CREDIT_WIDGET, WALLET_CLIENT], reason: REASON.h12Glue },
    { from: "packages/deploy/client/live/H12.live.test.tsx", to: [WALLET_CLIENT], reason: REASON.h12Glue },
    { from: "packages/deploy/client/test/H12.rehearsal.test.tsx", to: [WALLET_CLIENT], reason: REASON.h12Glue },
    { from: "packages/deploy/client/support/rehearsal-world.ts", to: [SQLITE_D1, STUB_ID], reason: REASON.h12Rehearsal },
    {
      from: "packages/deploy/src/h5-hosted.ts",
      to: ["bricks/credit-wallet/src/index.ts", "bricks/credit-wallet/test/support/workload.ts"],
      reason: REASON.h5Hosted,
    },
  ],
};

const RULES = [
  {
    name: "brick-no-path-into-other-brick",
    comment: "A brick never imports a file inside another brick's folder; it imports the other brick's package (declared).",
    from: { path: "^bricks/([^/]+)/" },
    to: { path: "^bricks/[^/]+/", pathNot: ["^bricks/$1/"] },
  },
  {
    name: "brick-no-path-outside-brick",
    comment: "A brick imports files by relative path only inside its own folder; anything else is a declared package.",
    from: { path: "^bricks/[^/]+/" },
    to: { dependencyTypes: ["local"], pathNot: ["^bricks/[^/]+/"] },
  },
  {
    name: "brick-undeclared-dependency",
    comment: "A brick imports only packages its own package.json declares (dependencies, devDependencies, peerDependencies).",
    from: { path: "^bricks/[^/]+/" },
    to: { dependencyTypes: ["npm-no-pkg", "npm-unknown", "unknown", "undetermined"] },
  },
  {
    name: "brick-unresolvable",
    comment: "An import that does not resolve, e.g. a deep path a package's `exports` does not offer.",
    from: { path: "^bricks/[^/]+/" },
    to: { couldNotResolve: true },
  },
  {
    name: "package-no-path-into-brick",
    comment: "A package reaches a brick only through the brick's package entry (@poc/<brick>), never by path.",
    from: { path: "^packages/" },
    to: { path: "^bricks/[^/]+/" },
  },
  {
    name: "package-no-app",
    comment: "packages/* never import apps/*.",
    from: { path: "^packages/" },
    to: { path: "^apps/" },
  },
  {
    // With preserveSymlinks, `@poc/studio-api` resolves under the importer's (or the root's) node_modules, not apps/.
    name: "no-app-package-import",
    comment: "packages/* and bricks/* never import an app package by name (@poc/studio-api, @poc/studio-web).",
    from: { path: "^(packages|bricks)/" },
    to: { path: "(^|/)node_modules/@poc/studio-(api|web)(/|$)" },
  },
];

const exact = (file) => `^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;

/**
 * Expands each rule with its exceptions: the rule itself skips the excepted source files, and each excepted source gets
 * its own copy of the rule (same name) that skips only its listed targets.
 */
function expand(rule) {
  const exceptions = EXCEPTIONS[rule.name] ?? [];
  const base = {
    ...rule,
    severity: "error",
    from: { ...rule.from, pathNot: [...(rule.from.pathNot ?? []), ...exceptions.map((e) => exact(e.from))] },
  };
  const perSource = exceptions.map(({ from, to, reason }) => {
    const brick = /^bricks\/([^/]+)\//.exec(from)?.[1];
    const ownPathNot = (rule.to.pathNot ?? []).map((p) => (brick ? p.replace("$1", brick) : p));
    return {
      name: rule.name,
      severity: "error",
      comment: `Exception (${ticket}): ${from} may import ${to.join(", ")}. ${reason}`,
      from: { path: exact(from) },
      to: { ...rule.to, pathNot: [...ownPathNot, ...to.map(exact)] },
    };
  });
  return [base, ...perSource];
}

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: RULES.flatMap(expand),
  options: {
    // Workspace packages resolve through each package's own node_modules symlink, so an import is checked against the
    // importing package's package.json (npm, npm-dev, npm-peer) and an undeclared one is npm-no-pkg.
    preserveSymlinks: true,
    builtInModules: { add: ["cloudflare:workers", "cloudflare:test", "cloudflare:workflows", "cloudflare:sockets", "cloudflare:email"] },
    // Generated, recorded and build output: not scanned as sources, and not followed, but an import of them still counts.
    doNotFollow: {
      path: [
        "node_modules",
        "^(apps|bricks|packages)/[^/]+/(?!node_modules/)(out|fixtures|dist|coverage|evidence|\\.wrangler)/",
        "^(apps|bricks|packages)/[^/]+/(?!node_modules/).*/(out|fixtures|dist|coverage|evidence|\\.wrangler)/",
        "^(apps|bricks|packages)/[^/]+/(?!node_modules/).*\\.d\\.ts$",
        "^packages/assembler/catalog\\.generated\\.ts$",
        "^apps/studio-web/src/catalog-data\\.json$",
      ],
    },
    exclude: { path: ["\\.sql$"] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types", "workerd", "worker", "browser"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".d.ts"],
    },
  },
};
