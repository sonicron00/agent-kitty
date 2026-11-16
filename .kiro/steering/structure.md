# Project Structure

This workspace contains two repositories:

- `agent-kitty/` — the Node/TypeScript local runtime and browser UI.
- `agent-manager/` — the Laravel/Filament authoring and bundle-publishing app.

They are separate projects with independent toolchains. The sections below cover each.

---

# Agent Kitty (`agent-kitty/`)

## Repository Layout

```text
agent-kitty/
├── bin/
│   └── agent-kitty.mjs        # CLI entry point (init, start, doctor, add-agent)
├── server/
│   └── src/
│       ├── index.ts           # Express app, API routes, workspace/repo discovery
│       └── WorkspaceAgent.ts   # Per-workspace ACP connection to Copilot CLI
│   └── dist/                  # Compiled server output (build artifact)
├── web/                       # React + Vite browser UI (built to web/dist)
├── templates/
│   └── shared/                # Shared assets copied into .agent-kitty/shared on init
│       ├── mcp.json           # Shared MCP server config
│       ├── bin/               # MCP wrapper scripts (atlassian-mcp, lenses-mcp)
│       └── tools/
│           └── lenses-mcp/    # Bundled Python Lenses MCP project
├── package.json               # Root scripts, server deps, CLI bin
├── tsconfig.server.json       # Server TypeScript config
└── README.md
```

## Module Responsibilities

- **`bin/agent-kitty.mjs`** — The user-facing CLI. Scaffolds agent folders (`AGENTS.md`, `mcp.json`, `start`), copies shared MCP templates, runs environment checks (`doctor`), and launches the server with `COPILOT_ROOT` set to the current directory. Contains the file templates used during scaffolding.
- **`server/src/index.ts`** — Express server. Discovers workspaces and repositories, exposes REST endpoints (`/api/workspaces`, `/prompt`, `/models`, `/reasoning`, `/overview`, `/repos`, `/permissions`), streams prompt responses as ndJSON, and handles attachment uploads.
- **`server/src/WorkspaceAgent.ts`** — Encapsulates one Copilot session. Spawns the agent's `start` script, speaks ACP over the ndJSON stream, and manages model/reasoning config, tool activity, permission requests, and session reset. One instance per workspace, cached in a `Map`.
- **`web/`** — The React UI that talks to the backend API.
- **`templates/shared/`** — Source for assets installed into a user's `.agent-kitty/shared/` directory. These are templates shipped with the package, not runtime config.

## Runtime Workspace Layout (user side)

Agent Kitty operates on a workspace root (`COPILOT_ROOT`) the user runs it from. It is separate from this source repo:

```text
agent-workspaces/
├── .agent-kitty/              # Agent Kitty's own config + installed shared assets
│   ├── config.json
│   └── shared/{mcp.json, bin/, tools/}
├── netsuite-apps/             # An agent (AGENTS.md + start + mcp.json + repos)
├── customer-platform/         # Another agent
└── portal-apps/
```

A child folder becomes an agent only if it contains both `AGENTS.md` and `start`. The folders `.agent-kitty`, `shared`, `.git`, and `node_modules` are ignored during discovery.

## Conventions

- Separate TypeScript projects for server and web, each with its own build step and dependencies.
- Server source lives under `server/src`, compiles to `server/dist`; never edit `dist` by hand.
- Shared MCP templates live under `templates/shared/`; changes here affect what new installs receive.
- Keep CLI scaffolding non-destructive — existing user files must never be overwritten.

---

# Agent Manager (`agent-manager/`)

Standard Laravel application layout. The project-specific code lives under `app/`, `resources/agents/`, and `routes/`.

## Key Directories

```text
agent-manager/
├── app/
│   ├── Console/Commands/
│   │   └── PublishAgentCommand.php     # `agent:publish` command
│   ├── Filament/
│   │   ├── Resources/{Agents,AgentVersions}/   # admin CRUD panels
│   │   └── Widgets/                     # dashboard widgets
│   ├── Http/
│   │   ├── Controllers/Api/V1/          # agent list + bundle download endpoints
│   │   └── Resources/AgentResource.php  # API transformer
│   ├── Models/
│   │   ├── Agent.php                    # agent definition (slug-keyed)
│   │   ├── AgentVersion.php             # versioned content: markdown + JSON configs
│   │   └── User.php
│   ├── Providers/Filament/AdminPanelProvider.php
│   └── Services/
│       ├── Agents/                      # AgentPublisher, AgentScaffoldBuilder (+ Exceptions)
│       └── AgentBundles/                # AgentBundleBuilder (Kiro), CopilotBundleBuilder
├── resources/
│   ├── agents/                          # source agent definitions published via CLI
│   ├── agent-bundle/                    # refresh-context.sh template packaged into bundles
│   ├── css/, js/, views/
├── routes/{api.php, web.php, console.php}
├── database/{migrations,factories,seeders}, database.sqlite
├── config/, bootstrap/, public/, storage/, tests/
├── composer.json, package.json, vite.config.js, phpunit.xml, artisan
```

## Module Responsibilities

- **`app/Models`** — `Agent` and `AgentVersion` Eloquent models. `AgentVersion` casts `kiro_config` and `repository_manifest` to arrays and auto-manages `published_at` on save.
- **`app/Services/Agents/AgentPublisher`** — reads a bundle directory under `resources/agents/{slug}` and upserts the agent + published version inside a DB transaction.
- **`app/Services/Agents/AgentScaffoldBuilder`** — generates `AGENTS.md`, `MANAGED_CONTEXT.md`, the Kiro config array, and the repository manifest for a new agent.
- **`app/Services/AgentBundles`** — `AgentBundleBuilder` builds Kiro-format ZIPs; `CopilotBundleBuilder` extends that with a generated `.github/copilot-instructions.md`.
- **`app/Filament`** — admin UI resources and dashboard widgets.
- **`app/Http/Controllers/Api/V1`** — the public JSON API that lists agents and streams bundle downloads.

## Conventions

- Business logic belongs in `app/Services`; controllers and the Filament layer stay thin.
- Agent content artifacts (`AGENTS.md`, `MANAGED_CONTEXT.md`, `.kiro/agents/<slug>.json`, `repository-manifest.json`) are the contract between Agent Manager and Agent Kitty — keep their shape consistent across both repos.
- Do not commit `.env`, generated bundles under `storage/app/tmp`, or the SQLite database content.
