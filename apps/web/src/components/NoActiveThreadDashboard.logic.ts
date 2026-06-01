import type { SidebarThreadSummary } from "../types";

interface ThreadSortEntry {
  thread: SidebarThreadSummary;
  score: number;
  updatedAtMs: number;
}

export interface NoActiveThreadDashboardSummary {
  pendingApprovalCount: number;
  awaitingInputCount: number;
  planReadyCount: number;
  runningCount: number;
}

function parseIsoDateMs(isoDate: string | null | undefined): number {
  if (!isoDate) return 0;
  const value = Date.parse(isoDate);
  return Number.isNaN(value) ? 0 : value;
}

function threadUpdatedAtMs(thread: SidebarThreadSummary): number {
  return parseIsoDateMs(thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt);
}

function threadPriorityScore(thread: SidebarThreadSummary): number {
  if (thread.hasPendingApprovals) return 500;
  if (thread.hasPendingUserInput) return 400;
  if (thread.hasActionableProposedPlan) return 300;
  if (thread.session?.status === "running") return 200;
  if (thread.session?.status === "connecting") return 100;
  return 0;
}

function sortThreadEntries(entries: ReadonlyArray<ThreadSortEntry>): SidebarThreadSummary[] {
  return entries
    .toSorted((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      if (right.updatedAtMs !== left.updatedAtMs) {
        return right.updatedAtMs - left.updatedAtMs;
      }

      return left.thread.id.localeCompare(right.thread.id);
    })
    .map((entry) => entry.thread);
}

export function summarizeNoActiveThreadDashboard(
  threads: ReadonlyArray<SidebarThreadSummary>,
): NoActiveThreadDashboardSummary {
  return threads.reduce<NoActiveThreadDashboardSummary>(
    (summary, thread) => ({
      pendingApprovalCount: summary.pendingApprovalCount + (thread.hasPendingApprovals ? 1 : 0),
      awaitingInputCount: summary.awaitingInputCount + (thread.hasPendingUserInput ? 1 : 0),
      planReadyCount: summary.planReadyCount + (thread.hasActionableProposedPlan ? 1 : 0),
      runningCount: summary.runningCount + (thread.session?.status === "running" ? 1 : 0),
    }),
    {
      pendingApprovalCount: 0,
      awaitingInputCount: 0,
      planReadyCount: 0,
      runningCount: 0,
    },
  );
}

export function selectFocusThreads(
  threads: ReadonlyArray<SidebarThreadSummary>,
  limit = 6,
): SidebarThreadSummary[] {
  if (limit <= 0 || threads.length === 0) return [];

  const scored = threads
    .map((thread) => ({
      thread,
      score: threadPriorityScore(thread),
      updatedAtMs: threadUpdatedAtMs(thread),
    }))
    .filter((entry) => entry.score > 0);

  return sortThreadEntries(scored).slice(0, limit);
}

export function selectRecentThreads(
  threads: ReadonlyArray<SidebarThreadSummary>,
  limit = 8,
): SidebarThreadSummary[] {
  if (limit <= 0 || threads.length === 0) return [];

  const scored = threads.map((thread) => ({
    thread,
    score: 0,
    updatedAtMs: threadUpdatedAtMs(thread),
  }));
  return sortThreadEntries(scored).slice(0, limit);
}
