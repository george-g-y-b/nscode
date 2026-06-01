import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { VcsDriverKind } from "./vcs.ts";

export const SourceControlProviderKind = Schema.Literals([
  "github",
  "gitlab",
  "azure-devops",
  "bitbucket",
  "unknown",
]);
export type SourceControlProviderKind = typeof SourceControlProviderKind.Type;

export const SourceControlProviderInfo = Schema.Struct({
  kind: SourceControlProviderKind,
  name: TrimmedNonEmptyString,
  baseUrl: Schema.String,
});
export type SourceControlProviderInfo = typeof SourceControlProviderInfo.Type;

export const ChangeRequestState = Schema.Literals(["open", "closed", "merged"]);
export type ChangeRequestState = typeof ChangeRequestState.Type;

export const ChangeRequest = Schema.Struct({
  provider: SourceControlProviderKind,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: Schema.String,
  baseRefName: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  state: ChangeRequestState,
  updatedAt: Schema.Option(Schema.DateTimeUtc),
  isCrossRepository: Schema.optional(Schema.Boolean),
  headRepositoryNameWithOwner: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  headRepositoryOwnerLogin: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type ChangeRequest = typeof ChangeRequest.Type;

export const SourceControlRepositoryCloneUrls = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});
export type SourceControlRepositoryCloneUrls = typeof SourceControlRepositoryCloneUrls.Type;

export const SourceControlRepositoryVisibility = Schema.Literals(["private", "public"]);
export type SourceControlRepositoryVisibility = typeof SourceControlRepositoryVisibility.Type;

export const SourceControlCloneProtocol = Schema.Literals(["auto", "ssh", "https"]);
export type SourceControlCloneProtocol = typeof SourceControlCloneProtocol.Type;

export const SourceControlRepositoryInfo = Schema.Struct({
  provider: SourceControlProviderKind,
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});
export type SourceControlRepositoryInfo = typeof SourceControlRepositoryInfo.Type;

export const SourceControlRepositoryLookupInput = Schema.Struct({
  provider: SourceControlProviderKind,
  repository: TrimmedNonEmptyString,
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type SourceControlRepositoryLookupInput = typeof SourceControlRepositoryLookupInput.Type;

export const SourceControlCloneRepositoryInput = Schema.Struct({
  provider: Schema.optional(SourceControlProviderKind),
  repository: Schema.optional(TrimmedNonEmptyString),
  remoteUrl: Schema.optional(TrimmedNonEmptyString),
  destinationPath: TrimmedNonEmptyString,
  protocol: Schema.optional(SourceControlCloneProtocol),
});
export type SourceControlCloneRepositoryInput = typeof SourceControlCloneRepositoryInput.Type;

export const SourceControlCloneRepositoryResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
  repository: Schema.NullOr(SourceControlRepositoryInfo),
});
export type SourceControlCloneRepositoryResult = typeof SourceControlCloneRepositoryResult.Type;

export const SourceControlPublishRepositoryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  provider: SourceControlProviderKind,
  repository: TrimmedNonEmptyString,
  visibility: SourceControlRepositoryVisibility,
  remoteName: Schema.optional(TrimmedNonEmptyString),
  protocol: Schema.optional(SourceControlCloneProtocol),
});
export type SourceControlPublishRepositoryInput = typeof SourceControlPublishRepositoryInput.Type;

export const SourceControlPublishStatus = Schema.Literals(["pushed", "remote_added"]);
export type SourceControlPublishStatus = typeof SourceControlPublishStatus.Type;

export const SourceControlPublishRepositoryResult = Schema.Struct({
  repository: SourceControlRepositoryInfo,
  remoteName: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  upstreamBranch: Schema.optional(TrimmedNonEmptyString),
  status: SourceControlPublishStatus,
});
export type SourceControlPublishRepositoryResult = typeof SourceControlPublishRepositoryResult.Type;

export const SourceControlDiscoveryStatus = Schema.Literals(["available", "missing"]);
export type SourceControlDiscoveryStatus = typeof SourceControlDiscoveryStatus.Type;

export const SourceControlProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type SourceControlProviderAuthStatus = typeof SourceControlProviderAuthStatus.Type;

export const SourceControlProviderAuth = Schema.Struct({
  status: SourceControlProviderAuthStatus,
  account: Schema.Option(TrimmedNonEmptyString),
  host: Schema.Option(TrimmedNonEmptyString),
  detail: Schema.Option(TrimmedNonEmptyString),
});
export type SourceControlProviderAuth = typeof SourceControlProviderAuth.Type;

const SourceControlDiscoverySharedFields = {
  label: TrimmedNonEmptyString,
  executable: Schema.optional(TrimmedNonEmptyString),
  status: SourceControlDiscoveryStatus,
  version: Schema.Option(TrimmedNonEmptyString),
  installHint: TrimmedNonEmptyString,
  detail: Schema.Option(TrimmedNonEmptyString),
} as const;

export const VcsDiscoveryItem = Schema.Struct({
  kind: VcsDriverKind,
  implemented: Schema.Boolean,
  ...SourceControlDiscoverySharedFields,
});
export type VcsDiscoveryItem = typeof VcsDiscoveryItem.Type;

export const SourceControlProviderDiscoveryItem = Schema.Struct({
  kind: SourceControlProviderKind,
  ...SourceControlDiscoverySharedFields,
  auth: SourceControlProviderAuth,
});
export type SourceControlProviderDiscoveryItem = typeof SourceControlProviderDiscoveryItem.Type;

