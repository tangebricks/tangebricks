import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BricksView } from "../src/components/BricksView.tsx";
import { MaturityBadge } from "../src/components/Badges.tsx";
import { useStudioStore } from "../src/store.ts";
import {
  DEFAULT_CATALOG,
  DEFAULT_INTEGRATIONS,
  type BlueprintState,
  type CatalogBrickManifest,
  type CatalogIntegrationManifest,
} from "../src/types.ts";

const sampleBlueprint: BlueprintState = {
  schemaVersion: 2,
  project: "tier-evidence-demo",
  identity: "core-auth",
  bricks: [
    { id: "test-beta-brick", config: {} },
    { id: "test-unverified-brick", config: {} },
  ],
  entities: [],
  workflows: [],
  secretRefs: [],
};

const customCatalog: Record<string, CatalogBrickManifest> = {
  ...DEFAULT_CATALOG,
  "test-beta-brick": {
    manifestVersion: 2,
    kind: "brick",
    id: "test-beta-brick",
    version: "1.0.0",
    provides: ["test-beta"],
    requires: [],
    migrations: [],
    routePrefixes: ["test-beta"],
    npmDependencies: {},
    settings: {},
    ui: {
      displayName: "Test Beta Brick",
      category: "developer",
      summary: "A brick in beta with tier evidence",
      maturity: "beta",
      derivedTier: "beta",
      blockers: ["ASSERTIONS_BELOW_MIN"],
      evidence: {
        gitSha: "abc1234567890abcdef1234567890abcdef12",
        runAt: "2026-11-08T10:00:00.000Z",
        assertionCount: 15,
      },
    },
    worker: { package: "@poc/test-beta", routes: [] },
  },
  "test-unverified-brick": {
    manifestVersion: 2,
    kind: "brick",
    id: "test-unverified-brick",
    version: "1.0.0",
    provides: ["test-unverified"],
    requires: [],
    migrations: [],
    routePrefixes: ["test-unverified"],
    npmDependencies: {},
    settings: {},
    ui: {
      displayName: "Test Unverified Brick",
      category: "developer",
      summary: "A brick with no tier evidence",
    },
    worker: { package: "@poc/test-unverified", routes: [] },
  },
};

const customIntegrations: Record<
  string,
  { manifest: CatalogIntegrationManifest; nodes?: any[] }
> = {
  ...DEFAULT_INTEGRATIONS,
  "stripe-live": {
    manifest: {
      manifestVersion: 2,
      kind: "integration",
      app: "stripe-live",
      version: "1.0.0",
      ui: {
        displayName: "Stripe Live",
        category: "billing",
        summary: "Live stripe integration",
        maturity: "beta",
        derivedTier: "beta",
        blockers: ["LIVE_CANARY_STALE"],
        evidence: {
          gitSha: "def5678901234567890abcdef1234567890ab",
          runAt: "2026-11-08T10:00:00.000Z",
          assertionCount: 42,
          liveVerifiedAt: "2026-11-08T09:00:00.000Z",
        },
      },
      auth: { type: "apiKey" },
      baseUrl: "https://api.stripe.com",
      operations: [],
    },
  },
  "discord-stale": {
    manifest: {
      manifestVersion: 2,
      kind: "integration",
      app: "discord-stale",
      version: "1.0.0",
      ui: {
        displayName: "Discord Stale",
        category: "communication",
        summary: "Discord integration never live checked",
        maturity: "beta",
        derivedTier: "beta",
        blockers: ["LIVE_CANARY_STALE"],
        evidence: {
          gitSha: "111222333444555666777888999000aaabbbccc",
          runAt: "2026-11-08T10:00:00.000Z",
          assertionCount: 20,
          liveVerifiedAt: null,
        },
      },
      auth: { type: "none" },
      baseUrl: "https://discord.com",
      operations: [],
    },
  },
  "unverified-integration": {
    manifest: {
      manifestVersion: 2,
      kind: "integration",
      app: "unverified-integration",
      version: "1.0.0",
      ui: {
        displayName: "Unverified Integration",
        category: "communication",
        summary: "Integration with no evidence",
        maturity: "production",
      },
      auth: { type: "none" },
      baseUrl: "https://example.com",
      operations: [],
    },
  },
};

