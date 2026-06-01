# NorthStar Code (T3 Code Fork)

NorthStar Code is a fork of [T3 Code](https://github.com/pingdotgg/t3code): a minimal web GUI for coding agents (currently Codex, Claude, and OpenCode, more coming soon).

This fork keeps T3 primitives intact while adding an opinionated developer workbench for daily engineering workflow.

## What's added in this fork

- Engineering workbench dashboard on the no-thread screen
- Open PR workflow sections:
  - Authored PRs
  - PRs where review is requested
- PR actions for quick open/hide and AI review prompt seeding
- Jira "tickets in flight" panel
- Jira "unassigned sprint tickets" panel with board-scope controls
- Workflow prompt launcher that starts a new chat with the selected prompt prefilled
- QA handoff action for transitioning Jira tickets to QA (with optional QA notes)

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, and OpenCode.
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Run without installing

```bash
npx t3
```


## Local development (this fork)

```bash
bun install
PATH="$HOME/.bun/bin:$PATH" bun run dev:desktop
```

## Jira setup for the workbench

Set Jira credentials in the same shell where you launch the app:

```bash
export T3CODE_JIRA_BASE_URL="https://your-org.atlassian.net"
export T3CODE_JIRA_EMAIL="you@company.com"
export T3CODE_JIRA_API_TOKEN="your_api_token"
export T3CODE_JIRA_JQL='assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'
PATH="$HOME/.bun/bin:$PATH" bun run dev:desktop
```

Notes:

- `T3CODE_JIRA_JQL` is optional (default is the same query shown above).
- The workbench can also test/save Jira settings from the UI.

## Contributing

Before local development, prepare the environment and install dependencies:

```bash
# Optional: only needed if you use mise for dev tool management.
mise install
bun install .
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
