# itlingo-itoi

A Theia-based browser IDE with custom language support for RSL and ASL (ITLingo), built as a monorepo with two packages:

- **itlingo-itoi** — A Theia extension providing workspace management, git operations (clone/pull/push), file synchronization with a PostgreSQL backend, and a custom widget UI.
- **browser-app** — The Theia browser shell that bundles all extensions and plugins.

Language support for RSL and ASL is provided via VS Code extension plugins (`.vsix`), built from separate Langium-based repositories.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 20 (tested with v20.19.x)
- [Yarn](https://classic.yarnpkg.com/) 1.x
- Python 3 with `setuptools` installed (needed by `node-gyp` for native modules)
- [@vscode/vsce](https://github.com/microsoft/vscode-vsce) installed globally (for building `.vsix` plugins)

## Project Structure

```
pub/
├── browser-app/        # Theia browser application (entry point)
├── itlingo-itoi/       # Custom Theia extension (workspace, git, DB sync)
├── plugins/            # VS Code extension plugins (.vsix, unpacked)
├── package.json        # Root workspace config
└── lerna.json
```

## Setup and Running

### 1. Build the RSL and ASL language extensions

Clone and build each extension to produce `.vsix` packages:

```bash
git clone https://github.com/genlike/rsl-vscode-extension.git
cd rsl-vscode-extension
yarn install
vsce package --allow-missing-repository
cd ..

git clone https://github.com/genlike/asl-vscode-extension.git
cd asl-vscode-extension
yarn install
vsce package --allow-missing-repository
cd ..
```

> **Note:** If `vsce` complains about both `.vscodeignore` and `"files"` in `package.json`, delete the `.vscodeignore` file and retry.

### 2. Install the plugins

Create the `plugins/` directory and unpack the `.vsix` files:

```bash
mkdir -p plugins

mkdir -p plugins/rsl-vscode-extension
unzip rsl-vscode-extension/rsl-vscode-extension-*.vsix -d plugins/rsl-vscode-extension

mkdir -p plugins/asl-vscode-extension
unzip asl-vscode-extension/asl-vscode-extension-*.vsix -d plugins/asl-vscode-extension
```

### 3. Install dependencies and build

From the `pub/` root:

```bash
yarn install
cd browser-app
yarn theia build
```

> **Note:** The `@theia/*` dependencies in `browser-app/package.json` and `itlingo-itoi/package.json` should be pinned to a consistent version (e.g., `1.60.2`) to avoid version mismatches. The `@theia/git` package was deprecated at `1.60.2`, so all other Theia packages must match that version.

### 4. Start the IDE

```bash
cd browser-app
yarn theia start --hostname 0.0.0.0 --port 3000 --plugins=local-dir:../plugins
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Development

Watch the custom extension for changes:

```bash
cd itlingo-itoi
yarn watch
```

In a separate terminal, watch and rebuild the browser app:

```bash
cd browser-app
yarn watch
```

## Environment Variables

- **CONSTRING** — PostgreSQL connection string for the backend file synchronization feature. If not set, the IDE will start but database-related features will be unavailable.

## Docker (Legacy)

The `itlingo-itoi` repository contains a Dockerfile for containerized deployment. **The Dockerfile is currently outdated** — it references Xtext-based artifacts (`server/mydsl/bin/`, JAR files, `start-ls-itlingo` scripts) that no longer exist since the language extensions migrated to Langium. The Dockerfile needs to be updated to reflect the Langium-based build process described above.
