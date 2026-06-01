import type {
  JiraBoardSummary,
  JiraQaHandoffInput,
  JiraQaHandoffResult,
  JiraMyWorkSnapshot,
  JiraTicketSummary,
  MyWorkPullRequest,
  MyWorkPullRequestKind,
  MyWorkSummaryInput,
  MyWorkSummaryResult,
} from "@t3tools/contracts";
import { MyWorkError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const DEFAULT_PULL_REQUEST_LIMIT = 30;
const DEFAULT_JIRA_LIMIT = 30;
const DEFAULT_JIRA_JQL =
  "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
const DEFAULT_JIRA_PICKUP_JQL =
  'sprint in openSprints() AND assignee is EMPTY AND statusCategory = "To Do" ORDER BY updated DESC';

interface JiraConfig {
  readonly baseUrl: string;
  readonly email: string;
  readonly apiToken: string;
  readonly jql: string;
}

class JiraMyWorkFetchError extends Schema.TaggedErrorClass<JiraMyWorkFetchError>()(
  "JiraMyWorkFetchError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
const isJiraMyWorkFetchError = Schema.is(JiraMyWorkFetchError);
const isMyWorkError = Schema.is(MyWorkError);

interface MyWorkServiceShape {
  readonly getSummary: (
    input: MyWorkSummaryInput,
  ) => Effect.Effect<MyWorkSummaryResult, MyWorkError>;
  readonly handoffJiraTicketToQa: (
    input: JiraQaHandoffInput,
  ) => Effect.Effect<JiraQaHandoffResult, MyWorkError>;
}

export class MyWorkService extends Context.Service<MyWorkService, MyWorkServiceShape>()(
  "t3/source-control/MyWorkService",
) {}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeGitHubState(value: unknown): "open" | "closed" | "merged" {
  if (typeof value !== "string") return "open";
  switch (value.toLowerCase()) {
    case "open":
      return "open";
    case "closed":
      return "closed";
    case "merged":
      return "merged";
    default:
      return "open";
  }
}

function normalizeReviewDecision(
  value: unknown,
): "approved" | "changes_requested" | "review_required" | "unknown" | null {
  if (typeof value !== "string") return null;
  switch (value.toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_required";
    default:
      return "unknown";
  }
}

function normalizeIsoString(value: unknown): string | null {
  const iso = asNonEmptyString(value);
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? iso : null;
}

function normalizeRepositoryNameWithOwner(value: unknown): string | null {
  if (typeof value === "string") {
    return asNonEmptyString(value);
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return (
    asNonEmptyString(record.nameWithOwner) ??
    asNonEmptyString(record.fullName) ??
    asNonEmptyString(record.name) ??
    null
  );
}

function normalizePullRequestItem(
  kind: MyWorkPullRequestKind,
  item: unknown,
): MyWorkPullRequest | null {
  if (typeof item !== "object" || item === null) return null;
  const record = item as Record<string, unknown>;
  const number = typeof record.number === "number" ? Math.trunc(record.number) : NaN;
  if (!Number.isInteger(number) || number <= 0) return null;

  const title = asNonEmptyString(record.title);
  const url = asNonEmptyString(record.url);
  const updatedAt = normalizeIsoString(record.updatedAt);
  const repositoryNameWithOwner = normalizeRepositoryNameWithOwner(record.repository);
  const headRefName = asNonEmptyString(record.headRefName);
  const reviewDecision = normalizeReviewDecision(record.reviewDecision);
  if (!title || !url || !updatedAt || !repositoryNameWithOwner) return null;

  return {
    kind,
    provider: "github",
    number,
    title,
    url,
    repositoryNameWithOwner,
    ...(headRefName ? { headRefName } : {}),
    ...(reviewDecision ? { reviewDecision } : {}),
    state: normalizeGitHubState(record.state),
    isDraft: record.isDraft === true,
    updatedAt,
  };
}

function normalizePullRequestItems(
  kind: MyWorkPullRequestKind,
  items: unknown,
): ReadonlyArray<MyWorkPullRequest> {
  if (!Array.isArray(items)) return [];
  const normalized: MyWorkPullRequest[] = [];
  for (const item of items) {
    const parsed = normalizePullRequestItem(kind, item);
    if (parsed) {
      normalized.push(parsed);
    }
  }
  return normalized;
}

function parseJsonSafe(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sortByUpdatedAtDesc<T extends { readonly updatedAt: string }>(
  items: ReadonlyArray<T>,
): T[] {
  return [...items].toSorted((left, right) => {
    const rightValue = Date.parse(right.updatedAt);
    const leftValue = Date.parse(left.updatedAt);
    return rightValue - leftValue;
  });
}

function jiraBaseUrlFromEnvironment(env: NodeJS.ProcessEnv): string | null {
  return (
    asNonEmptyString(env.T3CODE_JIRA_BASE_URL) ??
    asNonEmptyString(env.JIRA_BASE_URL) ??
    asNonEmptyString(env.ATLASSIAN_JIRA_BASE_URL) ??
    null
  );
}

function jiraEmailFromEnvironment(env: NodeJS.ProcessEnv): string | null {
  return (
    asNonEmptyString(env.T3CODE_JIRA_EMAIL) ??
    asNonEmptyString(env.JIRA_EMAIL) ??
    asNonEmptyString(env.ATLASSIAN_EMAIL) ??
    null
  );
}

function jiraApiTokenFromEnvironment(env: NodeJS.ProcessEnv): string | null {
  return (
    asNonEmptyString(env.T3CODE_JIRA_API_TOKEN) ??
    asNonEmptyString(env.JIRA_API_TOKEN) ??
    asNonEmptyString(env.ATLASSIAN_API_TOKEN) ??
    null
  );
}

function resolveJiraConfig(input: MyWorkSummaryInput): JiraConfig | null {
  const baseUrl = asNonEmptyString(input.jiraBaseUrl) ?? jiraBaseUrlFromEnvironment(process.env);
  const email = asNonEmptyString(input.jiraEmail) ?? jiraEmailFromEnvironment(process.env);
  const apiToken = asNonEmptyString(input.jiraApiToken) ?? jiraApiTokenFromEnvironment(process.env);
  if (!baseUrl || !email || !apiToken) {
    return null;
  }

  const jql =
    asNonEmptyString(input.jiraJql) ??
    asNonEmptyString(process.env.T3CODE_JIRA_JQL) ??
    asNonEmptyString(process.env.JIRA_JQL) ??
    DEFAULT_JIRA_JQL;

  return { baseUrl, email, apiToken, jql };
}

function normalizeComparableJiraStatus(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, " ");
}

function resolveJiraQaStatusCandidates(): ReadonlyArray<string> {
  const configured = asNonEmptyString(process.env.T3CODE_JIRA_QA_STATUS);
  if (configured) {
    const parsed = configured
      .split(",")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    if (parsed.length > 0) {
      return parsed;
    }
  }
  return ["QA", "In QA", "Ready for QA", "QA Handoff"];
}

interface JiraTransitionCandidate {
  readonly id: string;
  readonly name: string;
  readonly toStatusName: string;
}

function selectQaTransition(
  transitions: ReadonlyArray<JiraTransitionCandidate>,
): JiraTransitionCandidate | null {
  const byStatus = new Map<string, JiraTransitionCandidate>();
  for (const transition of transitions) {
    byStatus.set(normalizeComparableJiraStatus(transition.toStatusName), transition);
    byStatus.set(normalizeComparableJiraStatus(transition.name), transition);
  }
  for (const candidate of resolveJiraQaStatusCandidates()) {
    const matched = byStatus.get(normalizeComparableJiraStatus(candidate));
    if (matched) {
      return matched;
    }
  }
  return null;
}

function toJiraAdfCommentBody(text: string): {
  readonly type: "doc";
  readonly version: 1;
  readonly content: ReadonlyArray<{
    readonly type: "paragraph";
    readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  }>;
} {
  const normalizedLines = text
    .split(/\r?\n/gu)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const paragraphs = normalizedLines.length > 0 ? normalizedLines : ["QA handoff update."];

  return {
    type: "doc",
    version: 1,
    content: paragraphs.map((line) => ({
      type: "paragraph" as const,
      content: [
        {
          type: "text" as const,
          text: line,
        },
      ],
    })),
  };
}

function jiraNotConfiguredSnapshot(): JiraMyWorkSnapshot {
  const baseUrl = jiraBaseUrlFromEnvironment(process.env);
  const missing: string[] = [];
  if (!baseUrl) missing.push("T3CODE_JIRA_BASE_URL");
  if (!jiraEmailFromEnvironment(process.env)) missing.push("T3CODE_JIRA_EMAIL");
  if (!jiraApiTokenFromEnvironment(process.env)) missing.push("T3CODE_JIRA_API_TOKEN");

  return {
    status: "not_configured",
    baseUrl,
    detail:
      missing.length > 0
        ? `Missing required environment variables: ${missing.join(", ")}`
        : "Configure Jira with T3CODE_JIRA_BASE_URL, T3CODE_JIRA_EMAIL, and T3CODE_JIRA_API_TOKEN.",
    tickets: [],
    pickupTickets: [],
    pickupBoards: [],
  };
}

function normalizeJiraStatus(value: unknown): JiraTicketSummary["status"] | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const name = asNonEmptyString(record.name);
  if (!name) return null;

  const categoryValue =
    typeof record.statusCategory === "object" && record.statusCategory !== null
      ? (asNonEmptyString((record.statusCategory as Record<string, unknown>).name) ??
        asNonEmptyString((record.statusCategory as Record<string, unknown>).key))
      : null;

  return categoryValue ? { name, category: categoryValue } : { name };
}

function normalizeJiraIssue(baseUrl: string, issue: unknown): JiraTicketSummary | null {
  if (typeof issue !== "object" || issue === null) return null;
  const record = issue as Record<string, unknown>;
  const key = asNonEmptyString(record.key);
  if (!key) return null;

  const fields =
    typeof record.fields === "object" && record.fields !== null
      ? (record.fields as Record<string, unknown>)
      : null;
  if (!fields) return null;

  const title = asNonEmptyString(fields.summary);
  const status = normalizeJiraStatus(fields.status);
  const updatedAt = normalizeIsoString(fields.updated);
  if (!title || !status || !updatedAt) return null;

  const priority =
    typeof fields.priority === "object" && fields.priority !== null
      ? asNonEmptyString((fields.priority as Record<string, unknown>).name)
      : null;
  const assignee =
    typeof fields.assignee === "object" && fields.assignee !== null
      ? asNonEmptyString((fields.assignee as Record<string, unknown>).displayName)
      : null;
  const labels = Array.isArray(fields.labels)
    ? fields.labels
        .map((label) => asNonEmptyString(label))
        .filter((label): label is string => label !== null)
    : [];

  const issueUrl = new URL(`/browse/${encodeURIComponent(key)}`, baseUrl).toString();

  return {
    key,
    url: issueUrl,
    title,
    status,
    ...(priority ? { priority } : {}),
    ...(assignee ? { assignee } : {}),
    ...(labels.length > 0 ? { labels } : {}),
    updatedAt,
  };
}

function escapeJqlLiteral(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function normalizeJiraBoard(item: unknown): JiraBoardSummary | null {
  if (typeof item !== "object" || item === null) return null;
  const record = item as Record<string, unknown>;
  const id = parsePositiveInteger(record.id);
  const name = asNonEmptyString(record.name);
  if (!id || !name) return null;
  return { id, name };
}

function deriveFallbackJqls(input: {
  readonly sourceJql: string;
  readonly email: string;
  readonly accountId: string | null;
}): ReadonlyArray<string> {
  if (!input.sourceJql.includes("currentUser()")) {
    return [];
  }

  const candidates = [
    input.sourceJql.replaceAll("currentUser()", escapeJqlLiteral(input.email)),
    ...(input.accountId
      ? [input.sourceJql.replaceAll("currentUser()", escapeJqlLiteral(input.accountId))]
      : []),
  ];

  const unique = new Set<string>();
  for (const candidate of candidates) {
    if (candidate !== input.sourceJql) {
      unique.add(candidate);
    }
  }

  return Array.from(unique);
}

function deriveBroadAssigneeFallbackJqls(input: {
  readonly email: string;
  readonly accountId: string | null;
}): ReadonlyArray<string> {
  const candidates = [
    `assignee = ${escapeJqlLiteral(input.email)} ORDER BY updated DESC`,
    ...(input.accountId
      ? [`assignee = ${escapeJqlLiteral(input.accountId)} ORDER BY updated DESC`]
      : []),
  ];
  return Array.from(new Set(candidates));
}

function deriveBroadAssigneeOrReporterFallbackJqls(input: {
  readonly email: string;
  readonly accountId: string | null;
}): ReadonlyArray<string> {
  const candidates = [
    `(assignee = ${escapeJqlLiteral(input.email)} OR reporter = ${escapeJqlLiteral(input.email)}) ORDER BY updated DESC`,
    ...(input.accountId
      ? [
          `(assignee = ${escapeJqlLiteral(input.accountId)} OR reporter = ${escapeJqlLiteral(input.accountId)}) ORDER BY updated DESC`,
        ]
      : []),
  ];
  return Array.from(new Set(candidates));
}

const make = Effect.fn("makeMyWorkService")(function* () {
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const config = yield* ServerConfig;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const runGitHubSearch = (
    kind: MyWorkPullRequestKind,
    filterFlag: "--author=@me" | "--review-requested=@me",
    limit: number,
  ): Effect.Effect<ReadonlyArray<MyWorkPullRequest>> =>
    vcsProcess
      .run({
        operation: "myWork.searchPullRequests",
        command: "gh",
        args: [
          "search",
          "prs",
          filterFlag,
          "--state=open",
          `--limit=${String(limit)}`,
          "--json",
          "number,title,url,repository,state,isDraft,updatedAt",
        ],
        cwd: config.cwd,
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((output) => {
          if (output.exitCode !== 0) {
            return [];
          }
          const raw = output.stdout.trim();
          if (raw.length === 0) {
            return [];
          }
          return normalizePullRequestItems(kind, parseJsonSafe(raw));
        }),
        Effect.catch((cause) =>
          Effect.logWarning("Unable to read GitHub pull requests for My Work.", {
            detail: cause.message,
            filter: filterFlag,
          }).pipe(Effect.as<ReadonlyArray<MyWorkPullRequest>>([])),
        ),
      );

  const loadPullRequests = (limit: number): Effect.Effect<ReadonlyArray<MyWorkPullRequest>> =>
    Effect.all(
      {
        reviewRequested: runGitHubSearch("review_requested", "--review-requested=@me", limit),
        authored: runGitHubSearch("authored", "--author=@me", limit),
      },
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(({ reviewRequested, authored }) => {
        // Keep review queue entries first when a PR appears in both lists.
        const deduped = new Map<string, MyWorkPullRequest>();
        for (const pr of [...reviewRequested, ...authored]) {
          const key = `${pr.repositoryNameWithOwner}#${pr.number}`;
          if (!deduped.has(key)) {
            deduped.set(key, pr);
          }
        }
        return sortByUpdatedAtDesc(Array.from(deduped.values()));
      }),
    );

  const loadJira = (input: MyWorkSummaryInput): Effect.Effect<JiraMyWorkSnapshot> => {
    const jiraConfig = resolveJiraConfig(input);
    if (!jiraConfig) {
      return Effect.succeed(jiraNotConfiguredSnapshot());
    }

    const normalizedBaseUrl = jiraConfig.baseUrl.replace(/\/+$/u, "");
    const limit = input.jiraLimit ?? DEFAULT_JIRA_LIMIT;
    return Effect.tryPromise({
      try: async () => {
        const authHeader = `Basic ${Buffer.from(`${jiraConfig.email}:${jiraConfig.apiToken}`).toString("base64")}`;
        const searchEndpoint = new URL("/rest/api/3/search/jql", normalizedBaseUrl).toString();
        const fetchTicketsForJql = async (
          jql: string,
        ): Promise<{
          readonly tickets: ReadonlyArray<JiraTicketSummary>;
          readonly lastFailureDetail: string | null;
        }> => {
          const body = {
            jql,
            maxResults: limit,
            fields: ["summary", "status", "priority", "assignee", "updated", "labels"],
          };
          const searchParams = new URLSearchParams({
            jql,
            maxResults: String(limit),
            fields: "summary,status,priority,assignee,updated,labels",
          });
          const requestCandidates = [
            {
              method: "POST" as const,
              endpoint: searchEndpoint,
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                Authorization: authHeader,
              },
              body: JSON.stringify(body),
            },
            {
              method: "GET" as const,
              endpoint: `${searchEndpoint}?${searchParams.toString()}`,
              headers: {
                Accept: "application/json",
                Authorization: authHeader,
              },
              body: undefined,
            },
          ];

          let payload: { issues?: unknown } | null = null;
          let lastFailureDetail: string | null = null;

          for (const candidate of requestCandidates) {
            const response = await fetch(candidate.endpoint, {
              method: candidate.method,
              headers: candidate.headers,
              ...(candidate.body ? { body: candidate.body } : {}),
            });

            if (response.ok) {
              payload = (await response.json()) as { issues?: unknown };
              break;
            }

            lastFailureDetail = `Jira search request failed (${candidate.method}) with ${response.status} ${response.statusText}`;
          }

          if (!payload) {
            return { tickets: [], lastFailureDetail };
          }

          const issues = Array.isArray(payload.issues) ? payload.issues : [];
          const tickets = issues
            .map((issue) => normalizeJiraIssue(normalizedBaseUrl, issue))
            .filter((issue): issue is JiraTicketSummary => issue !== null);
          return {
            tickets: sortByUpdatedAtDesc(tickets),
            lastFailureDetail,
          };
        };

        const fetchAgileValues = async <T>(
          path: string,
          searchParams: Record<string, string>,
        ): Promise<ReadonlyArray<T>> => {
          const values: T[] = [];
          let startAt = 0;
          while (true) {
            const endpoint = new URL(path, normalizedBaseUrl);
            for (const [key, value] of Object.entries(searchParams)) {
              endpoint.searchParams.set(key, value);
            }
            endpoint.searchParams.set("startAt", String(startAt));

            const response = await fetch(endpoint, {
              method: "GET",
              headers: {
                Accept: "application/json",
                Authorization: authHeader,
              },
            });
            if (!response.ok) {
              return values;
            }

            const payload = (await response.json()) as {
              values?: unknown;
              maxResults?: unknown;
              isLast?: unknown;
            };
            const pageValues = Array.isArray(payload.values) ? (payload.values as T[]) : [];
            values.push(...pageValues);

            const maxResults = parsePositiveInteger(payload.maxResults) ?? 50;
            const isLast = payload.isLast === true;
            if (isLast || pageValues.length === 0) {
              break;
            }

            startAt += maxResults;
          }

          return values;
        };

        const pickupBoardIds = new Set<number>(input.jiraPickupBoardIds ?? []);
        const availablePickupBoards = (
          await fetchAgileValues<unknown>("/rest/agile/1.0/board", {
            type: "scrum",
            maxResults: "50",
          })
        )
          .map((board) => normalizeJiraBoard(board))
          .filter((board): board is JiraBoardSummary => board !== null)
          .toSorted((left, right) => left.name.localeCompare(right.name));

        const selectedPickupBoards =
          pickupBoardIds.size > 0
            ? availablePickupBoards.filter((board) => pickupBoardIds.has(board.id))
            : availablePickupBoards;

        const activeSprintIds = new Set<number>();
        for (const board of selectedPickupBoards) {
          const sprints = await fetchAgileValues<unknown>(
            `/rest/agile/1.0/board/${board.id}/sprint`,
            {
              state: "active",
              maxResults: "50",
            },
          );
          for (const sprint of sprints) {
            if (typeof sprint !== "object" || sprint === null) continue;
            const sprintId = parsePositiveInteger((sprint as Record<string, unknown>).id);
            if (sprintId) {
              activeSprintIds.add(sprintId);
            }
          }
        }

        const initialResult = await fetchTicketsForJql(jiraConfig.jql);
        let tickets = initialResult.tickets;
        let detail: string | null = null;
        let lastFailureDetail = initialResult.lastFailureDetail;
        let accountId: string | null = null;

        if (tickets.length === 0) {
          try {
            const myselfResponse = await fetch(new URL("/rest/api/3/myself", normalizedBaseUrl), {
              method: "GET",
              headers: {
                Accept: "application/json",
                Authorization: authHeader,
              },
            });
            if (myselfResponse.ok) {
              const myself = (await myselfResponse.json()) as { accountId?: unknown };
              accountId = asNonEmptyString(myself.accountId);
            }
          } catch {
            // Ignore /myself failures; fallback can still use email.
          }

          const fallbackJqls = deriveFallbackJqls({
            sourceJql: jiraConfig.jql,
            email: jiraConfig.email,
            accountId,
          });
          for (const fallbackJql of fallbackJqls) {
            const fallbackResult = await fetchTicketsForJql(fallbackJql);
            if (fallbackResult.lastFailureDetail) {
              lastFailureDetail = fallbackResult.lastFailureDetail;
            }
            if (fallbackResult.tickets.length > 0) {
              tickets = fallbackResult.tickets;
              detail = "Used Jira fallback filter because currentUser() returned no tickets.";
              break;
            }
          }

          if (tickets.length === 0) {
            const broadFallbackJqls = deriveBroadAssigneeFallbackJqls({
              email: jiraConfig.email,
              accountId,
            });
            for (const fallbackJql of broadFallbackJqls) {
              const fallbackResult = await fetchTicketsForJql(fallbackJql);
              if (fallbackResult.lastFailureDetail) {
                lastFailureDetail = fallbackResult.lastFailureDetail;
              }
              if (fallbackResult.tickets.length > 0) {
                tickets = fallbackResult.tickets;
                detail =
                  "Used broader Jira fallback because the configured JQL returned no tickets.";
                break;
              }
            }
          }

          if (tickets.length === 0) {
            const broadFallbackJqls = deriveBroadAssigneeOrReporterFallbackJqls({
              email: jiraConfig.email,
              accountId,
            });
            for (const fallbackJql of broadFallbackJqls) {
              const fallbackResult = await fetchTicketsForJql(fallbackJql);
              if (fallbackResult.lastFailureDetail) {
                lastFailureDetail = fallbackResult.lastFailureDetail;
              }
              if (fallbackResult.tickets.length > 0) {
                tickets = fallbackResult.tickets;
                detail =
                  "Used assignee/reporter fallback because the configured JQL returned no tickets.";
                break;
              }
            }
          }
        }

        let pickupTickets: ReadonlyArray<JiraTicketSummary> = [];
        if (activeSprintIds.size > 0) {
          const sprintIdJql = Array.from(activeSprintIds)
            .toSorted((left, right) => left - right)
            .join(", ");
          const pickupScopedJql = `sprint in (${sprintIdJql}) AND assignee is EMPTY AND statusCategory = "To Do" ORDER BY updated DESC`;
          const pickupScoped = await fetchTicketsForJql(pickupScopedJql);
          pickupTickets = pickupScoped.tickets;
          if (pickupTickets.length === 0) {
            const broadScopedJql = `sprint in (${sprintIdJql}) AND assignee is EMPTY ORDER BY updated DESC`;
            const pickupFallback = await fetchTicketsForJql(broadScopedJql);
            pickupTickets = pickupFallback.tickets;
          }
        } else if (selectedPickupBoards.length === 0) {
          pickupTickets = [];
        } else {
          const pickupPrimary = await fetchTicketsForJql(DEFAULT_JIRA_PICKUP_JQL);
          pickupTickets = pickupPrimary.tickets;
          if (pickupTickets.length === 0) {
            const broadPickupJql =
              "sprint in openSprints() AND assignee is EMPTY ORDER BY updated DESC";
            const pickupFallback = await fetchTicketsForJql(broadPickupJql);
            pickupTickets = pickupFallback.tickets;
          }
        }

        if (tickets.length === 0 && lastFailureDetail) {
          throw new JiraMyWorkFetchError({
            detail: lastFailureDetail,
          });
        }

        return {
          status: "available" as const,
          baseUrl: normalizedBaseUrl,
          detail:
            tickets.length === 0
              ? (detail ??
                "Connected to Jira, but no tickets matched the configured filter. Update the JQL in the Jira panel.")
              : detail,
          tickets,
          pickupTickets,
          pickupBoards: availablePickupBoards,
        } satisfies JiraMyWorkSnapshot;
      },
      catch: (cause) =>
        isJiraMyWorkFetchError(cause)
          ? cause
          : new JiraMyWorkFetchError({
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Unable to read Jira tickets for My Work.", {
          detail: cause.detail,
        }).pipe(
          Effect.as<JiraMyWorkSnapshot>({
            status: "error",
            baseUrl: normalizedBaseUrl,
            detail: cause.detail,
            tickets: [],
            pickupTickets: [],
            pickupBoards: [],
          }),
        ),
      ),
    );
  };

  const handoffJiraTicketToQa = (
    input: JiraQaHandoffInput,
  ): Effect.Effect<JiraQaHandoffResult, MyWorkError> => {
    const jiraConfig = resolveJiraConfig({
      jiraBaseUrl: input.jiraBaseUrl,
      jiraEmail: input.jiraEmail,
      jiraApiToken: input.jiraApiToken,
    });
    if (!jiraConfig) {
      return Effect.fail(
        new MyWorkError({
          operation: "jira.handoffToQa",
          detail:
            "Jira is not configured. Provide T3CODE_JIRA_BASE_URL, T3CODE_JIRA_EMAIL, and T3CODE_JIRA_API_TOKEN.",
        }),
      );
    }

    const normalizedBaseUrl = jiraConfig.baseUrl.replace(/\/+$/u, "");
    const ticketKey = input.ticketKey.trim().toUpperCase();
    const qaComment = asNonEmptyString(input.qaComment);

    return Effect.tryPromise({
      try: async () => {
        const authHeader = `Basic ${Buffer.from(`${jiraConfig.email}:${jiraConfig.apiToken}`).toString("base64")}`;
        const transitionsEndpoint = new URL(
          `/rest/api/3/issue/${encodeURIComponent(ticketKey)}/transitions`,
          normalizedBaseUrl,
        );
        const transitionResponse = await fetch(transitionsEndpoint, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: authHeader,
          },
        });
        if (!transitionResponse.ok) {
          const detail = (await transitionResponse.text()).trim();
          throw new MyWorkError({
            operation: "jira.handoffToQa.transitions",
            detail: `Unable to load Jira transitions for ${ticketKey}: ${transitionResponse.status} ${detail || transitionResponse.statusText}`,
          });
        }
        const transitionPayload = (await transitionResponse.json()) as {
          transitions?: ReadonlyArray<{
            id?: unknown;
            name?: unknown;
            to?: { name?: unknown } | null;
          }>;
        };
        const transitions: JiraTransitionCandidate[] = Array.isArray(transitionPayload.transitions)
          ? transitionPayload.transitions
              .map((entry) => {
                const id = asNonEmptyString(entry.id);
                const name = asNonEmptyString(entry.name);
                const toStatusName = asNonEmptyString(entry.to?.name);
                if (!id || !name || !toStatusName) return null;
                return { id, name, toStatusName };
              })
              .filter((entry): entry is JiraTransitionCandidate => entry !== null)
          : [];

        const qaTransition = selectQaTransition(transitions);
        if (!qaTransition) {
          const availableStatuses =
            transitions.length > 0
              ? transitions.map((transition) => transition.toStatusName).join(", ")
              : "none";
          throw new MyWorkError({
            operation: "jira.handoffToQa.transitions",
            detail: `No QA transition found for ${ticketKey}. Available statuses: ${availableStatuses}`,
          });
        }

        const doTransitionResponse = await fetch(transitionsEndpoint, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: authHeader,
          },
          body: JSON.stringify({
            transition: {
              id: qaTransition.id,
            },
          }),
        });
        if (!doTransitionResponse.ok) {
          const detail = (await doTransitionResponse.text()).trim();
          throw new MyWorkError({
            operation: "jira.handoffToQa.transition",
            detail: `Unable to transition ${ticketKey} to ${qaTransition.toStatusName}: ${doTransitionResponse.status} ${detail || doTransitionResponse.statusText}`,
          });
        }

        let commentPosted = false;
        if (qaComment) {
          const commentEndpoint = new URL(
            `/rest/api/3/issue/${encodeURIComponent(ticketKey)}/comment`,
            normalizedBaseUrl,
          );
          const commentResponse = await fetch(commentEndpoint, {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              Authorization: authHeader,
            },
            body: JSON.stringify({
              body: toJiraAdfCommentBody(qaComment),
            }),
          });
          if (!commentResponse.ok) {
            const detail = (await commentResponse.text()).trim();
            throw new MyWorkError({
              operation: "jira.handoffToQa.comment",
              detail: `Moved ${ticketKey} to ${qaTransition.toStatusName}, but failed to post QA note: ${commentResponse.status} ${detail || commentResponse.statusText}`,
            });
          }
          commentPosted = true;
        }

        return {
          ticketKey,
          transitioned: true,
          toStatus: qaTransition.toStatusName,
          commentPosted,
          detail: commentPosted
            ? `Moved ${ticketKey} to ${qaTransition.toStatusName} and posted QA notes.`
            : `Moved ${ticketKey} to ${qaTransition.toStatusName}.`,
        } satisfies JiraQaHandoffResult;
      },
      catch: (cause) =>
        isMyWorkError(cause)
          ? cause
          : new MyWorkError({
              operation: "jira.handoffToQa",
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
    });
  };

  return MyWorkService.of({
    getSummary: (input) =>
      Effect.gen(function* () {
        const pullRequestLimit = input.pullRequestLimit ?? DEFAULT_PULL_REQUEST_LIMIT;
        const [pullRequests, jira] = yield* Effect.all(
          [loadPullRequests(pullRequestLimit), loadJira(input)],
          { concurrency: "unbounded" },
        );
        const refreshedAt = yield* nowIso;

        return {
          refreshedAt,
          pullRequests,
          jira,
        } satisfies MyWorkSummaryResult;
      }),
    handoffJiraTicketToQa,
  });
});

export const layer = Layer.effect(MyWorkService, make()).pipe(Layer.provide(VcsProcess.layer));
