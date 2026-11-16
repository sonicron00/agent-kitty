# Tech Stack

This workspace spans two repositories with different stacks:

- **agent-kitty** — Node.js + TypeScript (Express backend, React/Vite frontend, Node CLI).
- **agent-manager** — PHP + Laravel + Filament, with a Vite/Tailwind asset pipeline.

---

# Agent Kitty (`agent-kitty/`)

## Runtime & Language

- Node.js 22 or newer, ES modules (`"type": "module"` throughout)
- TypeScript across both server and web
- zsh is the expected shell (the generated `start` script uses `#!/bin/zsh`)

## Backend (`server/`)

- Express 5 HTTP server (default port `8787`, override with `PORT`)
- `@agentclientprotocol/sdk` — Agent Client Protocol used to drive the GitHub Copilot CLI
- `ws` for WebSocket support
- `multer` for file-attachment uploads (memory storage, 5 MB / 5 files, text extensions only)
- Communicates with Copilot over an ACP ndJSON stream via a spawned child process per workspace
- `COPILOT_ROOT` env var sets the workspace root the backend scans (set by the CLI `start` command)

## Frontend (`web/`)

- React 19 + Vite 8
- `react-markdown` + `remark-gfm` + `rehype-highlight` + `highlight.js` for rendering agent output
- ESLint 10 with `typescript-eslint` and React Hooks plugins
- Built output served by the backend from `web/dist`

## CLI (`bin/agent-kitty.mjs`)

- Plain Node ESM script (no framework), exposed as the `agent-kitty` bin
- Commands: `init`, `start`, `doctor`, `add-agent`, plus `--help` / `--version`
- `init`/`add-agent` scaffold agent folders and copy shared MCP templates without overwriting existing files

## Build Configuration

- Server: `tsconfig.server.json` — target ES2022, module/resolution NodeNext, `strict: true`, `noEmitOnError: true`, compiles `server/src` → `server/dist`
- Web: `tsc -b && vite build`

## Common Commands

Run from the repo root unless noted.

```bash
# Install
npm install
npm --prefix web install

# Development (runs server + web concurrently)
npm run dev
npm run dev:server    # tsx watch server only
npm run dev:web       # vite web only

# Build
npm run build         # builds web then server
npm run build:web
npm run build:server

# Run compiled app
npm start             # node server/dist/index.js

# Lint web
npm --prefix web run lint

# Local CLI development
npm link              # makes `agent-kitty` available globally

# Diagnose a user's environment / setup
agent-kitty doctor
```

## Conventions

- Prefer `node:` prefixed imports for built-in modules (`node:fs/promises`, `node:path`, etc.).
- Keep server code strict and side-effect-aware; the ACP connection and session state live in `WorkspaceAgent`.
- Do not run long-lived commands (`npm run dev`, `vite`, watchers) in automation; run them manually.

---

# Agent Manager (`agent-manager/`)

## Runtime & Language

- PHP 8.3+
- Laravel 13.x framework
- Node ES modules only for the frontend asset build

## Key Packages

- `filament/filament` 5.x — admin panel (resources, widgets) under `app/Filament`
- `laravel/sanctum` — API authentication
- `laravel/tinker`, `laravel/pail` (log tailing), `laravel/pint` (code style)
- Testing: PHPUnit 12.x, Mockery, `nunomaduro/collision`, FakerPHP

## Frontend / Assets

- Vite 8 with `laravel-vite-plugin` and `@tailwindcss/vite` (Tailwind 4)
- Entry points: `resources/css/app.css`, `resources/js/app.js`
- Bunny-hosted "Instrument Sans" font configured via the Vite plugin

## Data & Storage

- Default database is SQLite (`database/database.sqlite`)
- Eloquent models cast JSON fields (`kiro_config`, `repository_manifest`) to arrays
- Bundle ZIPs are built with PHP `ZipArchive` into `storage/app/tmp/agent-bundles`

## Common Commands

Run from `agent-manager/`.

```bash
# First-time setup (install, env, key, migrate, build assets)
composer run setup

# Local development (serve + queue + logs + vite, concurrently)
composer run dev

# Tests
composer run test          # clears config then runs artisan test
php artisan test

# Code style (Laravel Pint)
./vendor/bin/pint

# Publish an agent from resources/agents/{slug} into the DB
php artisan agent:publish {slug}
php artisan agent:publish {slug} --force

# Asset build
npm run build
npm run dev
```

## Conventions

- Follow Laravel + Filament conventions; keep business logic in `app/Services`, not controllers.
- Models use the array-based `casts()` method and route-model binding by `slug` where applicable.
- Service classes throw `RuntimeException` (or domain exceptions under `Services/Agents/Exceptions`) with clear messages on invalid input; preserve this pattern.
- Format PHP with Pint before finishing changes.
- Do not run long-lived commands (`composer run dev`, `php artisan serve`, `vite`) in automation; run them manually.
