/**
 * Loads `.env` for the ITLingo backend.
 *
 * `DATABASE_URL` lives in `pub/.env` (next to `browser-app/`). Three Gotchas:
 *
 * 1. **Webpack backend bundle** — `itoi-env` is bundled into `browser-app/lib/backend/main.js`.
 *    There, `__dirname` is `.../browser-app/lib/backend`, not `.../itlingo-itoi/lib/node`, so
 *    resolving `pub/.env` via `__dirname/../../..` points at the wrong file (or nothing).
 * 2. **Theia sets `THEIA_APP_PROJECT_PATH`** to the `browser-app/` folder before extensions run.
 *    `path.join(THEIA_APP_PROJECT_PATH, '..', '.env')` is always `pub/.env` for this app.
 * 3. **`process.cwd()`** alone is unreliable (IDE tasks, repo root, etc.).
 *
 * Load order: optional cwd-based files first (override false), then THEIA + package-relative
 * paths with override true so `pub/.env` wins.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Yarn workspaces hoist dependencies to pub/node_modules — require avoids subpackage resolve issues */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dotenv = require('dotenv') as {
    config: (options?: { path?: string; override?: boolean }) => { error?: Error };
};

let dotenvLoaded = false;

/** When running from compiled `itlingo-itoi/lib/node/*.js` (not webpack), `__dirname` → `pub/.env`. */
function pubEnvFromPackage(): string {
    return path.resolve(__dirname, '..', '..', '..', '.env');
}

function tryLoadEnv(filePath: string, override: boolean): void {
    if (!fs.existsSync(filePath)) {
        return;
    }
    dotenv.config({ path: filePath, override });
}

export function loadItoiEnvFiles(): void {
    if (dotenvLoaded) {
        return;
    }
    dotenvLoaded = true;

    tryLoadEnv(path.resolve(process.cwd(), 'pub', '.env'), false);
    tryLoadEnv(path.resolve(process.cwd(), '..', '.env'), false);
    tryLoadEnv(path.resolve(process.cwd(), '.env'), false);

    const appPath = process.env.THEIA_APP_PROJECT_PATH;
    if (appPath) {
        tryLoadEnv(path.resolve(appPath, '..', '.env'), true);
    }
    tryLoadEnv(pubEnvFromPackage(), true);
}

function normalizeDir(value: string | undefined, fallback: string): string {
    const d = (value ?? fallback).trim();
    return d.endsWith('/') ? d : `${d}/`;
}

function normalizeUrl(value: string | undefined, fallback: string): string {
    const u = (value ?? fallback).trim();
    return u.endsWith('/') ? u : `${u}/`;
}

/** Legacy default AES key — override with ITOI_WORKSPACE_TOKEN_KEY in production */
const LEGACY_WORKSPACE_TOKEN_KEY = 'v8y/B?E(H+MbQeThWmZq4t7w!z$C&F)J';

export interface ItoiEnv {
    hostFs: string;
    hostRoot: string;
    itlingoCloudUrl: string;
    workspaceTokenKey: string;
    staticFolderLength: number;
}

export function getItoiEnv(): ItoiEnv {
    loadItoiEnvFiles();
    const hostFs = normalizeDir(process.env.ITOI_HOST_FS, '/tmp/theia/workspaces/');
    const hostRoot = normalizeDir(process.env.ITOI_HOST_ROOT, '/home/theia/pub/');
    const itlingoCloudUrl = normalizeUrl(process.env.ITLINGO_CLOUD_URL, 'http://localhost:8000/');
    const workspaceTokenKey = process.env.ITOI_WORKSPACE_TOKEN_KEY ?? LEGACY_WORKSPACE_TOKEN_KEY;
    const staticFolderLength = (hostFs + 'tmp/').length + 36 + '/Workspace-'.length;
    return { hostFs, hostRoot, itlingoCloudUrl, workspaceTokenKey, staticFolderLength };
}
