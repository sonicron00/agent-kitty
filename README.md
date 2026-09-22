# Agent Kitty 🐱

Agent Kitty is a local browser interface for running coding agents across groups of related repositories.

The current release uses the GitHub Copilot CLI as its agent runtime.

Instead of opening one repository at a time, Agent Kitty lets you create an **agent workspace** containing several repositories that belong together. Each agent gets its own instructions, MCP configuration, Copilot session, model selection, reasoning setting, conversation history, and tool activity.

---

## What Agent Kitty Does

Agent Kitty gives you:

- A browser UI for GitHub Copilot coding agents
- Multiple independent agents in one interface
- Support for grouping related repositories together
- Streaming responses
- Tool activity visibility
- Markdown and syntax-highlighted code
- File attachments
- Model selection
- Reasoning-level selection
- Per-agent conversation history
- Shared MCP servers
- Workspace-specific MCP servers
- Repository and branch visibility
- `AGENTS.md` instructions per workspace

Each agent runs independently, so one agent can be working while you use another.

---

## The Important Concept: What Is an Agent?

An Agent Kitty **agent is not necessarily one repository**.

An agent is a folder containing:

- an `AGENTS.md` file
- an `mcp.json` file
- a `start` script
- one or more repositories that belong together

For example:

```text
netsuite-apps/
├── AGENTS.md
├── mcp.json
├── start
│
├── netsuite-sdf/
├── ns-customer-micro/
├── ns-employee-micro/
├── ns-supplier-micro/
└── billing-nextgen/
```

In Agent Kitty, this entire folder appears as one agent:

```text
NetSuite Apps
```

The agent can inspect and work across all of the repositories inside it.

---

## How Should I Group Repositories?

A good agent workspace represents a **piece of engineering context**, rather than simply a single Git repository.

Repositories should usually be grouped together when the same engineer or task frequently needs to understand or modify several of them together.

For example, imagine you have:

```text
customer-api
customer-events
customer-worker
customer-schema
```

If these repositories form one logical customer platform and changes regularly cross repository boundaries, they are good candidates for one agent:

```text
customer-platform/
├── AGENTS.md
├── mcp.json
├── start
│
├── customer-api/
├── customer-events/
├── customer-worker/
└── customer-schema/
```

This allows the agent to understand the whole system rather than treating each repository in isolation.

### Good reasons to group repositories

Group repositories when they:

- belong to the same product or technical domain
- are frequently changed together
- share architecture or coding conventions
- form parts of the same request or event flow
- depend directly on one another
- need the same MCP integrations
- need the same engineering instructions

For example:

```text
tmf-apps/
├── AGENTS.md
├── mcp.json
├── start
├── product-order-api/
├── product-order-worker/
├── inventory-api/
└── tmf-models/
```

Another example might be:

```text
integration-platform/
├── AGENTS.md
├── mcp.json
├── start
├── camunda-processes/
├── kafka-connectors/
├── servicenow-integration/
└── shared-event-models/
```

### When repositories should be separate agents

Do not group repositories simply because they happen to be owned by the same team.

Separate them when they:

- have little relationship to each other
- require very different engineering instructions
- use unrelated MCP integrations
- belong to different systems or business domains
- have different security or access requirements
- would create an unnecessarily large amount of context

For example, this would probably be too broad:

```text
all-company-code/
├── payroll-system/
├── mobile-app/
├── data-platform/
├── netsuite/
├── customer-portal/
└── website/
```

Instead, create several focused agents:

```text
agents/
├── netsuite-apps/
├── customer-platform/
├── data-platform/
└── portal-apps/
```

A useful rule is:

> If you would naturally want the agent to understand these repositories together while solving a task, they probably belong in the same agent.

---

## Recommended Directory Structure

Create a root directory that will contain all of your Agent Kitty agents.

For example:

```text
~/agent-workspaces/
```

After setup it may look like:

```text
agent-workspaces/
│
├── .agent-kitty/
│   ├── config.json
│   │
│   └── shared/
│       ├── mcp.json
│       ├── bin/
│       │   ├── atlassian-mcp
│       │   └── lenses-mcp
│       │
│       └── tools/
│           └── lenses-mcp/
│
├── netsuite-apps/
│   ├── AGENTS.md
│   ├── mcp.json
│   ├── start
│   ├── netsuite-sdf/
│   ├── ns-customer-micro/
│   └── ns-supplier-micro/
│
├── portal-apps/
│   ├── AGENTS.md
│   ├── mcp.json
│   ├── start
│   ├── customer-portal/
│   └── portal-api/
│
└── integration-apps/
    ├── AGENTS.md
    ├── mcp.json
    ├── start
    ├── kafka-connectors/
    └── camunda-processes/
```

The `.agent-kitty` directory belongs to Agent Kitty itself.

