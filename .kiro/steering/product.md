# Product

This workspace contains two related repositories that together form a system for defining, publishing, and running coding agents across groups of repositories:

- **agent-manager** — a Laravel + Filament admin app that authors and version-controls agent definitions, then publishes them as downloadable bundles.
- **agent-kitty** — a local browser interface that runs those agents against grouped repositories via the GitHub Copilot CLI.

agent-manager is the authoring/distribution side; agent-kitty is the local runtime. The bundles agent-manager produces (`AGENTS.md`, `MANAGED_CONTEXT.md`, a `.kiro/agents/<slug>.json` config, and a `repository-manifest.json`) describe exactly the kind of agent workspace agent-kitty discovers and runs.

---

## Agent Kitty

Agent Kitty is a local browser interface for running coding agents across groups of related repositories. The current release uses the GitHub Copilot CLI as its agent runtime, driven through the Agent Client Protocol (ACP).

## Core Concept

The central unit is an **agent workspace** (not a single repo). An agent is a folder that groups one or more related repositories together, so the coding agent can reason across the whole system rather than one repo at a time.

An agent folder contains:
- `AGENTS.md` — workspace instructions and context (shown in the Overview tab, loaded by Copilot)
- `mcp.json` — workspace-specific MCP server configuration
- `start` — executable zsh script that launches Copilot with shared + workspace MCP configs
- one or more repositories that belong together

## What It Provides

- A browser UI for GitHub Copilot coding agents with streaming responses
- Multiple independent agents in one interface (each with its own Copilot process/session)
- Tool activity visibility, markdown + syntax-highlighted code rendering, file attachments
- Per-agent model selection, reasoning-level selection, and conversation history
- Shared MCP servers (available to all agents) and workspace-specific MCP servers
- Repository and branch visibility per agent

## Key Principles

- Group repositories by engineering context, not team ownership. If an agent naturally needs several repos together to complete a task, they belong in the same agent.
- Setup commands are conservative: `init` and `add-agent` never overwrite existing `AGENTS.md`, `mcp.json`, or `start` files. Shared templates are only copied when missing.
- Agent Kitty does not modify the Git repositories themselves.
- The architecture is intentionally decoupled from a single model provider; additional agent runtimes may be added later.

### Security

- Never store credentials in `AGENTS.md`, `mcp.json`, or the repository.
- MCP integrations should authenticate via OAuth, environment variables, ignored `.env` files, or approved secret stores.

---

## Agent Manager

Agent Manager is a Laravel + Filament admin application for defining agents and publishing them as versioned, downloadable bundles.

### Core Concepts

- **Agent** — a named, slugged agent workspace definition (name, description, owning team, active flag). Identified by `slug`.
- **AgentVersion** — a specific version of an agent, either `draft` or `published`. Holds the generated `AGENTS.md`, `MANAGED_CONTEXT.md`, a Kiro agent config (JSON), and a repository manifest (JSON). Publishing stamps `published_at`.
- **Bundle** — a ZIP produced for a published version, in one of two formats:
  - **Kiro bundle** — includes `managed/.kiro/agents/<slug>.json`.
  - **Copilot bundle** — additionally generates `managed/.github/copilot-instructions.md` derived from the Kiro config.

Both bundles contain `bundle.json`, `repository-manifest.json`, `managed/AGENTS.md`, `managed/MANAGED_CONTEXT.md`, and `managed/refresh-context.sh`.

### What It Provides

- A Filament admin panel to manage Agents and Agent Versions, with dashboard widgets (stats, latest versions).
- A console command `agent:publish {slug} {--force}` to publish an agent from `resources/agents/{slug}` into the database.
- A versioned JSON API (`/api/v1`) to list agents and download Kiro or Copilot bundles.

### Managed vs Local Context

The scaffolding Agent Manager generates distinguishes two context layers that downstream agents must respect:

- **`MANAGED_CONTEXT.md`** — centrally controlled by Agent Manager. Agents must not edit it locally unless explicitly asked.
- **`LOCAL_CONTEXT.md`** — belongs to the developer using the agent. Never overwrite it during install or update.

Generated agents also consume `.ai-context/` Repomix snapshots (prefer `*-summary.xml` first, `*-full.xml` only when needed) and refresh context via `./refresh-context.sh current|master`.

### Security

- Never expose credentials, API tokens, private keys, passwords, OAuth secrets, or customer-sensitive data in generated or stored content.
- The default owning team for published agents is "Finance Systems Development" when none is provided.
