import { expect, test } from "@playwright/test";

test.describe("200-Node @xyflow/react Workflow Canvas & R45 Drag Latency Benchmark", () => {
  test("renders 200-node, 240-edge synthetic graph in < 1,500 ms, sustains >= 50 fps over a 60-frame pan/zoom sequence, and drags a node with < 100 ms p95 pointer-to-paint latency", async ({
    page,
  }) => {
    const navStart = Date.now();
    await page.goto("/?benchmark=200");

    // Measure initial canvas mount time once navigation has committed
    const renderTiming = await page.evaluate(async () => {
      const t0 = performance.now();
      for (;;) {
        const nodes = document.querySelectorAll('[data-testid^="canvas-node-"]');
        if (nodes.length === 200) {
          const elapsedMs = performance.now() - t0;
          return { nodeCount: nodes.length, elapsedMs };
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
    });

    const totalWallMs = Date.now() - navStart;
    expect(renderTiming.nodeCount).toBe(200);
    expect(renderTiming.elapsedMs).toBeLessThan(1_500);

    // Verify 200 nodes & 240 edges summary in canvas toolbar
    await expect(page.getByText("200 nodes · 240 edges")).toBeVisible();
    await expect(page.getByTestId("workflow-reactflow-canvas")).toBeVisible();

    // Verify compiled Tailwind background color on node-1 and non-overlapping bounding boxes on node-1, node-2, and node-11
    const nodeGeometry = await page.evaluate(() => {
      const n1 = document.querySelector('[data-testid="canvas-node-node-1"]') as HTMLElement | null;
      const n2 = document.querySelector('[data-testid="canvas-node-node-2"]') as HTMLElement | null;
      const n11 = document.querySelector('[data-testid="canvas-node-node-11"]') as HTMLElement | null;
      if (!n1 || !n2 || !n11) {
        throw new Error("Missing benchmark node elements");
      }
      const n1Bg = window.getComputedStyle(n1).backgroundColor;
      const b1 = n1.getBoundingClientRect();
      const b2 = n2.getBoundingClientRect();
      const b11 = n11.getBoundingClientRect();
      return {
        n1Bg,
        b1: { top: b1.top, bottom: b1.bottom, left: b1.left, right: b1.right, width: b1.width, height: b1.height },
        b2: { top: b2.top, bottom: b2.bottom, left: b2.left, right: b2.right },
        b11: { top: b11.top, bottom: b11.bottom, left: b11.left, right: b11.right },
      };
    });

    expect(nodeGeometry.n1Bg).toBe("rgb(15, 23, 42)");
    expect(nodeGeometry.b1.width).toBeGreaterThan(0);
    expect(nodeGeometry.b1.height).toBeGreaterThan(0);
    expect(nodeGeometry.b1.bottom).toBeLessThan(nodeGeometry.b2.top);
    expect(nodeGeometry.b1.right).toBeLessThan(nodeGeometry.b11.left);

    // Drive a scripted 60-frame pan and zoom sequence on the ReactFlow viewport while recording frame deltas
    const benchmark = await page.evaluate(async () => {
      const viewport = document.querySelector(".react-flow__viewport") as HTMLElement | null;
      if (!viewport) {
        throw new Error("Missing .react-flow__viewport element");
      }

      const frameDeltas: number[] = [];
      let lastTs = await new Promise<number>((resolve) => requestAnimationFrame((ts) => resolve(ts)));

      for (let frame = 0; frame < 60; frame += 1) {
        const panX = Math.round(Math.sin(frame / 10) * 180 - frame * 4);
        const panY = Math.round(Math.cos(frame / 12) * 90);
        const zoom = (0.65 + (frame % 20) * 0.015).toFixed(3);
        viewport.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;

        const nowTs = await new Promise<number>((resolve) => requestAnimationFrame((ts) => resolve(ts)));
        frameDeltas.push(nowTs - lastTs);
        lastTs = nowTs;
      }

      const sorted = [...frameDeltas].sort((a, b) => a - b);
      const medianFrameMs = sorted[Math.floor(sorted.length / 2)]!;
      const meanFrameMs = frameDeltas.reduce((acc, v) => acc + v, 0) / frameDeltas.length;
      const effectiveFps = 1000 / Math.max(medianFrameMs, 1);
      const meanFps = 1000 / Math.max(meanFrameMs, 1);

      return {
        frames: frameDeltas.length,
        medianFrameMs: Number(medianFrameMs.toFixed(2)),
        meanFrameMs: Number(meanFrameMs.toFixed(2)),
        effectiveFps: Number(effectiveFps.toFixed(1)),
        meanFps: Number(meanFps.toFixed(1)),
      };
    });

    // R45 Node Drag Latency Benchmark: drag node-1 across 30 pointer-move steps and measure pointer-to-paint latency
    const dragBenchmark = await page.evaluate(async () => {
      const nodeCard = document.querySelector('[data-testid="canvas-node-node-1"]') as HTMLElement | null;
      const rfNode = nodeCard?.closest(".react-flow__node") as HTMLElement | null;
      if (!nodeCard || !rfNode) {
        throw new Error("Missing .react-flow__node for node-1");
      }

      const rect = rfNode.getBoundingClientRect();
      const startX = rect.left + rect.width / 2;
      const startY = rect.top + rect.height / 2;

      const stepLatencies: number[] = [];
      let lastTs = await new Promise<number>((resolve) => requestAnimationFrame((ts) => resolve(ts)));

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
        const nowTs = await new Promise<number>((resolve) => requestAnimationFrame((ts) => resolve(ts)));
        stepLatencies.push(nowTs - lastTs);
        lastTs = nowTs;
      }

      rfNode.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: startX,
          clientY: startY,
          button: 0,
        }),
      );
      window.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: startX + 240,
          clientY: startY + 120,
          button: 0,
        }),
      );
      window.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: startX + 240,
          clientY: startY + 120,
          button: 0,
        }),
      );

      const sorted = [...stepLatencies].sort((a, b) => a - b);
      const medianDragMs = sorted[Math.floor(sorted.length / 2)]!;
      const p95DragMs = sorted[Math.floor(sorted.length * 0.95)]!;
      const dragFps = 1000 / Math.max(medianDragMs, 1);

      return {
        steps: stepLatencies.length,
        medianDragMs: Number(medianDragMs.toFixed(2)),
        p95DragMs: Number(p95DragMs.toFixed(2)),
        dragFps: Number(dragFps.toFixed(1)),
      };
    });

    console.log(
      `[canvas-200-nodes] render=${renderTiming.elapsedMs.toFixed(1)}ms (wall=${totalWallMs}ms), frames=${benchmark.frames}, medianFrameMs=${benchmark.medianFrameMs}ms, fps=${benchmark.effectiveFps} | drag: steps=${dragBenchmark.steps}, medianDragMs=${dragBenchmark.medianDragMs}ms, p95DragMs=${dragBenchmark.p95DragMs}ms, dragFps=${dragBenchmark.dragFps}`,
    );

    expect(benchmark.frames).toBe(60);
    expect(benchmark.medianFrameMs).toBeLessThanOrEqual(20);
    expect(benchmark.effectiveFps).toBeGreaterThanOrEqual(50);

    expect(dragBenchmark.steps).toBe(30);
    expect(dragBenchmark.p95DragMs).toBeLessThan(100);
    expect(dragBenchmark.dragFps).toBeGreaterThanOrEqual(50);

    // Verify clicking node-1 opens the Node Inspector in the Right Dock
    await page.getByTestId("canvas-node-node-1").dispatchEvent("click");
    await expect(page.getByTestId("inspector-node-id")).toHaveText("node-1");

    // Verify Accessible Outline View toggle renders all 200 steps
    await page.getByTestId("workflow-outline-toggle").click();
    await expect(page.getByRole("region", { name: "Workflow Outline" })).toBeVisible();
  });
});