Your actual agents are the folders alongside it.

---

## Prerequisites

Agent Kitty currently expects:

- Node.js 22 or newer
- Git
- zsh
- GitHub Copilot CLI
- GitHub Copilot CLI authentication
- `npx`
- `uv` if using the bundled Lenses MCP

You can check your machine with:

```bash
agent-kitty doctor
```

Example:

```text
Agent Kitty Doctor 🐱

Prerequisites

✓ Node 22.23.2
✓ GitHub Copilot CLI
✓ Git
✓ zsh
✓ npx
✓ uv

Agent Kitty setup

✓ .agent-kitty
✓ Agent Kitty config
✓ Shared MCP config
✓ Atlassian MCP wrapper
✓ Lenses MCP wrapper
✓ Lenses MCP project
```

---

## Installation

Install Agent Kitty globally from the internal Agent Kitty package or repository:

```bash
npm install -g <INTERNAL_AGENT_KITTY_PACKAGE_OR_GIT_URL>
```

Once installed:

```bash
agent-kitty --version
```

should display the installed version.

For development from the Agent Kitty source repository:

```bash
npm install
npm run build
npm link
```

This makes the local development copy available as:

```bash
agent-kitty
```

---

## Quick Start

Create a directory to hold your agents:

```bash
mkdir ~/agent-workspaces
cd ~/agent-workspaces
```

If you already have folders containing repositories, you can use those instead.

Run:

```bash
agent-kitty init
```

Agent Kitty scans the immediate child folders and asks which ones should become agents.

For example:

```text
Found 3 candidate folders.

Set up netsuite-apps as an agent? [Y/n]
Set up portal-apps as an agent? [Y/n]
Set up old-test-project as an agent? [Y/n]
```

For each selected folder Agent Kitty creates, if they do not already exist:

```text
AGENTS.md
mcp.json
start
```

Existing files are never overwritten.

Once setup is complete:

```bash
agent-kitty start
```

Then open:

```text
http://localhost:8787
```

---

## Creating a New Agent

You can either create an agent during:

```bash
agent-kitty init
```

or add one later.

For example:

```bash
cd ~/agent-workspaces
agent-kitty add-agent customer-platform
```

This creates:

```text
customer-platform/
├── AGENTS.md
├── mcp.json
└── start
```

You can then clone repositories into it:

```bash
cd customer-platform

git clone <customer-api-repository>
git clone <customer-events-repository>
git clone <customer-worker-repository>
```

Your agent might then look like:

```text
customer-platform/
├── AGENTS.md
├── mcp.json
├── start
├── customer-api/
├── customer-events/
└── customer-worker/
```

Restart or refresh Agent Kitty and the workspace will appear in the sidebar.

---

## Existing Repositories

You do not need to create new repositories or move code into Agent Kitty itself.

If you already have:

```text
~/development/
├── customer-api/
├── customer-worker/
└── customer-events/
```

and want all three repositories to form one agent, the recommended structure is:

```text
~/agent-workspaces/
└── customer-platform/
    ├── AGENTS.md
    ├── mcp.json
    ├── start
    ├── customer-api/
    ├── customer-worker/
    └── customer-events/
```

Clone or move the repositories into the agent folder as appropriate for your normal development workflow.

Agent Kitty does not modify the Git repositories themselves.

---

## AGENTS.md

`AGENTS.md` is the most important configuration file for an agent.

It tells the coding agent what the workspace contains and how it should work.

Agent Kitty displays this file in the **Overview** tab and Copilot loads it as workspace context.

A newly generated file starts with:

```markdown
# Agent Instructions

## Purpose

Describe what this workspace contains and what the agent is responsible for.

## Repositories

Document the repositories in this workspace and their roles.

## Development Guidelines

Add any build, test, coding, deployment, or architectural rules the agent must follow.

## Important Constraints

Add anything the agent must not do without explicit approval.
```

You should customise this for the workspace.

---

## Writing a Useful AGENTS.md

A good `AGENTS.md` should give the agent information that would otherwise require repeated investigation.

For example:

```markdown
# Customer Platform

## Purpose

This workspace contains the services responsible for customer creation,
updates, synchronisation and event publication.

## Repositories

### customer-api

REST API responsible for customer CRUD operations.

Stack:

- Laravel
- PHP 8.3
- MySQL
- Redis

### customer-events

Kafka event producer and schema definitions used by customer services.

### customer-worker

Background processing service consuming customer events.

## Architecture

Requests normally flow:

customer-api
→ Kafka
→ customer-worker
→ downstream systems

## Development Guidelines

- Follow the existing service/repository architecture.
- Do not introduce a new dependency without checking existing equivalents.
- Run tests before completing code changes.
- Preserve existing API contracts unless explicitly asked to change them.

## Important Constraints

- Never deploy automatically.
- Never modify production credentials.
- Do not commit generated secrets or local environment files.
```

