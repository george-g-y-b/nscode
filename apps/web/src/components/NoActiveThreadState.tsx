import { scopeThreadRef } from "@t3tools/client-runtime";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { JiraTicketSummary, MyWorkPullRequest } from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  ListTodoIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  Settings2Icon,
  SparklesIcon,
  SquarePenIcon,
  TicketIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ensureLocalApi } from "../localApi";
import { useClientSettingsHydrated, useSettings, useUpdateSettings } from "../hooks/useSettings";
import { buildThreadRouteParams } from "../threadRoutes";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { isElectron } from "../env";
import {
  selectFocusThreads,
  selectRecentThreads,
  summarizeNoActiveThreadDashboard,
} from "./NoActiveThreadDashboard.logic";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { Input } from "./ui/input";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";
import { Textarea } from "./ui/textarea";
import { cn } from "~/lib/utils";

const WORKFLOW_PROMPTS = [
  {
    id: "jira-implementation",
    stage: "Planning",
    label: "Plan from Jira Ticket",
    prompt:
      "Use this Jira ticket as the source of truth. Summarize requirements, identify risks, propose an implementation plan, then ask for approval before changing code.",
  },
  {
    id: "pickup-ticket",
    stage: "Pickup",
    label: "Pick Up Next Ticket",
    prompt:
      "Pick the highest-priority unassigned sprint ticket, summarize the scope, create a concise implementation plan, and start on the first safe step.",
  },
  {
    id: "ready-for-review",
    stage: "Development",
    label: "Ready for Review",
    prompt:
      "Prepare this branch for review: run checks, summarize behavior changes, propose reviewers, and list exact Jira updates to post.",
  },
  {
    id: "request-ai-review",
    stage: "Code Review",
    label: "AI Review Pass",
    prompt:
      "Review this branch for correctness, regressions, test gaps, and risky assumptions. Prioritize findings by severity and include concrete file references.",
  },
  {
    id: "review-followups",
    stage: "Code Review",
    label: "Address Review Feedback",
    prompt:
      "Walk through pending review comments, propose replies and code changes, then implement the agreed fixes and summarize what changed.",
  },
  {
    id: "request-human-review",
    stage: "QA",
    label: "Prepare PR for Human Review",
    prompt:
      "Prepare this work for human code review. Summarize behavior changes, list migration concerns, and propose focused test scenarios reviewers should run.",
  },
  {
    id: "qa-handoff-check",
    stage: "QA",
    label: "QA Handoff Checklist",
    prompt:
      "Before moving this ticket to QA, verify review state and checks, draft concise QA notes, and list exact validation steps for QA.",
  },
] as const;

const JIRA_ENV_SETUP_TEMPLATE = `export T3CODE_JIRA_BASE_URL="https://your-org.atlassian.net"
export T3CODE_JIRA_EMAIL="you@company.com"
export T3CODE_JIRA_API_TOKEN="your_api_token"
export T3CODE_JIRA_JQL='assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'`;
const HIDDEN_PULL_REQUESTS_STORAGE_KEY = "t3code.hiddenPullRequests";

interface JiraCredentials {
  readonly baseUrl: string;
  readonly email: string;
  readonly apiToken: string;
  readonly jql?: string;
}

function shellQuote(value: string): string {
  const escapedSingleQuote = String.raw`'"'"'`;
  return `'${value.replaceAll("'", escapedSingleQuote)}'`;
}

function resolveThreadStatus(thread: ReturnType<typeof selectRecentThreads>[number]): {
  label: string;
  variant: "warning" | "info" | "success" | "outline";
} {
  if (thread.hasPendingApprovals) {
    return { label: "Pending approval", variant: "warning" };
  }
  if (thread.hasPendingUserInput) {
    return { label: "Awaiting input", variant: "info" };
  }
  if (thread.hasActionableProposedPlan) {
    return { label: "Plan ready", variant: "success" };
  }
  if (thread.session?.status === "running") {
    return { label: "Running", variant: "outline" };
  }
  return { label: "Idle", variant: "outline" };
}

function pullRequestKindLabel(kind: MyWorkPullRequest["kind"]): string {
  return kind === "review_requested" ? "Review requested" : "Authored";
}

function reviewDecisionLabel(
  reviewDecision: MyWorkPullRequest["reviewDecision"] | undefined,
): string | null {
  switch (reviewDecision) {
    case "approved":
      return "Approved";
    case "changes_requested":
      return "Changes requested";
    case "review_required":
      return "Review required";
    case "unknown":
      return "Review unknown";
    default:
      return null;
  }
}

function reviewDecisionBadgeVariant(
  reviewDecision: MyWorkPullRequest["reviewDecision"] | undefined,
): "success" | "warning" | "outline" {
  switch (reviewDecision) {
    case "approved":
      return "success";
    case "changes_requested":
      return "warning";
    default:
      return "outline";
  }
}

function ticketStatusVariant(
  ticket: JiraTicketSummary,
): "success" | "warning" | "info" | "outline" {
  const category = ticket.status.category?.toLowerCase();
  if (category === "done" || category === "completed") return "success";
  if (category === "in progress" || category === "in-progress" || category === "in-flight") {
    return "info";
  }
  if (category === "to do" || category === "todo") return "outline";
  return "warning";
}

function isMobileLabeledTicket(ticket: JiraTicketSummary): boolean {
  return (ticket.labels ?? []).some((label) => label.trim().toLowerCase() === "mobile");
}

function collectLikelyJiraKeys(value: string): ReadonlyArray<string> {
  const matches = value.toUpperCase().match(/\b[A-Z][A-Z0-9]+-\d+\b/gu) ?? [];
  return Array.from(new Set(matches));
}

function buildQaHandoffComment(input: {
  readonly ticket: JiraTicketSummary;
  readonly linkedPullRequests: ReadonlyArray<MyWorkPullRequest>;
  readonly qaNotes: string;
}): string {
  const lines: string[] = [
    "QA handoff request.",
    "",
    `Ticket: ${input.ticket.key} - ${input.ticket.title}`,
  ];
  if (input.linkedPullRequests.length > 0) {
    lines.push("");
    lines.push("Linked pull requests:");
    for (const pullRequest of input.linkedPullRequests) {
      lines.push(
        `- ${pullRequest.repositoryNameWithOwner}#${pullRequest.number}: ${pullRequest.url}`,
      );
    }
  }
  const normalizedNotes = input.qaNotes.trim();
  if (normalizedNotes.length > 0) {
    lines.push("");
    lines.push("QA notes:");
    lines.push(normalizedNotes);
  }
  return lines.join("\n").trim();
}

function buildTicketPrompt(ticket: JiraTicketSummary): string {
  return [
    `Use Jira ticket ${ticket.key} (${ticket.url}) as the source of truth.`,
    `Ticket title: ${ticket.title}`,
    "Summarize scope and constraints, propose a safe implementation plan, then ask before making risky changes.",
  ].join("\n");
}

function buildPullRequestReviewPrompt(pullRequest: MyWorkPullRequest): string {
  return [
    `Review this pull request: ${pullRequest.url}`,
    `Repository: ${pullRequest.repositoryNameWithOwner}`,
    `PR: #${pullRequest.number} - ${pullRequest.title}`,
    "Prioritize correctness risks, regressions, and missing tests. Include file-level findings and concrete recommendations.",
  ].join("\n");
}

function pullRequestStorageKey(pullRequest: MyWorkPullRequest): string {
  return `${pullRequest.repositoryNameWithOwner}#${String(pullRequest.number)}`;
}

function readHiddenPullRequestStorage(): ReadonlySet<string> {
  if (typeof window === "undefined") return new Set<string>();
  try {
    const raw = window.localStorage.getItem(HIDDEN_PULL_REQUESTS_STORAGE_KEY);
    if (!raw) return new Set<string>();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set<string>();
    const keys = parsed
      .map((value) => (typeof value === "string" ? value : null))
      .filter((value): value is string => value !== null && value.length > 0);
    return new Set(keys);
  } catch {
    return new Set<string>();
  }
}

