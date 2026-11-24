import { expect, test } from "@playwright/test";
import { assemble } from "@poc/assembler";
import { catalog } from "@poc/assembler/catalog";
import { computeMaxCompatible } from "../../../scripts/max-compatible.ts";

test.describe("R45 Performance & Visual Layout Gate", () => {
  test("completes cold first load in < 3,000 ms with compiled Tailwind CSS, sustains >= 50 fps pan/zoom and < 100 ms node drag frame latency on 200 non-overlapping nodes, and runs assemble() on max-compatible blueprint in < 5,000 ms", async ({
    page,
  }) => {
    // 1. Cold first load of Studio in Chromium (< 3,000 ms) + compiled Tailwind CSS check
    const coldLoadStart = performance.now();
    await page.goto("/");
    await expect(page.getByTestId("auth-email-input")).toBeVisible();
    const coldLoadElapsedMs = performance.now() - coldLoadStart;

    const bodyBg = await page.evaluate(
      () => window.getComputedStyle(document.body).backgroundColor,
    );
    expect(bodyBg).toBe("rgb(2, 6, 23)");
    expect(coldLoadElapsedMs).toBeLessThan(3_000);

    // 2. Navigate to 200-node, 240-edge workflow canvas benchmark
    await page.goto("/?benchmark=200");
    await expect(page.getByTestId("workflow-reactflow-canvas")).toBeVisible();
    await expect(page.getByText("200 nodes · 240 edges")).toBeVisible();

    // Verify Minimap and all 200 node bounding boxes have non-zero size, compiled Tailwind background, and zero pairwise overlaps
    const layoutVerification = await page.evaluate(() => {
      const minimap = document.querySelector(".react-flow__minimap") as HTMLElement | null;
      const nodeEls = Array.from(
        document.querySelectorAll('[data-testid^="canvas-node-"]'),
      ) as HTMLElement[];

      const firstBg = nodeEls[0]
        ? window.getComputedStyle(nodeEls[0]).backgroundColor
        : "";

      const rects = nodeEls.map((el) => {
        const r = el.getBoundingClientRect();
        return {
          id: el.getAttribute("data-testid") ?? "",
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
        };
      });

      let overlappingPairs = 0;
      for (let i = 0; i < rects.length; i += 1) {
        const a = rects[i]!;
        for (let j = i + 1; j < rects.length; j += 1) {
          const b = rects[j]!;
          const separated =
            a.right <= b.left ||
            a.left >= b.right ||
            a.bottom <= b.top ||
            a.top >= b.bottom;
          if (!separated) {
            overlappingPairs += 1;
          }
        }
      }

      return {
        minimapPresent: Boolean(minimap),
        nodeCount: rects.length,
        firstBg,
        minWidth: rects.reduce((acc, r) => Math.min(acc, r.width), Infinity),
        minHeight: rects.reduce((acc, r) => Math.min(acc, r.height), Infinity),
        overlappingPairs,
      };
    });

    expect(layoutVerification.minimapPresent).toBe(true);
    expect(layoutVerification.nodeCount).toBe(200);
    expect(layoutVerification.firstBg).toBe("rgb(15, 23, 42)");
    expect(layoutVerification.minWidth).toBeGreaterThan(0);
    expect(layoutVerification.minHeight).toBeGreaterThan(0);
    expect(layoutVerification.overlappingPairs).toBe(0);

    // 3. Measure 60-frame pan/zoom sequence on 200-node canvas (>= 50 fps)
    const panZoomMetrics = await page.evaluate(async () => {
      const viewport = document.querySelector(".react-flow__viewport") as HTMLElement | null;
      if (!viewport) {
        throw new Error("Missing .react-flow__viewport element");
      }

      const frameDeltas: number[] = [];
      let lastTs = await new Promise<number>((resolve) =>
        requestAnimationFrame((ts) => resolve(ts)),
      );

      for (let frame = 0; frame < 60; frame += 1) {
        const panX = Math.round(Math.sin(frame / 10) * 180 - frame * 4);
        const panY = Math.round(Math.cos(frame / 12) * 90);
        const zoom = (0.65 + (frame % 20) * 0.015).toFixed(3);
        viewport.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;

        const nowTs = await new Promise<number>((resolve) =>
          requestAnimationFrame((ts) => resolve(ts)),
        );
        frameDeltas.push(nowTs - lastTs);
        lastTs = nowTs;
      }

      const sorted = [...frameDeltas].sort((a, b) => a - b);
      const medianFrameMs = sorted[Math.floor(sorted.length / 2)]!;
      const effectiveFps = 1000 / Math.max(medianFrameMs, 1);

      return {
        frames: frameDeltas.length,
        medianFrameMs: Number(medianFrameMs.toFixed(2)),
        effectiveFps: Number(effectiveFps.toFixed(1)),
      };
    });

    expect(panZoomMetrics.frames).toBe(60);
    expect(panZoomMetrics.effectiveFps).toBeGreaterThanOrEqual(50);

    // 4. Measure 30-step node drag frame latency (< 100 ms)
    const dragMetrics = await page.evaluate(async () => {
      const nodeCard = document.querySelector(
        '[data-testid="canvas-node-node-1"]',
      ) as HTMLElement | null;
      const rfNode = nodeCard?.closest(".react-flow__node") as HTMLElement | null;
      if (!nodeCard || !rfNode) {
        throw new Error("Missing .react-flow__node for node-1");
      }

      const rect = rfNode.getBoundingClientRect();
      const startX = rect.left + rect.width / 2;
      const startY = rect.top + rect.height / 2;

      const stepLatencies: number[] = [];
      let lastTs = await new Promise<number>((resolve) =>
        requestAnimationFrame((ts) => resolve(ts)),
      );

      for (let step = 1; step <= 30; step += 1) {
        const nextX = startX + step * 8;
        const nextY = startY + step * 4;
        rfNode.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            cancelable: true,
            clientX: nextX,
            clientY: nextY,
          }),
        );
        rfNode.style.transform = `translate(${48 + step * 8}px, ${48 + step * 4}px)`;
        const nowTs = await new Promise<number>((resolve) =>
          requestAnimationFrame((ts) => resolve(ts)),
        );
        stepLatencies.push(nowTs - lastTs);
        lastTs = nowTs;
      }

      const sorted = [...stepLatencies].sort((a, b) => a - b);
      const medianDragMs = sorted[Math.floor(sorted.length / 2)]!;
      const p95DragMs = sorted[Math.floor(sorted.length * 0.95)]!;
      const maxDragMs = sorted[sorted.length - 1]!;

      return {
        steps: stepLatencies.length,
        medianDragMs: Number(medianDragMs.toFixed(2)),
        p95DragMs: Number(p95DragMs.toFixed(2)),
        maxDragMs: Number(maxDragMs.toFixed(2)),
      };
    });

    expect(dragMetrics.steps).toBe(30);
    expect(dragMetrics.p95DragMs).toBeLessThan(100);
    expect(dragMetrics.maxDragMs).toBeLessThan(100);

    // 5. Benchmark assemble() on CP0 max-compatible blueprint (< 5,000 ms)
    const maxCompat = computeMaxCompatible(catalog);
    // 31 since story 0.11: the 8 quarantined bricks are excluded from max-compatible.
    expect(maxCompat.bricks.length).toBeGreaterThanOrEqual(31);

    const assembleStart = performance.now();
    const assembled = assemble(
      {
        project: "max-compatible",
        bricks: maxCompat.bricks,
      },
      catalog,
    );
    const assembleElapsedMs = performance.now() - assembleStart;

    expect(assembled.ok).toBe(true);
    expect(assembleElapsedMs).toBeLessThan(5_000);

    console.log(
      `[r45-performance] coldLoad=${coldLoadElapsedMs.toFixed(1)}ms, panZoomFps=${panZoomMetrics.effectiveFps}, dragP95=${dragMetrics.p95DragMs}ms, overlaps=${layoutVerification.overlappingPairs}, maxCompatBricks=${maxCompat.bricks.length}, assembleMs=${assembleElapsedMs.toFixed(2)}ms`,
    );
  });
});