This is much more useful than simply telling the agent:

```text
This is the customer project.
```

---

## Repository-Specific AGENTS.md Files

Individual repositories may also contain their own `AGENTS.md`.

For example:

```text
customer-platform/
├── AGENTS.md
│
├── customer-api/
│   └── AGENTS.md
│
└── customer-worker/
    └── AGENTS.md
```

The workspace-level file should describe the **overall system**.

Repository-level files can contain more specific instructions such as:

- framework conventions
- build commands
- test commands
- directory structure
- deployment restrictions
- coding standards

This lets you keep broad architecture at workspace level and detailed implementation guidance near the relevant repository.

---

## Code Base Tab

Agent Kitty automatically detects Git repositories directly inside an agent workspace.

The **Code Base** tab shows:

- repository name
- local path
- current Git branch
- whether the repository contains its own `AGENTS.md`

Non-default branches are highlighted so it is easier to notice when a repository is not on the expected branch.

---

## MCP Servers

Agent Kitty supports two levels of MCP configuration:

1. Shared MCP servers
2. Workspace-specific MCP servers

---

## Shared MCP Servers

Shared MCPs are available to every Agent Kitty agent.

They live under:

```text
.agent-kitty/shared/
```

The current release includes:

- Atlassian
- Lenses

The shared configuration is:

```text
.agent-kitty/shared/mcp.json
```

You normally do not need to edit this file.

---

## Atlassian MCP

The bundled Atlassian MCP connects to:

```text
https://mcp.atlassian.com/v2/mcp
```

Authentication is handled through the Atlassian OAuth flow.

Credentials are not bundled with Agent Kitty.

The first connection may open or require browser authentication.

---

## Lenses MCP

The Lenses MCP is installed under:

```text
.agent-kitty/shared/tools/lenses-mcp/
```

Agent Kitty does not ship Lenses credentials.

The project contains:

```text
.env.example
```

Create your local environment file:

```bash
cd .agent-kitty/shared/tools/lenses-mcp
cp .env.example .env
```

Then populate the required values according to your organisation's Lenses environment.

The `.env` file should remain local and must not be committed.

Check configuration with:

```bash
agent-kitty doctor
```

Before configuration you may see:

```text
⚠ Lenses local environment  .env not configured
```

Once configured:

```text
✓ Lenses local environment
```

---

## Workspace-Specific MCP Servers

If an MCP should only be available to one agent, configure it in that agent's:

```text
mcp.json
```

A newly generated workspace contains:

```json
{
  "mcpServers": {}
}
```

For example:

```json
{
  "mcpServers": {
    "my-system": {
      "type": "stdio",
      "command": "./bin/my-system-mcp",
      "args": [],
      "tools": ["*"]
    }
  }
}
```

A typical workspace might then contain:

```text
my-agent/
├── AGENTS.md
├── mcp.json
├── start
│
├── bin/
│   └── my-system-mcp
│
└── repositories...
```

Keep credentials out of `mcp.json` wherever possible.

Prefer environment variables, local `.env` files, OAuth flows, or another approved secrets mechanism.

---

## Why Shared vs Workspace MCPs?

Use a **shared MCP** when almost every agent should have access to the same integration.

Examples:

```text
Atlassian
Lenses
```

Use a **workspace MCP** when the integration belongs to one particular platform or application.

Examples might include:

```text
NetSuite
ServiceNow
a platform-specific database MCP
a development environment specific to one product
```

This keeps each agent focused and avoids loading unnecessary tools into every session.

---

## The `start` Script

Each agent contains an executable:

```text
start
```

Agent Kitty generates it automatically.

It launches Copilot from that workspace and supplies both:

```text
.agent-kitty/shared/mcp.json
```

and:

```text
<agent>/mcp.json
```

Conceptually:

```text
Shared MCPs
     +
Workspace MCPs
     ↓
GitHub Copilot CLI
     ↓
Agent Kitty
```

You generally should not need to edit the `start` script.

---

## Starting Agent Kitty

Always start Agent Kitty from the directory containing your agent folders.

For example:

```bash
cd ~/agent-workspaces
agent-kitty start
```

The current directory becomes the Agent Kitty workspace root.

Agent Kitty will then discover valid agent folders directly beneath it.

Open:

```text
http://localhost:8787
```

---

## How Agent Discovery Works

Agent Kitty scans immediate child directories of the current workspace root.

A folder is treated as an agent when it contains at least:

```text
AGENTS.md
start
```

For example:

```text
agent-workspaces/
├── .agent-kitty/
├── customer-platform/
├── netsuite-apps/
└── portal-apps/
```

Agent Kitty does not recursively turn every Git repository into a separate agent.

That is intentional.