interface JiraBoardScopePickerProps {
  readonly title: string;
  readonly boards: ReadonlyArray<{ readonly id: number; readonly name: string }>;
  readonly selectionMode: "all" | "custom";
  readonly isSelected: (boardId: number) => boolean;
  readonly onSelectAll: () => void;
  readonly onToggleBoard: (boardId: number) => void;
  readonly keyPrefix: string;
}

function JiraBoardScopePicker({
  title,
  boards,
  selectionMode,
  isSelected,
  onSelectAll,
  onToggleBoard,
  keyPrefix,
}: JiraBoardScopePickerProps) {
  const selectedCount =
    selectionMode === "all" ? boards.length : boards.filter((board) => isSelected(board.id)).length;

  return (
    <div className="space-y-2 rounded-md border border-border/65 bg-background/45 px-3 py-3">
      <p className="text-xs font-medium text-foreground">
        {title} ({boards.length})
      </p>
      <p className="text-xs text-muted-foreground">
        {selectionMode === "all"
          ? "Selected: all boards"
          : `Selected: ${selectedCount} of ${boards.length} board${boards.length === 1 ? "" : "s"}`}
      </p>
      {boards.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={selectionMode === "all" ? "secondary" : "outline"}
            onClick={onSelectAll}
          >
            {selectionMode === "all" ? <CheckIcon className="size-3.5" /> : null}
            All boards ({boards.length})
          </Button>
          {boards.map((board) => (
            <Button
              key={`${keyPrefix}-${board.id}`}
              size="sm"
              variant={isSelected(board.id) ? "secondary" : "outline"}
              onClick={() => onToggleBoard(board.id)}
            >
              {isSelected(board.id) ? <CheckIcon className="size-3.5" /> : null}
              {board.name}
            </Button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No Scrum boards discovered for your Jira account.
        </p>
      )}
    </div>
  );
}

export function NoActiveThreadState() {
  const [authoredOpen, setAuthoredOpen] = useState(true);
  const [reviewRequestedOpen, setReviewRequestedOpen] = useState(false);
  const [pickupBoardSettingsOpen, setPickupBoardSettingsOpen] = useState(false);
  const [inFlightBoardSettingsOpen, setInFlightBoardSettingsOpen] = useState(false);
  const [showHiddenPullRequests, setShowHiddenPullRequests] = useState(false);
  const [hiddenPullRequestKeys, setHiddenPullRequestKeys] = useState<ReadonlySet<string>>(() =>
    readHiddenPullRequestStorage(),
  );
  const [showJiraSetupForm, setShowJiraSetupForm] = useState(false);
  const [qaHandoffExpandedTicketKey, setQaHandoffExpandedTicketKey] = useState<string | null>(null);
  const [qaHandoffNotesByTicketKey, setQaHandoffNotesByTicketKey] = useState<
    Readonly<Record<string, string>>
  >({});
  const [qaHandoffFeedback, setQaHandoffFeedback] = useState<{
    readonly ticketKey: string;
    readonly tone: "success" | "warning";
    readonly message: string;
  } | null>(null);
  const clientSettingsHydrated = useClientSettingsHydrated();
  const { updateSettings } = useUpdateSettings();
  const persistedJiraSettings = useSettings((settings) => ({
    baseUrl: settings.jiraBaseUrl.trim(),
    email: settings.jiraEmail.trim(),
    apiToken: settings.jiraApiToken.trim(),
    jql: settings.jiraJql.trim(),
    pickupBoardIds: settings.jiraPickupBoardIds,
    pickupTicketFilter: settings.jiraPickupTicketFilter,
  }));
  const defaultThreadEnvMode = useSettings((settings) => settings.defaultThreadEnvMode);
  const activeJiraCredentials = useMemo<JiraCredentials | null>(() => {
    if (
      persistedJiraSettings.baseUrl.length === 0 ||
      persistedJiraSettings.email.length === 0 ||
      persistedJiraSettings.apiToken.length === 0
    ) {
      return null;
    }
    return {
      baseUrl: persistedJiraSettings.baseUrl,
      email: persistedJiraSettings.email,
      apiToken: persistedJiraSettings.apiToken,
      ...(persistedJiraSettings.jql.length > 0 ? { jql: persistedJiraSettings.jql } : {}),
    };
  }, [persistedJiraSettings]);
  const [jiraCredentialRevision, setJiraCredentialRevision] = useState(0);
  const [jiraSetupBaseUrl, setJiraSetupBaseUrl] = useState(persistedJiraSettings.baseUrl);
  const [jiraSetupEmail, setJiraSetupEmail] = useState(persistedJiraSettings.email);
  const [jiraSetupApiToken, setJiraSetupApiToken] = useState(persistedJiraSettings.apiToken);
  const [jiraSetupJql, setJiraSetupJql] = useState(
    persistedJiraSettings.jql ||
      "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
  );
  const projects = useStore(useShallow((store) => selectProjectsAcrossEnvironments(store)));
  const threads = useStore(useShallow((store) => selectSidebarThreadsAcrossEnvironments(store)));
  const projectNamesByKey = useMemo(
    () =>
      new Map(
        projects.map((project) => [
          `${project.environmentId}:${project.id}`,
          project.name || project.cwd,
        ]),
      ),
    [projects],
  );
  const summary = useMemo(() => summarizeNoActiveThreadDashboard(threads), [threads]);
  const focusThreads = useMemo(() => selectFocusThreads(threads), [threads]);
  const recentThreads = useMemo(() => selectRecentThreads(threads), [threads]);
  const showLegacyEmptyState = projects.length === 0 && threads.length === 0;
  useEffect(() => {
    if (!jiraSetupBaseUrl && persistedJiraSettings.baseUrl) {
      setJiraSetupBaseUrl(persistedJiraSettings.baseUrl);
    }
    if (!jiraSetupEmail && persistedJiraSettings.email) {
      setJiraSetupEmail(persistedJiraSettings.email);
    }
    if (!jiraSetupApiToken && persistedJiraSettings.apiToken) {
      setJiraSetupApiToken(persistedJiraSettings.apiToken);
    }
    if (!jiraSetupJql && persistedJiraSettings.jql) {
      setJiraSetupJql(persistedJiraSettings.jql);
    }
  }, [jiraSetupApiToken, jiraSetupBaseUrl, jiraSetupEmail, jiraSetupJql, persistedJiraSettings]);
  const persistJiraCredentials = useCallback(
    (next: JiraCredentials | null) => {
      if (!next) {
        updateSettings({
          jiraBaseUrl: "",
          jiraEmail: "",
          jiraApiToken: "",
          jiraJql: "",
        });
      } else {
        updateSettings({
          jiraBaseUrl: next.baseUrl,
          jiraEmail: next.email,
          jiraApiToken: next.apiToken,
          jiraJql: next.jql ?? "",
        });
      }
      setJiraCredentialRevision((revision) => revision + 1);
    },
    [updateSettings],
  );
  const myWorkQuery = useQuery({
    queryKey: [
      "server",
      "my-work",
      jiraCredentialRevision,
      activeJiraCredentials?.baseUrl ?? null,
      activeJiraCredentials?.email ?? null,
      activeJiraCredentials?.jql ?? null,
      persistedJiraSettings.pickupBoardIds,
    ],
    queryFn: () =>
      ensureLocalApi().server.getMyWork(
        activeJiraCredentials
          ? {
              jiraBaseUrl: activeJiraCredentials.baseUrl,
              jiraEmail: activeJiraCredentials.email,
              jiraApiToken: activeJiraCredentials.apiToken,
              jiraJql: activeJiraCredentials.jql,
              ...(persistedJiraSettings.pickupBoardIds.length > 0
                ? { jiraPickupBoardIds: persistedJiraSettings.pickupBoardIds }
                : {}),
            }
          : {},
      ),
    enabled: !showLegacyEmptyState && clientSettingsHydrated,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const pickupBoards = useMemo(
    () => myWorkQuery.data?.jira.pickupBoards ?? [],
    [myWorkQuery.data?.jira.pickupBoards],
  );
  const pickupBoardIdSet = useMemo(
    () => new Set(persistedJiraSettings.pickupBoardIds),
    [persistedJiraSettings.pickupBoardIds],
  );
  const pickupBoardSelectionMode =
    persistedJiraSettings.pickupBoardIds.length === 0 ? "all" : "custom";
  const isPickupBoardSelected = useCallback(
    (boardId: number): boolean =>
      pickupBoardSelectionMode === "all" || pickupBoardIdSet.has(boardId),
    [pickupBoardIdSet, pickupBoardSelectionMode],
  );
  const setPickupBoardSelectionAll = useCallback(() => {
    updateSettings({ jiraPickupBoardIds: [] });
  }, [updateSettings]);
  const togglePickupBoardSelection = useCallback(
    (boardId: number) => {
      const currentlySelected = persistedJiraSettings.pickupBoardIds;
      if (currentlySelected.length === 0) {
        const next = pickupBoards.map((board) => board.id).filter((id) => id !== boardId);
        updateSettings({ jiraPickupBoardIds: next });
        return;
      }
      if (currentlySelected.includes(boardId)) {
        const next = currentlySelected.filter((id) => id !== boardId);
        updateSettings({ jiraPickupBoardIds: next });
        return;
      }
      updateSettings({ jiraPickupBoardIds: [...currentlySelected, boardId] });
    },
    [persistedJiraSettings.pickupBoardIds, pickupBoards, updateSettings],
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        HIDDEN_PULL_REQUESTS_STORAGE_KEY,
        JSON.stringify(Array.from(hiddenPullRequestKeys)),
      );
    } catch {
      // Ignore localStorage write failures.
    }
  }, [hiddenPullRequestKeys]);
  const allPullRequestsByKind = useMemo(
    () => ({
      reviewRequested:
        myWorkQuery.data?.pullRequests.filter((pr) => pr.kind === "review_requested") ?? [],
      authored: myWorkQuery.data?.pullRequests.filter((pr) => pr.kind === "authored") ?? [],
    }),
    [myWorkQuery.data?.pullRequests],
  );
  const pullRequestsByKind = useMemo(
    () => ({
      reviewRequested: allPullRequestsByKind.reviewRequested.filter(
        (pullRequest) => !hiddenPullRequestKeys.has(pullRequestStorageKey(pullRequest)),
      ),
      authored: allPullRequestsByKind.authored.filter(
        (pullRequest) => !hiddenPullRequestKeys.has(pullRequestStorageKey(pullRequest)),
      ),
    }),
    [allPullRequestsByKind, hiddenPullRequestKeys],
  );
  const hiddenPullRequests = useMemo(
    () =>
      (myWorkQuery.data?.pullRequests ?? []).filter((pullRequest) =>
        hiddenPullRequestKeys.has(pullRequestStorageKey(pullRequest)),
      ),
    [hiddenPullRequestKeys, myWorkQuery.data?.pullRequests],
  );
  const hidePullRequest = useCallback((pullRequest: MyWorkPullRequest) => {
    const key = pullRequestStorageKey(pullRequest);
    setHiddenPullRequestKeys((existing) => new Set(existing).add(key));
  }, []);
  const unhidePullRequest = useCallback((pullRequest: MyWorkPullRequest) => {
    const key = pullRequestStorageKey(pullRequest);
    setHiddenPullRequestKeys((existing) => {
      const next = new Set(existing);
      next.delete(key);
      return next;
    });
  }, []);
  const authoredPullRequestsByTicketKey = useMemo(() => {
    const byTicketKey = new Map<string, MyWorkPullRequest[]>();
    for (const pullRequest of pullRequestsByKind.authored) {
      if (pullRequest.state !== "open") continue;
      const discoveredKeys = collectLikelyJiraKeys(
        `${pullRequest.title}\n${pullRequest.headRefName ?? ""}`,
      );
      for (const ticketKey of discoveredKeys) {
        const existing = byTicketKey.get(ticketKey);
        if (existing) {
          existing.push(pullRequest);
        } else {
          byTicketKey.set(ticketKey, [pullRequest]);
        }
      }
    }
    return byTicketKey;
  }, [pullRequestsByKind.authored]);
  const jiraTickets = useMemo(
    () => myWorkQuery.data?.jira.tickets ?? [],
    [myWorkQuery.data?.jira.tickets],
  );
  const readyForQaTickets = useMemo(
    () =>
      jiraTickets.filter((ticket) =>
        (authoredPullRequestsByTicketKey.get(ticket.key) ?? []).some(
          (pullRequest) =>
            pullRequest.state === "open" &&
            !pullRequest.isDraft &&
            (pullRequest.reviewDecision === undefined || pullRequest.reviewDecision === "approved"),
        ),
      ),
    [authoredPullRequestsByTicketKey, jiraTickets],
  );
  const pickupTickets = useMemo(
    () => myWorkQuery.data?.jira.pickupTickets ?? [],
    [myWorkQuery.data?.jira.pickupTickets],
  );
  const pickupFilter = persistedJiraSettings.pickupTicketFilter;
  const filteredPickupTickets = useMemo(() => {
    if (pickupFilter === "mobile") {
      return pickupTickets.filter((ticket) => isMobileLabeledTicket(ticket));
    }
    if (pickupFilter === "non_mobile") {
      return pickupTickets.filter((ticket) => !isMobileLabeledTicket(ticket));
    }
    return pickupTickets;
  }, [pickupFilter, pickupTickets]);
  const setPickupFilter = useCallback(
    (nextFilter: "all" | "mobile" | "non_mobile") => {
      updateSettings({ jiraPickupTicketFilter: nextFilter });
    },
    [updateSettings],
  );
  useEffect(() => {
    const discoveredBaseUrl = myWorkQuery.data?.jira.baseUrl;
    if (discoveredBaseUrl && jiraSetupBaseUrl.trim().length === 0) {
      setJiraSetupBaseUrl(discoveredBaseUrl);
    }
  }, [jiraSetupBaseUrl, myWorkQuery.data?.jira.baseUrl]);
  const jiraSetupCommand = useMemo(() => {
    const baseUrl = jiraSetupBaseUrl.trim();
    const email = jiraSetupEmail.trim();
    const apiToken = jiraSetupApiToken.trim();
    const jql = jiraSetupJql.trim();
    if (!baseUrl || !email || !apiToken) {
      return "";
    }
    return [
      `export T3CODE_JIRA_BASE_URL=${shellQuote(baseUrl)}`,
      `export T3CODE_JIRA_EMAIL=${shellQuote(email)}`,
      `export T3CODE_JIRA_API_TOKEN=${shellQuote(apiToken)}`,
      ...(jql ? [`export T3CODE_JIRA_JQL=${shellQuote(jql)}`] : []),
      `PATH="$HOME/.bun/bin:$PATH" bun run dev`,
    ].join("\n");
  }, [jiraSetupApiToken, jiraSetupBaseUrl, jiraSetupEmail, jiraSetupJql]);
  const canTestJiraConnection =
    jiraSetupBaseUrl.trim().length > 0 &&
    jiraSetupEmail.trim().length > 0 &&
    jiraSetupApiToken.trim().length > 0;
  const jiraConnectionTestMutation = useMutation({
    mutationFn: async () =>
      ensureLocalApi().server.getMyWork({
        jiraBaseUrl: jiraSetupBaseUrl.trim(),
        jiraEmail: jiraSetupEmail.trim(),
        jiraApiToken: jiraSetupApiToken.trim(),
        jiraJql: jiraSetupJql.trim() || undefined,
        jiraLimit: 5,
        pullRequestLimit: 1,
      }),
    onSuccess: (result) => {
      if (result.jira.status !== "available") return;
      const baseUrl = jiraSetupBaseUrl.trim();
      const email = jiraSetupEmail.trim();
      const apiToken = jiraSetupApiToken.trim();
      const jql = jiraSetupJql.trim();
      if (!baseUrl || !email || !apiToken) return;
      persistJiraCredentials({
        baseUrl,
        email,
        apiToken,
        ...(jql ? { jql } : {}),
      });
    },
  });
  const jiraQaHandoffMutation = useMutation({
    mutationFn: async (input: { readonly ticket: JiraTicketSummary; readonly qaNotes: string }) => {
      if (!activeJiraCredentials) {
        throw new Error("Jira credentials are not configured.");
      }
      const linkedPullRequests = authoredPullRequestsByTicketKey.get(input.ticket.key) ?? [];
      return ensureLocalApi().server.handoffJiraTicketToQa({
        ticketKey: input.ticket.key,
        qaComment: buildQaHandoffComment({
          ticket: input.ticket,
          linkedPullRequests,
          qaNotes: input.qaNotes,
        }),
        jiraBaseUrl: activeJiraCredentials.baseUrl,
        jiraEmail: activeJiraCredentials.email,
        jiraApiToken: activeJiraCredentials.apiToken,
      });
    },
    onSuccess: (result) => {
      setQaHandoffFeedback({
        ticketKey: result.ticketKey,
        tone: "success",
        message: result.detail,
      });
      setQaHandoffExpandedTicketKey(null);
      setQaHandoffNotesByTicketKey((existing) => {
        const next = { ...existing };
        delete next[result.ticketKey];
        return next;
      });
      void myWorkQuery.refetch();
    },
    onError: (error, variables) => {
      setQaHandoffFeedback({
        ticketKey: variables.ticket.key,
        tone: "warning",
        message: error instanceof Error ? error.message : "Unable to hand off ticket to QA.",
      });
    },
  });
  const resetJiraConnectionTest = jiraConnectionTestMutation.reset;
  useEffect(() => {
    resetJiraConnectionTest();
  }, [resetJiraConnectionTest, jiraSetupApiToken, jiraSetupBaseUrl, jiraSetupEmail, jiraSetupJql]);
  const openExternalLink = useCallback(async (url: string) => {
    await ensureLocalApi().shell.openExternal(url);
  }, []);
  const { defaultProjectRef, handleNewThread } = useHandleNewThread();
  const { copyToClipboard } = useCopyToClipboard<string>();
  const startNewThread = useCallback(
    (envMode: "local" | "worktree") => {
      if (!defaultProjectRef) return;
      void handleNewThread(defaultProjectRef, { envMode });
    },
    [defaultProjectRef, handleNewThread],
  );
  const startPromptThread = useCallback(
    async (prompt: string) => {
      if (!defaultProjectRef) return;
      await handleNewThread(defaultProjectRef, {
        envMode: defaultThreadEnvMode,
        forceNewDraft: true,
      });
      const draftSession = useComposerDraftStore
        .getState()
        .getDraftSessionByProjectRef(defaultProjectRef);
      if (!draftSession) return;
      useComposerDraftStore.getState().setPrompt(draftSession.draftId, prompt);
    },
    [defaultProjectRef, defaultThreadEnvMode, handleNewThread],
  );
  const qaHandoffTicketKeyInFlight = jiraQaHandoffMutation.isPending
    ? jiraQaHandoffMutation.variables.ticket.key
    : null;
  const updateQaHandoffNote = useCallback((ticketKey: string, value: string) => {
    setQaHandoffNotesByTicketKey((existing) => ({
      ...existing,
      [ticketKey]: value,
    }));
  }, []);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto bg-background">
        <header
          className={cn(
            "border-b border-border px-3 sm:px-5",
            isElectron
              ? "drag-region flex h-[52px] items-center wco:h-[env(titlebar-area-height)]"
              : "py-2 sm:py-3",
          )}
        >
          {isElectron ? (
            <span
              className="text-xs text-muted-foreground/50 wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]"
              aria-hidden="true"
            />
          ) : (
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            </div>
          )}
        </header>

        {showLegacyEmptyState ? (
          <Empty className="flex-1">
            <div className="w-full max-w-lg rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
              <EmptyHeader className="max-w-none">
                <EmptyTitle className="text-foreground text-xl">
                  Pick a thread to continue
                </EmptyTitle>
                <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                  Select an existing thread or create a new one to get started.
                </EmptyDescription>
              </EmptyHeader>
            </div>
          </Empty>
        ) : (
          <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-3 py-4 sm:px-5 sm:py-6">
            <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]">
              <div className="rounded-lg border border-border/70 bg-card/30 p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h1 className="text-base font-semibold text-foreground sm:text-lg">
                      Engineering Workbench
                    </h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Start focused threads, keep review work visible, and move through daily tasks
                      with less setup.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={() => startNewThread("local")}
                      disabled={!defaultProjectRef}
                    >
                      <SquarePenIcon className="size-4" />
                      New local thread
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => startNewThread("worktree")}
                      disabled={!defaultProjectRef}
                    >
                      <GitBranchIcon className="size-4" />
                      New worktree thread
                    </Button>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Badge variant="warning">Approvals: {summary.pendingApprovalCount}</Badge>
                  <Badge variant="info">Awaiting input: {summary.awaitingInputCount}</Badge>
                  <Badge variant="success">Plans ready: {summary.planReadyCount}</Badge>
                  <Badge variant="outline">Running: {summary.runningCount}</Badge>
                </div>
              </div>

              <div className="rounded-lg border border-border/70 bg-card/30 p-4 sm:p-5">
                <h2 className="text-sm font-semibold text-foreground">Workflow prompts</h2>
                <ul className="mt-3 space-y-2">
                  {WORKFLOW_PROMPTS.map((item) => {
                    return (
                      <li
                        key={item.id}
                        className="flex items-center justify-between gap-2 rounded-md border border-border/65 bg-background/60 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm text-foreground">{item.label}</p>
                          <p className="truncate text-xs text-muted-foreground">{item.stage}</p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            void startPromptThread(item.prompt);
                          }}
                          disabled={!defaultProjectRef}
                        >
                          <MessageSquareIcon className="size-3.5" />
                          Start chat
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </section>

            <section className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-lg border border-border/70 bg-card/25">
                <div className="flex items-center justify-between gap-2 border-b border-border/70 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <GitPullRequestIcon className="size-4 text-muted-foreground" />
                    <h2 className="text-sm font-semibold text-foreground">Open pull requests</h2>
                  </div>
                  <div className="flex items-center gap-1">
                    {hiddenPullRequests.length > 0 ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setShowHiddenPullRequests((current) => !current)}
                      >
                        <EyeIcon className="size-3.5" />
                        {showHiddenPullRequests
                          ? "Hide hidden"
                          : `Show hidden (${hiddenPullRequests.length})`}
                      </Button>
                    ) : null}
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => {
                        void myWorkQuery.refetch();
                      }}
                      disabled={myWorkQuery.isFetching}
                      aria-label="Refresh my work"
                    >
                      <RefreshCwIcon
                        className={cn("size-3.5", myWorkQuery.isFetching && "animate-spin")}
                      />
                    </Button>
                  </div>
                </div>
                {myWorkQuery.isPending ? (
                  <div className="px-4 py-8 text-sm text-muted-foreground">
                    Loading pull requests...
                  </div>
                ) : myWorkQuery.isError ? (
                  <div className="px-4 py-8 text-sm text-warning">
                    Unable to load pull requests right now.
                  </div>
                ) : pullRequestsByKind.reviewRequested.length > 0 ||
                  pullRequestsByKind.authored.length > 0 ? (
                  <ul>
                    <li className="border-b border-border/55">
                      <Collapsible open={authoredOpen} onOpenChange={setAuthoredOpen}>
                        <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-2 text-left hover:bg-accent/35">
                          <span className="text-xs font-medium text-muted-foreground">
                            Authored by you ({pullRequestsByKind.authored.length})
                          </span>
                          <ChevronDownIcon
                            className={cn(
                              "size-4 text-muted-foreground transition-transform",
                              authoredOpen && "rotate-180",
                            )}
                          />
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          {pullRequestsByKind.authored.length === 0 ? (
                            <div className="px-4 py-3 text-sm text-muted-foreground">
                              No authored pull requests in flight.
                            </div>
                          ) : (
                            <ul>
                              {pullRequestsByKind.authored.map((pr) => (
                                <li
                                  key={`${pr.repositoryNameWithOwner}#${pr.number}`}
                                  className="border-t border-border/45"
                                >
                                  <div className="flex items-start justify-between gap-2 px-4 py-3">
                                    <div className="min-w-0">
                                      <p className="truncate text-sm font-medium text-foreground">
                                        {pr.title}
                                      </p>
                                      <p className="truncate text-xs text-muted-foreground">
                                        {pr.repositoryNameWithOwner} · #{pr.number} ·{" "}
                                        {formatRelativeTimeLabel(pr.updatedAt)}
                                      </p>
                                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                                        <Badge variant="outline" size="sm">
                                          {pullRequestKindLabel(pr.kind)}
                                        </Badge>
                                        {reviewDecisionLabel(pr.reviewDecision) ? (
                                          <Badge
                                            variant={reviewDecisionBadgeVariant(pr.reviewDecision)}
                                            size="sm"
                                          >
                                            {reviewDecisionLabel(pr.reviewDecision)}
                                          </Badge>
                                        ) : null}
                                        {pr.isDraft ? (
                                          <Badge variant="outline" size="sm">
                                            Draft
                                          </Badge>
                                        ) : null}
                                      </div>
                                    </div>
                                    <Button
                                      size="icon-xs"
                                      variant="ghost"
                                      onClick={() => hidePullRequest(pr)}
                                      aria-label={`Hide pull request ${pr.number}`}
                                    >
                                      <EyeOffIcon className="size-3.5" />
                                    </Button>
                                    <Button
                                      size="icon-xs"
                                      variant="ghost"
                                      onClick={() => {
                                        void openExternalLink(pr.url);
                                      }}
                                      aria-label={`Open pull request ${pr.number}`}
                                    >
                                      <ExternalLinkIcon className="size-3.5" />
                                    </Button>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          )}
                        </CollapsibleContent>
                      </Collapsible>
                    </li>
                    <li className="last:border-b-0">
                      <Collapsible open={reviewRequestedOpen} onOpenChange={setReviewRequestedOpen}>
                        <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-2 text-left hover:bg-accent/35">
                          <span className="text-xs font-medium text-muted-foreground">
                            Review requested ({pullRequestsByKind.reviewRequested.length})
                          </span>
                          <ChevronDownIcon
                            className={cn(
                              "size-4 text-muted-foreground transition-transform",
                              reviewRequestedOpen && "rotate-180",
                            )}
                          />
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          {pullRequestsByKind.reviewRequested.length === 0 ? (
                            <div className="px-4 py-3 text-sm text-muted-foreground">
                              No pull requests currently waiting for your review.
                            </div>
                          ) : (
                            <ul>
                              {pullRequestsByKind.reviewRequested.map((pr) => (
                                <li
                                  key={`${pr.repositoryNameWithOwner}#${pr.number}`}
                                  className="border-t border-border/45"
                                >
                                  <div className="flex items-start justify-between gap-2 px-4 py-3">
                                    <div className="min-w-0">
                                      <p className="truncate text-sm font-medium text-foreground">
                                        {pr.title}
                                      </p>
                                      <p className="truncate text-xs text-muted-foreground">
                                        {pr.repositoryNameWithOwner} · #{pr.number} ·{" "}
                                        {formatRelativeTimeLabel(pr.updatedAt)}
                                      </p>
                                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                                        <Badge variant="warning" size="sm">
                                          {pullRequestKindLabel(pr.kind)}
                                        </Badge>
                                        {reviewDecisionLabel(pr.reviewDecision) ? (
                                          <Badge
                                            variant={reviewDecisionBadgeVariant(pr.reviewDecision)}
                                            size="sm"
                                          >
                                            {reviewDecisionLabel(pr.reviewDecision)}
                                          </Badge>
                                        ) : null}
                                        {pr.isDraft ? (
                                          <Badge variant="outline" size="sm">
                                            Draft
                                          </Badge>
                                        ) : null}
                                      </div>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1">
                                      <Button
                                        size="icon-xs"
                                        variant="ghost"
                                        disabled={!defaultProjectRef}
                                        onClick={() => {
                                          void startPromptThread(buildPullRequestReviewPrompt(pr));
                                        }}
                                        aria-label={`Review pull request ${pr.number} with AI`}
                                      >
                                        <SparklesIcon className="size-3.5" />
                                      </Button>
                                      <Button
                                        size="icon-xs"
                                        variant="ghost"
                                        onClick={() => hidePullRequest(pr)}
                                        aria-label={`Hide pull request ${pr.number}`}
                                      >
                                        <EyeOffIcon className="size-3.5" />
                                      </Button>
                                      <Button
                                        size="icon-xs"
                                        variant="ghost"
                                        onClick={() => {
                                          void openExternalLink(pr.url);
                                        }}
                                        aria-label={`Open pull request ${pr.number}`}
                                      >
                                        <ExternalLinkIcon className="size-3.5" />
                                      </Button>
                                    </div>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          )}
                        </CollapsibleContent>
                      </Collapsible>
                    </li>
                  </ul>
                ) : (
                  <div className="space-y-2 px-4 py-8 text-sm text-muted-foreground">
                    <p>
                      {hiddenPullRequests.length > 0
                        ? "All open pull requests are currently hidden."
                        : "No open pull requests found."}
                    </p>
                    {hiddenPullRequests.length > 0 ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setShowHiddenPullRequests((current) => !current)}
                      >
                        <EyeIcon className="size-3.5" />
                        {showHiddenPullRequests
                          ? "Hide hidden pull requests"
                          : `Show hidden pull requests (${hiddenPullRequests.length})`}
                      </Button>
                    ) : null}
                  </div>
                )}
                {hiddenPullRequests.length > 0 && showHiddenPullRequests ? (
                  <div className="border-t border-border/55">
                    <div className="flex items-center justify-between px-4 py-2">
                      <span className="text-xs font-medium text-muted-foreground">
                        Hidden pull requests ({hiddenPullRequests.length})
                      </span>
                    </div>
                    <ul>
                      {hiddenPullRequests.map((pullRequest) => (
                        <li
                          key={`hidden-${pullRequest.repositoryNameWithOwner}#${pullRequest.number}`}
                          className="border-t border-border/45"
                        >
                          <div className="flex items-start justify-between gap-2 px-4 py-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm text-muted-foreground">
                                {pullRequest.title}
                              </p>
                              <p className="truncate text-xs text-muted-foreground/80">
                                {pullRequest.repositoryNameWithOwner} · #{pullRequest.number}
                              </p>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => unhidePullRequest(pullRequest)}
                              >
                                Unhide
                              </Button>
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                onClick={() => {
                                  void openExternalLink(pullRequest.url);
                                }}
                                aria-label={`Open pull request ${pullRequest.number}`}
                              >
                                <ExternalLinkIcon className="size-3.5" />
                              </Button>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>

              <div className="space-y-4">
                <div className="rounded-lg border border-border/70 bg-card/25">
                  <div className="flex items-center justify-between gap-2 border-b border-border/70 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <TicketIcon className="size-4 text-muted-foreground" />
                      <h2 className="text-sm font-semibold text-foreground">
                        Unassigned sprint tickets
                      </h2>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon-xs"
                        variant={pickupBoardSettingsOpen ? "secondary" : "ghost"}
                        onClick={() => setPickupBoardSettingsOpen((open) => !open)}
                        aria-label="Configure unassigned sprint boards"
                      >
                        <Settings2Icon className="size-3.5" />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        onClick={() => {
                          void myWorkQuery.refetch();
                        }}
                        disabled={myWorkQuery.isFetching}
                        aria-label="Refresh unassigned Jira tickets"
                      >
                        <RefreshCwIcon
                          className={cn("size-3.5", myWorkQuery.isFetching && "animate-spin")}
                        />
                      </Button>
                    </div>
                  </div>
                  {!clientSettingsHydrated ? (
                    <div className="px-4 py-8 text-sm text-muted-foreground">
                      Loading saved Jira credentials...
                    </div>
                  ) : myWorkQuery.isPending ? (
                    <div className="px-4 py-8 text-sm text-muted-foreground">
                      Loading unassigned sprint tickets...
                    </div>
                  ) : myWorkQuery.isError ? (
                    <div className="px-4 py-8 text-sm text-warning">
                      Unable to load unassigned sprint tickets right now.
                    </div>
                  ) : myWorkQuery.data?.jira.status !== "available" ? (
                    <div className="px-4 py-8 text-sm text-muted-foreground">
                      Connect Jira to view unassigned sprint tickets.
                    </div>
                  ) : (
                    <div className="space-y-3 px-4 py-4">
                      {pickupBoardSettingsOpen ? (
                        <JiraBoardScopePicker
                          title="Sprint boards"
                          boards={pickupBoards}
                          selectionMode={pickupBoardSelectionMode}
                          isSelected={isPickupBoardSelected}
                          onSelectAll={setPickupBoardSelectionAll}
                          onToggleBoard={togglePickupBoardSelection}
                          keyPrefix="pickup-board"
                        />
                      ) : null}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant={pickupFilter === "all" ? "secondary" : "outline"}
                          onClick={() => setPickupFilter("all")}
                        >
                          All ({pickupTickets.length})
                        </Button>
                        <Button
                          size="sm"
                          variant={pickupFilter === "mobile" ? "secondary" : "outline"}
                          onClick={() => setPickupFilter("mobile")}
                        >
                          Mobile (
                          {pickupTickets.filter((ticket) => isMobileLabeledTicket(ticket)).length})
                        </Button>
                        <Button
                          size="sm"
                          variant={pickupFilter === "non_mobile" ? "secondary" : "outline"}
                          onClick={() => setPickupFilter("non_mobile")}
                        >
                          Non-mobile (
                          {pickupTickets.filter((ticket) => !isMobileLabeledTicket(ticket)).length})
                        </Button>
                      </div>
                      {filteredPickupTickets.length > 0 ? (
                        <ul className="-mx-4 border-t border-border/55">
                          {filteredPickupTickets.map((ticket) => (
                            <li key={`pickup-${ticket.key}`} className="border-b border-border/55">
                              <div className="flex items-start justify-between gap-2 px-4 py-3">
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium text-foreground">
                                    {ticket.title}
                                  </p>
                                  <p className="truncate text-xs text-muted-foreground">
                                    {ticket.key} · {formatRelativeTimeLabel(ticket.updatedAt)}
                                  </p>
                                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                                    <Badge variant={ticketStatusVariant(ticket)} size="sm">
                                      {ticket.status.name}
                                    </Badge>
                                    {ticket.priority ? (
                                      <Badge variant="outline" size="sm">
                                        {ticket.priority}
                                      </Badge>
                                    ) : null}
                                  </div>
                                </div>
                                <div className="flex shrink-0 items-center gap-1">
                                  <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    onClick={() => {
                                      void startPromptThread(buildTicketPrompt(ticket));
                                    }}
                                    aria-label={`Start chat for ticket ${ticket.key}`}
                                    disabled={!defaultProjectRef}
                                  >
                                    <MessageSquareIcon className="size-3.5" />
                                  </Button>
                                  <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    onClick={() => {
                                      void openExternalLink(ticket.url);
                                    }}
                                    aria-label={`Open ticket ${ticket.key}`}
                                  >
                                    <ExternalLinkIcon className="size-3.5" />
                                  </Button>
                                </div>
                              </div>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          {pickupTickets.length > 0
                            ? "No tickets match the current Mobile filter."
                            : pickupBoardSelectionMode === "custom"
                              ? "No unassigned tickets ready to pick up in active sprints for the selected board(s)."
                              : "No unassigned tickets ready to pick up in the current sprint."}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                <div className="rounded-lg border border-border/70 bg-card/25">
                  <div className="flex items-center justify-between gap-2 border-b border-border/70 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <TicketIcon className="size-4 text-muted-foreground" />
                      <h2 className="text-sm font-semibold text-foreground">
                        Ready for QA handoff
                      </h2>
                    </div>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => {
                        void myWorkQuery.refetch();
                      }}
                      disabled={myWorkQuery.isFetching}
                      aria-label="Refresh ready-for-QA tickets"
                    >
                      <RefreshCwIcon
                        className={cn("size-3.5", myWorkQuery.isFetching && "animate-spin")}
                      />
                    </Button>
                  </div>
                  {!clientSettingsHydrated ? (
                    <div className="px-4 py-8 text-sm text-muted-foreground">
                      Loading saved Jira credentials...
                    </div>
                  ) : myWorkQuery.isPending ? (
                    <div className="px-4 py-8 text-sm text-muted-foreground">
                      Checking tickets ready for QA...
                    </div>
                  ) : myWorkQuery.isError ? (
                    <div className="px-4 py-8 text-sm text-warning">
                      Unable to calculate QA handoff candidates right now.
                    </div>
                  ) : myWorkQuery.data?.jira.status !== "available" ? (
                    <div className="px-4 py-8 text-sm text-muted-foreground">
                      Connect Jira to use QA handoff.
                    </div>
                  ) : readyForQaTickets.length > 0 ? (
                    <ul>
                      {readyForQaTickets.map((ticket) => {
                        const linkedPullRequests =
                          authoredPullRequestsByTicketKey.get(ticket.key) ?? [];
                        const isExpanded = qaHandoffExpandedTicketKey === ticket.key;
                        const qaNotes = qaHandoffNotesByTicketKey[ticket.key] ?? "";
                        const isSubmitting = qaHandoffTicketKeyInFlight === ticket.key;
                        const feedback =
                          qaHandoffFeedback?.ticketKey === ticket.key ? qaHandoffFeedback : null;
                        return (
                          <li
                            key={`qa-${ticket.key}`}
                            className="border-b border-border/55 last:border-b-0"
                          >
                            <div className="space-y-3 px-4 py-3">
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium text-foreground">
                                    {ticket.title}
                                  </p>
                                  <p className="truncate text-xs text-muted-foreground">
                                    {ticket.key} · {formatRelativeTimeLabel(ticket.updatedAt)}
                                  </p>
                                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                                    <Badge variant={ticketStatusVariant(ticket)} size="sm">
                                      {ticket.status.name}
                                    </Badge>
                                    <Badge variant="outline" size="sm">
                                      Linked PRs: {linkedPullRequests.length}
                                    </Badge>
                                  </div>
                                </div>
                                <div className="flex shrink-0 items-center gap-1">
                                  <Button
                                    size="sm"
                                    variant={isExpanded ? "secondary" : "outline"}
                                    onClick={() => {
                                      setQaHandoffFeedback(null);
                                      setQaHandoffExpandedTicketKey((current) =>
                                        current === ticket.key ? null : ticket.key,
                                      );
                                    }}
                                    disabled={isSubmitting}
                                  >
                                    Move to QA
                                  </Button>
                                  <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    onClick={() => {
                                      void openExternalLink(ticket.url);
                                    }}
                                    aria-label={`Open ticket ${ticket.key}`}
                                  >
                                    <ExternalLinkIcon className="size-3.5" />
                                  </Button>
                                </div>
                              </div>
                              {linkedPullRequests.length > 0 ? (
                                <ul className="space-y-1">
                                  {linkedPullRequests.slice(0, 3).map((pullRequest) => (
                                    <li
                                      key={`${ticket.key}-${pullRequest.repositoryNameWithOwner}-${pullRequest.number}`}
                                      className="truncate text-xs text-muted-foreground"
                                    >
                                      {pullRequest.repositoryNameWithOwner} #{pullRequest.number}{" "}
                                      {pullRequest.isDraft
                                        ? "(draft)"
                                        : `(${reviewDecisionLabel(pullRequest.reviewDecision) ?? "ready"})`}
                                    </li>
                                  ))}
                                </ul>
                              ) : null}
                              {isExpanded ? (
                                <div className="space-y-2 rounded-md border border-border/65 bg-background/60 p-3">
                                  <label className="space-y-1">
                                    <span className="text-xs text-muted-foreground">
                                      QA notes (optional)
                                    </span>
                                    <Textarea
                                      value={qaNotes}
                                      onChange={(event) =>
                                        updateQaHandoffNote(ticket.key, event.target.value)
                                      }
                                      rows={4}
                                      placeholder="Add testing notes, rollout detail, or caveats for QA."
                                    />
                                  </label>
                                  <div className="flex flex-wrap gap-2">
                                    <Button
                                      size="sm"
                                      onClick={() => {
                                        jiraQaHandoffMutation.mutate({ ticket, qaNotes });
                                      }}
                                      disabled={isSubmitting || !activeJiraCredentials}
                                    >
                                      {isSubmitting ? "Handing off..." : "Confirm QA handoff"}
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => {
                                        setQaHandoffExpandedTicketKey(null);
                                      }}
                                      disabled={isSubmitting}
                                    >
                                      Cancel
                                    </Button>
                                  </div>
                                  {feedback ? (
                                    <p
                                      className={cn(
                                        "text-xs",
                                        feedback.tone === "success"
                                          ? "text-success"
                                          : "text-warning",
                                      )}
                                    >
                                      {feedback.message}
                                    </p>
                                  ) : null}
                                </div>
                              ) : feedback ? (
                                <p
                                  className={cn(
                                    "text-xs",
                                    feedback.tone === "success" ? "text-success" : "text-warning",
                                  )}
                                >
                                  {feedback.message}
                                </p>
                              ) : null}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <div className="space-y-2 px-4 py-5">
                      <p className="text-sm text-muted-foreground">
                        No tickets are currently ready for QA handoff.
                      </p>
                      <p className="text-xs text-muted-foreground">
                        A ticket appears here when it has a linked open authored pull request that
                        is not draft (and approved when review state is available).
                      </p>
                    </div>
                  )}
                </div>

                <div className="rounded-lg border border-border/70 bg-card/25">
                  <div className="flex items-center justify-between gap-2 border-b border-border/70 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <TicketIcon className="size-4 text-muted-foreground" />
                      <h2 className="text-sm font-semibold text-foreground">
                        Jira tickets in flight
                      </h2>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon-xs"
                        variant={inFlightBoardSettingsOpen ? "secondary" : "ghost"}
                        onClick={() => setInFlightBoardSettingsOpen((open) => !open)}
                        aria-label="Configure in-flight Jira boards"
                      >
                        <Settings2Icon className="size-3.5" />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        onClick={() => {
                          void myWorkQuery.refetch();
                        }}
                        disabled={myWorkQuery.isFetching}
                        aria-label="Refresh Jira work"
                      >
                        <RefreshCwIcon
                          className={cn("size-3.5", myWorkQuery.isFetching && "animate-spin")}
                        />
                      </Button>
                    </div>
                  </div>
                  {myWorkQuery.data?.jira.status === "available" && inFlightBoardSettingsOpen ? (
                    <div className="border-b border-border/70 px-4 py-3">
                      <JiraBoardScopePicker
                        title="In-flight board scope"
                        boards={pickupBoards}
                        selectionMode={pickupBoardSelectionMode}
                        isSelected={isPickupBoardSelected}
                        onSelectAll={setPickupBoardSelectionAll}
                        onToggleBoard={togglePickupBoardSelection}
                        keyPrefix="in-flight-board"
                      />
                    </div>
                  ) : null}
                  {!clientSettingsHydrated ? (
                    <div className="px-4 py-8 text-sm text-muted-foreground">
                      Loading saved Jira credentials...
                    </div>
                  ) : myWorkQuery.isPending ? (
                    <div className="px-4 py-8 text-sm text-muted-foreground">
                      Loading Jira tickets...
                    </div>
                  ) : myWorkQuery.isError ? (
                    <div className="px-4 py-8 text-sm text-warning">
                      Unable to load Jira tickets right now.
                    </div>
                  ) : myWorkQuery.data?.jira.status === "not_configured" ? (
                    <div className="space-y-3 px-4 py-5">
                      <p className="text-sm text-muted-foreground">
                        Jira is not connected yet. Add these environment variables where the T3
                        server runs, then refresh.
                      </p>
                      <div className="rounded-md border border-border/65 bg-background/60 px-3 py-2 text-xs text-muted-foreground">
                        <p>
                          Required: <code>T3CODE_JIRA_BASE_URL</code>,{" "}
                          <code>T3CODE_JIRA_EMAIL</code>, <code>T3CODE_JIRA_API_TOKEN</code>
                        </p>
                        <p className="mt-1">
                          {myWorkQuery.data.jira.detail ??
                            "Missing required Jira credentials for this environment."}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            void openExternalLink(
                              "https://id.atlassian.com/manage-profile/security/api-tokens",
                            );
                          }}
                        >
                          <ExternalLinkIcon className="size-3.5" />
                          Create API token
                        </Button>
                        <Button
                          size="sm"
                          variant={showJiraSetupForm ? "secondary" : "outline"}
                          onClick={() => setShowJiraSetupForm((open) => !open)}
                        >
                          {showJiraSetupForm ? "Hide setup form" : "I have a token"}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            copyToClipboard(JIRA_ENV_SETUP_TEMPLATE, "jira-env-setup-template")
                          }
                        >
                          <CopyIcon className="size-3.5" />
                          Copy template
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            void myWorkQuery.refetch();
                          }}
                        >
                          <RefreshCwIcon className="size-3.5" />
                          Recheck
                        </Button>
                      </div>
                      {showJiraSetupForm ? (
                        <div className="space-y-3 rounded-md border border-border/65 bg-background/60 p-3">
                          <div className="grid gap-3 sm:grid-cols-2">
                            <label className="space-y-1">
                              <span className="text-xs text-muted-foreground">Jira base URL</span>
                              <Input
                                value={jiraSetupBaseUrl}
                                onChange={(event) => setJiraSetupBaseUrl(event.target.value)}
                                placeholder="https://your-org.atlassian.net"
                              />
                            </label>
                            <label className="space-y-1">
                              <span className="text-xs text-muted-foreground">Jira email</span>
                              <Input
                                value={jiraSetupEmail}
                                onChange={(event) => setJiraSetupEmail(event.target.value)}
                                placeholder="you@company.com"
                              />
                            </label>
                            <label className="space-y-1 sm:col-span-2">
                              <span className="text-xs text-muted-foreground">Jira API token</span>
                              <Input
                                value={jiraSetupApiToken}
                                onChange={(event) => setJiraSetupApiToken(event.target.value)}
                                placeholder="Paste your Jira API token"
                                type="password"
                              />
                            </label>
                            <label className="space-y-1 sm:col-span-2">
                              <span className="text-xs text-muted-foreground">Optional JQL</span>
                              <Input
                                value={jiraSetupJql}
                                onChange={(event) => setJiraSetupJql(event.target.value)}
                                placeholder="assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC"
                              />
                            </label>
                          </div>
                          <label className="space-y-1">
                            <span className="text-xs text-muted-foreground">Setup command</span>
                            <Textarea
                              value={jiraSetupCommand}
                              readOnly
                              rows={6}
                              placeholder="Fill in base URL, email, and API token to generate command."
                            />
                          </label>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={
                                !canTestJiraConnection || jiraConnectionTestMutation.isPending
                              }
                              onClick={() => {
                                jiraConnectionTestMutation.reset();
                                jiraConnectionTestMutation.mutate();
                              }}
                            >
                              <RefreshCwIcon
                                className={cn(
                                  "size-3.5",
                                  jiraConnectionTestMutation.isPending && "animate-spin",
                                )}
                              />
                              Test Jira connection
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={jiraSetupCommand.length === 0}
                              onClick={() =>
                                copyToClipboard(jiraSetupCommand, "jira-generated-setup-command")
                              }
                            >
                              <CopyIcon className="size-3.5" />
                              Copy generated command
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={!activeJiraCredentials}
                              onClick={() => persistJiraCredentials(null)}
                            >
                              Disconnect saved credentials
                            </Button>
                          </div>
                          {jiraConnectionTestMutation.data ? (
                            jiraConnectionTestMutation.data.jira.status === "available" ? (
                              <p className="text-xs text-success">
                                Connected. Found{" "}
                                {jiraConnectionTestMutation.data.jira.tickets.length} ticket
                                {jiraConnectionTestMutation.data.jira.tickets.length === 1
                                  ? ""
                                  : "s"}{" "}
                                for this JQL.
                              </p>
                            ) : (
                              <p className="text-xs text-warning">
                                Connection test returned:{" "}
                                {jiraConnectionTestMutation.data.jira.detail ??
                                  jiraConnectionTestMutation.data.jira.status}
                              </p>
                            )
                          ) : null}
                          {jiraConnectionTestMutation.isError ? (
                            <p className="text-xs text-warning">
                              {jiraConnectionTestMutation.error instanceof Error
                                ? jiraConnectionTestMutation.error.message
                                : "Unable to test Jira connection."}
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : myWorkQuery.data?.jira.status === "error" ? (
                    <div className="space-y-3 px-4 py-5">
                      <p className="text-sm text-warning">
                        {myWorkQuery.data.jira.detail ?? "Jira request failed."}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            void myWorkQuery.refetch();
                          }}
                        >
                          <RefreshCwIcon className="size-3.5" />
                          Retry
                        </Button>
                      </div>
                    </div>
                  ) : jiraTickets.length > 0 ? (
                    <ul>
                      {jiraTickets.map((ticket) => (
                        <li key={ticket.key} className="border-b border-border/55 last:border-b-0">
                          <div className="flex items-start justify-between gap-2 px-4 py-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-foreground">
                                {ticket.title}
                              </p>
                              <p className="truncate text-xs text-muted-foreground">
                                {ticket.key} · {formatRelativeTimeLabel(ticket.updatedAt)}
                              </p>
                              <div className="mt-1.5 flex flex-wrap gap-1.5">
                                <Badge variant={ticketStatusVariant(ticket)} size="sm">
                                  {ticket.status.name}
                                </Badge>
                                {ticket.priority ? (
                                  <Badge variant="outline" size="sm">
                                    {ticket.priority}
                                  </Badge>
                                ) : null}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                onClick={() => {
                                  void startPromptThread(buildTicketPrompt(ticket));
                                }}
                                aria-label={`Start chat for ticket ${ticket.key}`}
                                disabled={!defaultProjectRef}
                              >
                                <MessageSquareIcon className="size-3.5" />
                              </Button>
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                onClick={() => {
                                  void openExternalLink(ticket.url);
                                }}
                                aria-label={`Open ticket ${ticket.key}`}
                              >
                                <ExternalLinkIcon className="size-3.5" />
                              </Button>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="space-y-3 px-4 py-5">
                      <p className="text-sm text-muted-foreground">
                        {myWorkQuery.data?.jira.detail ?? "No Jira tickets in flight."}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant={showJiraSetupForm ? "secondary" : "outline"}
                          onClick={() => setShowJiraSetupForm((open) => !open)}
                        >
                          {showJiraSetupForm ? "Hide Jira settings" : "Edit Jira settings"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            void myWorkQuery.refetch();
                          }}
                        >
                          <RefreshCwIcon className="size-3.5" />
                          Retry
                        </Button>
                      </div>
                      {showJiraSetupForm ? (
                        <div className="space-y-3 rounded-md border border-border/65 bg-background/60 p-3">
                          <div className="grid gap-3 sm:grid-cols-2">
                            <label className="space-y-1">
                              <span className="text-xs text-muted-foreground">Jira base URL</span>
                              <Input
                                value={jiraSetupBaseUrl}
                                onChange={(event) => setJiraSetupBaseUrl(event.target.value)}
                                placeholder="https://your-org.atlassian.net"
                              />
                            </label>
                            <label className="space-y-1">
                              <span className="text-xs text-muted-foreground">Jira email</span>
                              <Input
                                value={jiraSetupEmail}
                                onChange={(event) => setJiraSetupEmail(event.target.value)}
                                placeholder="you@company.com"
                              />
                            </label>
                            <label className="space-y-1 sm:col-span-2">
                              <span className="text-xs text-muted-foreground">Jira API token</span>
                              <Input
                                value={jiraSetupApiToken}
                                onChange={(event) => setJiraSetupApiToken(event.target.value)}
                                placeholder="Paste your Jira API token"
                                type="password"
                              />
                            </label>
                            <label className="space-y-1 sm:col-span-2">
                              <span className="text-xs text-muted-foreground">Optional JQL</span>
                              <Input
                                value={jiraSetupJql}
                                onChange={(event) => setJiraSetupJql(event.target.value)}
                                placeholder="assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC"
                              />
                            </label>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={
                                !canTestJiraConnection || jiraConnectionTestMutation.isPending
                              }
                              onClick={() => {
                                jiraConnectionTestMutation.reset();
                                jiraConnectionTestMutation.mutate();
                              }}
                            >
                              <RefreshCwIcon
                                className={cn(
                                  "size-3.5",
                                  jiraConnectionTestMutation.isPending && "animate-spin",
                                )}
                              />
                              Test Jira connection
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={!activeJiraCredentials}
                              onClick={() => persistJiraCredentials(null)}
                            >
                              Disconnect saved credentials
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              </div>
            </section>

            <section className="grid min-h-0 gap-4 lg:grid-cols-2">
              <div className="rounded-lg border border-border/70 bg-card/25">
                <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
                  <ListTodoIcon className="size-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold text-foreground">Needs attention</h2>
                </div>
                {focusThreads.length === 0 ? (
                  <div className="px-4 py-8 text-sm text-muted-foreground">
                    No urgent threads right now.
                  </div>
                ) : (
                  <ul>
                    {focusThreads.map((thread) => {
                      const projectName =
                        projectNamesByKey.get(`${thread.environmentId}:${thread.projectId}`) ??
                        "Unknown project";
                      const status = resolveThreadStatus(thread);
                      return (
                        <li
                          key={`${thread.environmentId}:${thread.id}`}
                          className="border-b border-border/55 last:border-b-0"
                        >
                          <Link
                            to="/$environmentId/$threadId"
                            params={buildThreadRouteParams(
                              scopeThreadRef(thread.environmentId, thread.id),
                            )}
                            className="flex items-center justify-between gap-2 px-4 py-3 hover:bg-accent/35"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-foreground">
                                {thread.title}
                              </p>
                              <p className="truncate text-xs text-muted-foreground">
                                {projectName}
                                {thread.branch ? ` · ${thread.branch}` : ""}
                              </p>
                            </div>
                            <Badge variant={status.variant} size="sm">
                              {status.label}
                            </Badge>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              <div className="rounded-lg border border-border/70 bg-card/25">
                <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
                  <MessageSquareIcon className="size-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold text-foreground">Recent threads</h2>
                </div>
                {recentThreads.length === 0 ? (
                  <div className="px-4 py-8 text-sm text-muted-foreground">
                    No thread history yet.
                  </div>
                ) : (
                  <ul>
                    {recentThreads.map((thread) => {
                      const projectName =
                        projectNamesByKey.get(`${thread.environmentId}:${thread.projectId}`) ??
                        "Unknown project";
                      const updatedAt =
                        thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt;
                      return (
                        <li
                          key={`${thread.environmentId}:${thread.id}`}
                          className="border-b border-border/55 last:border-b-0"
                        >
                          <Link
                            to="/$environmentId/$threadId"
                            params={buildThreadRouteParams(
                              scopeThreadRef(thread.environmentId, thread.id),
                            )}
                            className="flex items-center justify-between gap-2 px-4 py-3 hover:bg-accent/35"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-sm text-foreground">{thread.title}</p>
                              <p className="truncate text-xs text-muted-foreground">
                                {projectName}
                              </p>
                            </div>
                            <span className="shrink-0 text-xs text-muted-foreground/85">
                              {formatRelativeTimeLabel(updatedAt)}
                            </span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </section>
          </main>
        )}
      </div>
    </SidebarInset>
  );
}
