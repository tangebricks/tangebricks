import { createRequire } from "node:module";
import { resolve } from "node:path";

try {
  const req = createRequire(resolve(process.cwd(), "packages/deploy/package.json"));
  const mfMod = req("miniflare") as {
    Miniflare?: { prototype?: { dispose?: () => Promise<void> } };
  };
  const proto = mfMod.Miniflare?.prototype;
  const origDispose = proto?.dispose;
  if (proto && typeof origDispose === "function") {
    proto.dispose = async function disposeWithTimeout(this: unknown): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          origDispose.call(this),
          new Promise<void>((resolveTimer) => {
            timer = setTimeout(resolveTimer, 5_000);
            timer.unref?.();
          }),
        ]);
      } catch {
        // Ignore Windows workerd EBUSY/teardown errors on dispose
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
  }
} catch {
  // Ignore if miniflare is not installed in current context
}