The folder structure determines the engineering context you want the agent to have.

---

## Agent Kitty Doctor

Run:

```bash
agent-kitty doctor
```

to diagnose the local setup.

It checks:

```text
Node
GitHub Copilot CLI
Git
zsh
npx
uv
Agent Kitty configuration
shared MCP configuration
MCP wrappers
Lenses MCP installation
Lenses local environment
configured agents
```

This should be the first command to run if Agent Kitty is not behaving as expected.

---

## Useful Commands

```bash
agent-kitty --help
```

Show CLI help.

```bash
agent-kitty --version
```

Show the installed Agent Kitty version.

```bash
agent-kitty init
```

Initialise the current directory and optionally turn existing child folders into agents.

```bash
agent-kitty add-agent <folder>
```

Create or initialise a new agent folder.

```bash
agent-kitty doctor
```

Check prerequisites and workspace configuration.

```bash
agent-kitty start
```

Start Agent Kitty using the current directory as the workspace root.

---

## File Safety

Agent Kitty's setup commands are intentionally conservative.

`agent-kitty init` and `agent-kitty add-agent` do not overwrite existing:

```text
AGENTS.md
mcp.json
start
```

Shared template files are also only copied when they do not already exist.

This allows Agent Kitty setup commands to be rerun safely.

---

## Credentials and Security

Do not store credentials in:

```text
AGENTS.md
mcp.json
the Agent Kitty repository
```

Agent Kitty does not require application credentials itself.

MCP integrations should use appropriate authentication such as:

- OAuth
- environment variables
- ignored `.env` files
- approved organisational secret stores

The bundled Lenses MCP deliberately excludes its `.env` file from distribution.

---

## Suggested Workflow

For a new engineering area, a good workflow is:

```bash
cd ~/agent-workspaces

agent-kitty add-agent customer-platform

cd customer-platform

git clone <customer-api>
git clone <customer-worker>
git clone <customer-events>
```

Then update:

```text
AGENTS.md
```

with the architecture and repository responsibilities.

Add any workspace-specific MCPs to:

```text
mcp.json
```

Then:

```bash
cd ..

agent-kitty doctor
agent-kitty start
```

You now have a dedicated Customer Platform coding agent with access to the related repositories and tools.

---

## Choosing the Right Workspace Size

There is no fixed number of repositories that should belong to one agent.

An agent with one repository is completely valid.

An agent with ten closely related repositories may also be valid.

The important question is:

> Does giving the agent all of these repositories at the same time help it understand and complete the work?

If yes, keep them together.

If the repositories represent unrelated systems, split them into separate agents.

Start smaller if unsure. It is easy to reorganise later.

---

## Current Runtime

Agent Kitty currently uses:

```text
GitHub Copilot CLI
```

through the Agent Client Protocol.

Support for additional coding-agent runtimes may be added in future versions.

The workspace structure has deliberately been designed so that agents, repositories, instructions and MCP configuration are not tied conceptually to a single model provider.

---

## Troubleshooting

### Agent does not appear in the sidebar

Check that the folder contains:

```text
AGENTS.md
start
```

Then run:

```bash
agent-kitty doctor
```

### MCP server is not available

Check:

```text
.agent-kitty/shared/mcp.json
```

for shared servers, or:

```text
<agent>/mcp.json
```

for workspace-specific servers.

Then open the MCPs tab in Agent Kitty.

### Lenses shows as unavailable

Check:

```bash
uv --version
```

and configure:

```text
.agent-kitty/shared/tools/lenses-mcp/.env
```

Then run:

```bash
agent-kitty doctor
```

### Atlassian requires authentication

The Atlassian MCP uses OAuth.

Complete the browser authentication flow when requested.

### Copilot does not start

Check:

```bash
copilot --version
```

and ensure the GitHub Copilot CLI is installed and authenticated.

Then run:

```bash
agent-kitty doctor
```

---

## Development

From the Agent Kitty source repository:

```bash
npm install
npm --prefix web install
```

Run development mode:

```bash
npm run dev
```

Build the distributable application:

```bash
npm run build
```

Run the compiled application:

```bash
npm start
```

For local CLI development:

```bash
npm link
```

You can then test from another folder:

```bash
cd /tmp/my-agent-workspace

agent-kitty init
agent-kitty doctor
agent-kitty start
```

---

## Architecture

At a high level:

```text
Browser
   ↓
Agent Kitty React UI
   ↓
Agent Kitty Node backend
   ↓
Agent Client Protocol
   ↓
GitHub Copilot CLI
   ↓
Repositories + AGENTS.md + MCP servers
```

Each Agent Kitty workspace has an independent Copilot process/session.

This allows multiple agents to work independently from the same browser interface.

---

## Version

Current release:

```text
Agent Kitty 1.0.0
```
