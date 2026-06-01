import { EnvironmentId, ProjectId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import type { SidebarThreadSummary } from "../types";
import { describe, expect, it } from "vitest";
import {
  selectFocusThreads,
  selectRecentThreads,
  summarizeNoActiveThreadDashboard,
} from "./NoActiveThreadDashboard.logic";

function makeThread(
  id: string,
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
  return {
    id: ThreadId.make(id),
    environmentId: EnvironmentId.make("env_1"),
    projectId: ProjectId.make("project_1"),
    title: id,
    interactionMode: "default",
    session: null,
    createdAt: "2026-05-01T12:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-05-01T12:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("summarizeNoActiveThreadDashboard", () => {
  it("counts key workflow states", () => {
    const summary = summarizeNoActiveThreadDashboard([
      makeThread("approval", { hasPendingApprovals: true }),
      makeThread("input", { hasPendingUserInput: true }),
      makeThread("plan", { hasActionableProposedPlan: true }),
      makeThread("running", {
        session: {
          provider: ProviderDriverKind.make("codex"),
          status: "running",
          createdAt: "2026-05-01T12:00:00.000Z",
          updatedAt: "2026-05-01T12:00:00.000Z",
          orchestrationStatus: "running",
        },
      }),
    ]);

    expect(summary).toEqual({
      pendingApprovalCount: 1,
      awaitingInputCount: 1,
      planReadyCount: 1,
      runningCount: 1,
    });
  });
});

describe("selectFocusThreads", () => {
  it("prioritizes approvals, then input, then plan-ready, then running", () => {
    const threads = [
      makeThread("running", {
        session: {
          provider: ProviderDriverKind.make("codex"),
          status: "running",
          createdAt: "2026-05-01T12:00:00.000Z",
          updatedAt: "2026-05-01T12:00:00.000Z",
          orchestrationStatus: "running",
        },
        latestUserMessageAt: "2026-05-01T12:20:00.000Z",
      }),
      makeThread("plan", {
        hasActionableProposedPlan: true,
        latestUserMessageAt: "2026-05-01T12:30:00.000Z",
      }),
      makeThread("input", {
        hasPendingUserInput: true,
        latestUserMessageAt: "2026-05-01T12:40:00.000Z",
      }),
      makeThread("approval", {
        hasPendingApprovals: true,
        latestUserMessageAt: "2026-05-01T12:10:00.000Z",
      }),
    ];

    expect(selectFocusThreads(threads).map((thread) => thread.id)).toEqual([
      "approval",
      "input",
      "plan",
      "running",
    ]);
  });
});

describe("selectRecentThreads", () => {
  it("orders by latest activity time descending", () => {
    const threads = [
      makeThread("old", { latestUserMessageAt: "2026-05-01T12:01:00.000Z" }),
      makeThread("newer", { latestUserMessageAt: "2026-05-01T12:03:00.000Z" }),
      makeThread("newest", { latestUserMessageAt: "2026-05-01T12:05:00.000Z" }),
    ];

    expect(selectRecentThreads(threads).map((thread) => thread.id)).toEqual([
      "newest",
      "newer",
      "old",
    ]);
  });
});
