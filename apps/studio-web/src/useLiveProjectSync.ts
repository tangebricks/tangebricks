import { useEffect } from "react";
import {
  fetchProjectDetail,
  fetchProjectRevisions,
  fetchTelemetryEvents,
} from "./api.ts";
import type { StructuredLogEntryPayload } from "./api.ts";
import { useStudioStore } from "./store.ts";
import type { IncomingRevisionEnvelope, IncomingTelemetryFrame } from "./store.ts";
import type { ProposalRecord, ReadinessResult } from "./types.ts";

type WsFrame =
  | {
      type: "connected";
      project: string;
      currentRevision: number;
      semanticHash: string;
      readiness: ReadinessResult;
    }
  | ({
      type: "revision";
    } & IncomingRevisionEnvelope)
  | {
      type: "catchup";
      fromRevision: number;
      toRevision: number;
      revisions: IncomingRevisionEnvelope[];
    }
  | {
      type: "proposal";
      action: "created" | "accepted" | "partially_accepted" | "rejected";
      project: string;
      proposal: ProposalRecord;
    }
  | IncomingTelemetryFrame
  | {
      type: "log";
      project: string;
      envName?: "preview" | "production";
      entry: StructuredLogEntryPayload;
    }
  | {
      type: "pong";
    }
  | {
      type: "error";
      code: string;
      message: string;
    };

export function useLiveProjectSync(enabled = true) {
  const user = useStudioStore((s) => s.user);
  const activeProjectId = useStudioStore((s) => s.activeProjectId);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    useStudioStore.getState().setPrefersReducedMotion(Boolean(mql.matches));
    const onChange = (e: MediaQueryListEvent) => {
      useStudioStore.getState().setPrefersReducedMotion(Boolean(e.matches));
    };
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    return undefined;
  }, []);

  useEffect(() => {
    if (!enabled || !user || !activeProjectId) return;
    if (typeof window === "undefined" || typeof WebSocket === "undefined") return;
    // Skip real WebSocket connections in synthetic benchmark mode or non-http environments
    if (
      window.location.search.includes("benchmark=200") ||
      (!window.location.protocol.startsWith("http") &&
        window.location.hostname !== "localhost" &&
        window.location.hostname !== "127.0.0.1")
    ) {
      return;
    }

    let disposed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let wsRevisionSeen = -1;

    const syncLatestFromHttp = () => {
      Promise.all([
        fetchProjectDetail(activeProjectId).catch(() => null),
        fetchProjectRevisions(activeProjectId).catch(() => []),
      ]).then(([detail, revs]) => {
        if (disposed) return;
        const store = useStudioStore.getState();
        if (store.activeProjectId !== activeProjectId) return;
        if (detail && detail.state && Array.isArray(detail.state.bricks)) {
          if (detail.revision >= wsRevisionSeen) {
            store.setProjectData({
              project: detail.project,
              revision: detail.revision,
              state: detail.state,
              readiness: detail.readiness,
              revisions: Array.isArray(revs) ? revs : undefined,
            });
          }
        } else if (Array.isArray(revs) && revs.length > 0 && wsRevisionSeen < 0) {
          store.setRevisions(revs);
        }
        void store.loadProjectProposals();
        void store.loadProjectActivity();
      });
    };

    // Fetch latest project state & revisions on mount / project switch if server is available
    syncLatestFromHttp();

    const connect = () => {
      if (disposed) return;
      const sinceRev = wsRevisionSeen >= 0 ? wsRevisionSeen : 0;
      const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${wsProto}//${window.location.host}/api/projects/${encodeURIComponent(
        activeProjectId,
      )}/ws?sinceRevision=${sinceRev}`;

      try {
        ws = new WebSocket(wsUrl);
      } catch {
        return;
      }

      ws.addEventListener("open", () => {
        if (disposed) return;
        attempt = 0;
        useStudioStore.getState().setSyncStatus("Live");
        const cursor = useStudioStore.getState().lastTelemetryCursor;
        fetchTelemetryEvents(activeProjectId, { after: cursor })
          .then((page) => {
            if (!disposed && Array.isArray(page.events) && page.events.length > 0) {
              useStudioStore.getState().reconcileTelemetryEvents(page.events);
            }
          })
          .catch(() => {
            // Ignore cursor reconciliation errors when offline
          });
      });

      ws.addEventListener("message", (event) => {
        if (disposed) return;
        try {
          const frame = JSON.parse(String(event.data)) as WsFrame;
          if (frame.type === "connected") {
            useStudioStore.getState().setSyncStatus("Live");
            if (
              typeof frame.currentRevision === "number" &&
              frame.currentRevision > useStudioStore.getState().currentRevision
            ) {
              syncLatestFromHttp();
            }
          } else if (frame.type === "revision") {
            wsRevisionSeen = Math.max(wsRevisionSeen, frame.revision);
            useStudioStore.getState().applyIncomingRevision(frame);
          } else if (frame.type === "catchup" && Array.isArray(frame.revisions)) {
            for (const rev of frame.revisions) {
              wsRevisionSeen = Math.max(wsRevisionSeen, rev.revision);
            }
            useStudioStore.getState().applyIncomingCatchup(frame.revisions);
          } else if (frame.type === "proposal" && frame.proposal) {
            useStudioStore.getState().applyIncomingProposalFrame(frame);
          } else if (frame.type === "telemetry") {
            useStudioStore.getState().applyIncomingTelemetryFrame(frame);
          } else if (frame.type === "log" && frame.entry) {
            window.dispatchEvent(
              new CustomEvent("px-studio-log-frame", { detail: frame }),
            );
          }
        } catch {
          // Ignore malformed frames
        }
      });

      ws.addEventListener("close", () => {
        if (disposed) return;
        attempt += 1;
        // Only flip to Connecting... if we previously connected or on active server
        if (attempt > 2) {
          useStudioStore.getState().setSyncStatus("Connecting…");
        }
        const delayMs = Math.min(250 * 2 ** Math.min(attempt, 4), 2_000);
        reconnectTimer = setTimeout(connect, delayMs);
      });
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        try {
          ws.close();
        } catch {
          // Ignore close error
        }
      }
    };
  }, [enabled, user, activeProjectId]);
}
