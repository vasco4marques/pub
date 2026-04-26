# itlingo-itoi (Theia Extension)

A custom [Theia](https://theia-ide.org/) extension that provides:

- **Workspace management** — A widget UI for creating, opening, and managing ITLingo workspaces.
- **Git operations** — Clone, pull, and push commands integrated into the Theia command palette and SCM menu.
- **File synchronization** — Watches the workspace for file changes (create, modify, delete) and syncs them with a PostgreSQL database backend.
- **Backend API** — An Express-based backend that serves workspace data and handles database operations.

## Architecture

- `src/browser/` — Frontend contributions (widget, commands, menu items)
- `src/node/` — Backend contributions (Express API, file watcher, DB sync)
- `src/common/` — Shared interfaces

## Dependencies

- `@theia/core` — Theia framework
- `sprotty` / `sprotty-protocol` — Diagram support
- `pg` — PostgreSQL client
- `nsfw` — Native filesystem watcher
- `uuid` — Unique ID generation

## Configuration

The extension reads the `CONSTRING` environment variable for PostgreSQL connectivity. Without it, the IDE will start but file synchronization and workspace persistence features will not function.