export const SourceControlDiscoveryResult = Schema.Struct({
  versionControlSystems: Schema.Array(VcsDiscoveryItem),
  sourceControlProviders: Schema.Array(SourceControlProviderDiscoveryItem),
});
export type SourceControlDiscoveryResult = typeof SourceControlDiscoveryResult.Type;

export const MyWorkPullRequestKind = Schema.Literals(["authored", "review_requested"]);
export type MyWorkPullRequestKind = typeof MyWorkPullRequestKind.Type;

export const PullRequestReviewDecision = Schema.Literals([
  "approved",
  "changes_requested",
  "review_required",
  "unknown",
]);
export type PullRequestReviewDecision = typeof PullRequestReviewDecision.Type;

export const MyWorkPullRequest = Schema.Struct({
  kind: MyWorkPullRequestKind,
  provider: SourceControlProviderKind,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  repositoryNameWithOwner: TrimmedNonEmptyString,
  headRefName: Schema.optional(TrimmedNonEmptyString),
  reviewDecision: Schema.optional(PullRequestReviewDecision),
  state: ChangeRequestState,
  isDraft: Schema.Boolean,
  updatedAt: TrimmedNonEmptyString,
});
export type MyWorkPullRequest = typeof MyWorkPullRequest.Type;

export const JiraTicketStatus = Schema.Struct({
  name: TrimmedNonEmptyString,
  category: Schema.optional(TrimmedNonEmptyString),
});
export type JiraTicketStatus = typeof JiraTicketStatus.Type;

export const JiraTicketSummary = Schema.Struct({
  key: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  status: JiraTicketStatus,
  priority: Schema.optional(TrimmedNonEmptyString),
  assignee: Schema.optional(TrimmedNonEmptyString),
  labels: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  updatedAt: TrimmedNonEmptyString,
});
export type JiraTicketSummary = typeof JiraTicketSummary.Type;

export const JiraBoardSummary = Schema.Struct({
  id: PositiveInt,
  name: TrimmedNonEmptyString,
});
export type JiraBoardSummary = typeof JiraBoardSummary.Type;

export const JiraMyWorkStatus = Schema.Literals(["available", "not_configured", "error"]);
export type JiraMyWorkStatus = typeof JiraMyWorkStatus.Type;

export const JiraMyWorkSnapshot = Schema.Struct({
  status: JiraMyWorkStatus,
  baseUrl: Schema.NullOr(TrimmedNonEmptyString),
  detail: Schema.NullOr(TrimmedNonEmptyString),
  tickets: Schema.Array(JiraTicketSummary),
  pickupTickets: Schema.optionalKey(Schema.Array(JiraTicketSummary)),
  pickupBoards: Schema.optionalKey(Schema.Array(JiraBoardSummary)),
});
export type JiraMyWorkSnapshot = typeof JiraMyWorkSnapshot.Type;

export const MyWorkSummaryInput = Schema.Struct({
  pullRequestLimit: Schema.optional(PositiveInt),
  jiraLimit: Schema.optional(PositiveInt),
  jiraJql: Schema.optional(TrimmedNonEmptyString),
  jiraBaseUrl: Schema.optional(TrimmedNonEmptyString),
  jiraEmail: Schema.optional(TrimmedNonEmptyString),
  jiraApiToken: Schema.optional(TrimmedNonEmptyString),
  jiraPickupBoardIds: Schema.optional(Schema.Array(PositiveInt)),
});
export type MyWorkSummaryInput = typeof MyWorkSummaryInput.Type;

export const JiraQaHandoffInput = Schema.Struct({
  ticketKey: TrimmedNonEmptyString,
  qaComment: Schema.optional(TrimmedNonEmptyString),
  jiraBaseUrl: Schema.optional(TrimmedNonEmptyString),
  jiraEmail: Schema.optional(TrimmedNonEmptyString),
  jiraApiToken: Schema.optional(TrimmedNonEmptyString),
});
export type JiraQaHandoffInput = typeof JiraQaHandoffInput.Type;

export const JiraQaHandoffResult = Schema.Struct({
  ticketKey: TrimmedNonEmptyString,
  transitioned: Schema.Boolean,
  toStatus: Schema.NullOr(TrimmedNonEmptyString),
  commentPosted: Schema.Boolean,
  detail: TrimmedNonEmptyString,
});
export type JiraQaHandoffResult = typeof JiraQaHandoffResult.Type;

export const MyWorkSummaryResult = Schema.Struct({
  refreshedAt: TrimmedNonEmptyString,
  pullRequests: Schema.Array(MyWorkPullRequest),
  jira: JiraMyWorkSnapshot,
});
export type MyWorkSummaryResult = typeof MyWorkSummaryResult.Type;

export class SourceControlProviderError extends Schema.TaggedErrorClass<SourceControlProviderError>()(
  "SourceControlProviderError",
  {
    provider: SourceControlProviderKind,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Source control provider ${this.provider} failed in ${this.operation}: ${this.detail}`;
  }
}

export class SourceControlRepositoryError extends Schema.TaggedErrorClass<SourceControlRepositoryError>()(
  "SourceControlRepositoryError",
  {
    provider: SourceControlProviderKind,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Source control repository operation ${this.operation} failed for ${this.provider}: ${this.detail}`;
  }
}

export class MyWorkError extends Schema.TaggedErrorClass<MyWorkError>()("MyWorkError", {
  operation: TrimmedNonEmptyString,
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `My work query failed in ${this.operation}: ${this.detail}`;
  }
}