describe("UC5.7: Studio shows tier evidence (derived tier, last run SHA/date, live check)", () => {
  beforeEach(() => {
    useStudioStore.getState().resetStore();
  });

  afterEach(() => {
    cleanup();
  });

  it("Task 1 & AC1, AC2, AC3: BricksView renders brick row and integration row with derived tier, evidence details popover, live check, and unverified fallback", () => {
    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "builder@example.com", name: "Builder" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      projectState: sampleBlueprint,
      catalog: customCatalog,
      activeNav: "bricks",
    });
    (useStudioStore as any).setState({ integrations: customIntegrations });

    render(<BricksView />);

    // 1. Brick row with derivedTier: "beta", blockers: ["ASSERTIONS_BELOW_MIN"], evidence: { gitSha, runAt }
    const betaBrickBadge = screen.getByTestId("enabled-brick-maturity-test-beta-brick");
    expect(betaBrickBadge.textContent).toContain("Beta");

    // Open details popover
    fireEvent.click(betaBrickBadge);
    expect(screen.getByText(/Verified at abc1234 on 2026-11-08/i)).toBeDefined();
    expect(
      screen.getByText(/Test assertions below production minimum/i),
    ).toBeDefined();

    // 2. Integration row with liveVerifiedAt
    const stripeIntegrationBadge = screen.getByTestId(
      "integration-maturity-stripe-live",
    );
    expect(stripeIntegrationBadge.textContent).toContain("Beta");

    fireEvent.click(stripeIntegrationBadge);
    expect(screen.getByText(/Verified at def5678 on 2026-11-08/i)).toBeDefined();
    expect(screen.getByText(/Live check: 2026-11-08/i)).toBeDefined();

    // 3. Integration row without liveVerifiedAt shows "Never live-checked" (AC3)
    const discordIntegrationBadge = screen.getByTestId(
      "integration-maturity-discord-stale",
    );
    expect(discordIntegrationBadge.textContent).toContain("Beta");
    fireEvent.click(discordIntegrationBadge);
    expect(screen.getByText(/Never live-checked/i)).toBeDefined();

    // 4. Row without evidence shows "Unverified", not "Production" (AC1, AC2)
    const unverifiedBrickBadge = screen.getByTestId(
      "enabled-brick-maturity-test-unverified-brick",
    );
    expect(unverifiedBrickBadge.textContent).toContain("Unverified");
    expect(unverifiedBrickBadge.textContent).not.toContain("Production");

    const unverifiedIntBadge = screen.getByTestId(
      "integration-maturity-unverified-integration",
    );
    expect(unverifiedIntBadge.textContent).toContain("Unverified");
    expect(unverifiedIntBadge.textContent).not.toContain("Production");
  });

  it("MaturityBadge standalone unit tests: handles derivedTier, evidence formatting, blockers, and unverified fallback", () => {
    // Row without evidence must show Unverified, not Production (AC1, AC2)
    const { unmount } = render(
      <MaturityBadge
        testId="badge-no-evidence"
        tier="production"
      />,
    );
    const badgeNoEv = screen.getByTestId("badge-no-evidence");
    expect(badgeNoEv.textContent).toContain("Unverified");
    expect(badgeNoEv.textContent).not.toContain("Production");
    unmount();

    // With evidence and derivedTier: "production"
    render(
      <MaturityBadge
        testId="badge-prod"
        tier="production"
        derivedTier="production"
        evidence={{
          gitSha: "1234567890abcdef",
          runAt: "2026-11-08T12:00:00.000Z",
          assertionCount: 30,
        }}
      />,
    );
    const badgeProd = screen.getByTestId("badge-prod");
    expect(badgeProd.textContent).toContain("Production");
    fireEvent.click(badgeProd);
    expect(screen.getByText(/Verified at 1234567 on 2026-11-08/i)).toBeDefined();
  });
});
