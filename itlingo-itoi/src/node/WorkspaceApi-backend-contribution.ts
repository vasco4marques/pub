import { injectable } from 'inversify';
import { getItoiEnv } from './itoi-env';
import * as express from 'express';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import axios from 'axios';
import * as fs from 'fs';
import * as nsfw from 'nsfw';
import path = require('path');
import * as uuid from 'uuid';
import { format as utilFormat } from 'util';
const { Pool } = require('pg');
const getDirName = require('path').dirname;
const crypto = require('crypto');

const requestIp = require('request-ip');

const currentEditors: { [ip: string]: Editor } = {};
const workspaces: Map<string, string[]> = new Map<string, string[]>();

type Editor = {
    foldername: string;
    write: boolean;
    time: number;
    workspaceid: number;
};

/** Prefixed logging for backend subsystems (first arg supports util.format %s, %d, etc.) */
function logDb(msg: string, ...args: unknown[]): void {
    console.log('[ITOI:DB]', args.length ? utilFormat(msg, ...args) : msg);
}
function logWorkspace(msg: string, ...args: unknown[]): void {
    console.log('[ITOI:WORKSPACE]', args.length ? utilFormat(msg, ...args) : msg);
}
function logFiles(msg: string, ...args: unknown[]): void {
    console.log('[ITOI:FILES]', args.length ? utilFormat(msg, ...args) : msg);
}
function logWatcher(msg: string, ...args: unknown[]): void {
    console.log('[ITOI:WATCHER]', args.length ? utilFormat(msg, ...args) : msg);
}
function logHttp(msg: string, ...args: unknown[]): void {
    console.log('[ITOI:HTTP]', args.length ? utilFormat(msg, ...args) : msg);
}
function logSetup(msg: string, ...args: unknown[]): void {
    console.log('[ITOI:SETUP]', args.length ? utilFormat(msg, ...args) : msg);
}
function logErr(prefix: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error(`[ITOI:${prefix}] ERROR`, msg, stack ?? '');
}

function maskDatabaseUrl(url: string | undefined): string {
    if (!url) {
        return '(missing — set DATABASE_URL)';
    }
    try {
        const u = new URL(url);
        if (u.password) {
            u.password = '***';
        }
        return u.toString();
    } catch {
        return '(could not parse connection string)';
    }
}

function eventFilePath(event: nsfw.FileChangeEvent): string {
    const file = (event as nsfw.CreatedFileEvent | nsfw.ModifiedFileEvent | nsfw.DeletedFileEvent).file;
    return event.directory + '/' + file;
}

function renamedEventDescription(event: nsfw.RenamedFileEvent): string {
    return `${event.directory}/${event.oldFile} -> ${event.newDirectory}/${event.newFile}`;
}

@injectable()
export class SwitchWSBackendContribution implements BackendApplicationContribution {
    configure(app: express.Application): void {
        const { hostFs, hostRoot, itlingoCloudUrl, workspaceTokenKey, staticFolderLength } = getItoiEnv();

        logWorkspace('Env: ITLINGO_CLOUD_URL=%s', itlingoCloudUrl);
        logWorkspace(
            'Env: ITOI_WORKSPACE_TOKEN_KEY=%s',
            process.env.ITOI_WORKSPACE_TOKEN_KEY ? '(set)' : '(default legacy dev key — set ITOI_WORKSPACE_TOKEN_KEY in production)'
        );
        logWorkspace('Paths: hostFs=%s exists=%s', hostFs, fs.existsSync(hostFs));
        logWorkspace('Paths: hostRoot=%s exists=%s', hostRoot, fs.existsSync(hostRoot));

        const connectionString = process.env.DATABASE_URL;
        const sslEnabled = process.env.ITOI_PROD === 'PROD';
        logDb(
            'Config: DATABASE_URL=%s ssl=%s ITOI_PROD=%s',
            maskDatabaseUrl(connectionString),
            sslEnabled,
            process.env.ITOI_PROD ?? '(unset)'
        );

        let pgPoolOptions: object = {
            connectionString,
            ssl: false
        };
        if (sslEnabled) {
            logDb('Production mode: enabling SSL with rejectUnauthorized=false');
            pgPoolOptions = {
                connectionString,
                ssl: {
                    rejectUnauthorized: false
                }
            };
        }

        const pgPool = new Pool(pgPoolOptions);

        pgPool.on('error', (err: Error) => {
            logErr('DB', err);
            logDb('Unexpected error on idle PostgreSQL client');
        });

        void (async (): Promise<void> => {
            if (!connectionString) {
                logDb('Health check skipped: DATABASE_URL is not set');
                return;
            }
                try {
                    await pgPool.query('SELECT 1');
                    logDb('Health check OK: SELECT 1 succeeded');
                    try {
                        await pgPool.query('SELECT 1 FROM t_files LIMIT 1');
                        logDb('Table check OK: t_files is queryable');
                    } catch (tableErr: unknown) {
                        logErr('DB', tableErr);
                        logDb(
                            'Table check FAILED: cannot read t_files — create the table or fix permissions (see createDatabase.sql)'
                        );
                    }
                } catch (err: unknown) {
                logErr('DB', err);
                logDb('Health check FAILED — file restore and DB sync will not work until connection is fixed');
            }
        })();

        function fetchParamsFromEvent(event: nsfw.FileChangeEvent): string[] | undefined {
            const splitPaths = event.directory.split(path.sep);
            if (splitPaths.length < 6) {
                return undefined;
            }
            const params = workspaces.get(splitPaths[5]) as string[] | undefined;
            return params;
        }

        function pullFilesFromDb(destinationFolder: string, params: string[]): void {
            const workspaceName = params[0];
            logFiles(
                'pullFilesFromDb start workspace=%s destination=%s',
                workspaceName,
                destinationFolder
            );
            const selectQuery = 'SELECT filename, file FROM t_files WHERE workspace=$1';
            pgPool.query(selectQuery, [workspaceName], (err: Error | undefined, res: any) => {
                if (err) {
                    logErr('FILES', err);
                    logFiles(
                        'pullFilesFromDb FAILED for workspace=%s — no files restored: %s',
                        workspaceName,
                        err.message
                    );
                    return;
                }
                const rows = res.rows as { filename: string; file: Buffer }[];
                logFiles('pullFilesFromDb query OK workspace=%s rowCount=%d', workspaceName, rows.length);
                if (rows.length === 0) {
                    logFiles('pullFilesFromDb: no rows for workspace=%s (empty DB or wrong workspace id)', workspaceName);
                }
                rows.forEach((element: { filename: string; file: Buffer }) => {
                    const destPath = destinationFolder + '/' + element.filename;
                    try {
                        fs.mkdirSync(getDirName(destPath), { recursive: true });
                        fs.writeFileSync(destPath, element.file);
                        const size = Buffer.isBuffer(element.file) ? element.file.length : 0;
                        logFiles('restored file workspace=%s path=%s size=%d bytes', workspaceName, element.filename, size);
                    } catch (writeErr: unknown) {
                        logErr('FILES', writeErr);
                        logFiles('failed to write file %s: %s', destPath, writeErr);
                    }
                });
                logFiles(
                    'pullFilesFromDb complete workspace=%s filesWritten=%d writeFlag=%s',
                    workspaceName,
                    rows.length,
                    params[3]
                );
            });
        }

        async function addFileToDB(event: nsfw.CreatedFileEvent): Promise<void> {
            const params = fetchParamsFromEvent(event);
            if (!params) {
                logFiles('addFileToDB: no workspace params for path, skipping');
                return;
            }
            const fullfilepath = event.directory + '/' + event.file;
            const removeNameLength = staticFolderLength + params[0].length + 1;
            const onlyFile = fullfilepath.substring(removeNameLength);
            logFiles('addFileToDB workspace=%s relativePath=%s fullPath=%s', params[0], onlyFile, fullfilepath);
            const client = await pgPool.connect();
            try {
                const sel = await client.query(
                    'SELECT filename, workspace FROM t_files WHERE filename=$1 AND workspace=$2',
                    [onlyFile, params[0]]
                );
                if (sel.rowCount > 0) {
                    logFiles('addFileToDB: file already exists workspace=%s file=%s', params[0], onlyFile);
                    return;
                }
                const rawData = fs.readFileSync(fullfilepath);
                await client.query('INSERT INTO t_files (filename, workspace, file) VALUES ($1, $2, $3)', [
                    onlyFile,
                    params[0],
                    rawData
                ]);
                logFiles('addFileToDB: inserted workspace=%s file=%s', params[0], onlyFile);
            } catch (e: unknown) {
                logErr('FILES', e);
            } finally {
                client.release();
            }
        }

        async function changeFileToDB(event: nsfw.ModifiedFileEvent): Promise<void> {
            const params = fetchParamsFromEvent(event);
            if (!params) {
                logFiles('changeFileToDB: no workspace params, skipping');
                return;
            }
            const fullfilepath = event.directory + '/' + event.file;
            const removeNameLength = staticFolderLength + params[0].length + 1;
            const onlyFile = fullfilepath.substring(removeNameLength);
            logFiles('changeFileToDB workspace=%s relativePath=%s', params[0], onlyFile);
            const client = await pgPool.connect();
            try {
                const rawData = fs.readFileSync(fullfilepath);
                await client.query('BEGIN');
                await client.query('DELETE FROM t_files WHERE filename = $1 AND workspace = $2;', [onlyFile, params[0]]);
                await client.query('INSERT INTO t_files(filename, workspace, file) VALUES ($1, $2, $3)', [
                    onlyFile,
                    params[0],
                    rawData
                ]);
                await client.query('COMMIT');
                logFiles('changeFileToDB committed workspace=%s file=%s', params[0], onlyFile);
            } catch (e: unknown) {
                logErr('FILES', e);
                try {
                    await client.query('ROLLBACK');
                    logFiles('changeFileToDB ROLLBACK workspace=%s file=%s', params[0], onlyFile);
                } catch (rbErr: unknown) {
                    logErr('FILES', rbErr);
                }
            } finally {
                client.release();
            }
        }

        function deleteFileToDB(event: nsfw.DeletedFileEvent): void {
            const params = fetchParamsFromEvent(event);
            if (!params) {
                logFiles('deleteFileToDB: no workspace params, skipping');
                return;
            }
            const fullfilepath = event.directory + '/' + event.file;
            const removeNameLength = staticFolderLength + params[0].length + 1;
            const onlyFile = fullfilepath.substring(removeNameLength);
            logFiles('deleteFileToDB workspace=%s relativePath=%s', params[0], onlyFile);
            const deleteQuery = 'DELETE FROM t_files WHERE filename = $1 AND workspace = $2;';
            pgPool
                .query(deleteQuery, [onlyFile, params[0]])
                .then((r: { rowCount: number }) => {
                    logFiles('deleteFileToDB OK workspace=%s file=%s rowCount=%s', params[0], onlyFile, r.rowCount);
                })
                .catch((err: Error) => {
                    logErr('FILES', err);
                    logFiles('deleteFileToDB FAILED workspace=%s file=%s', params[0], onlyFile);
                });
        }

        function renameFileToDB(event: nsfw.RenamedFileEvent): void {
            const params = fetchParamsFromEvent(event);
            if (!params) {
                logFiles('renameFileToDB: no workspace params, skipping');
                return;
            }
            const fullfilepath = event.directory + '/' + event.oldFile;
            const newfullfilepath = event.newDirectory + '/' + event.newFile;
            const removeNameLength = staticFolderLength + params[0].length + 1;
            const oldFile = fullfilepath.substring(removeNameLength);
            const newFile = newfullfilepath.substring(removeNameLength);
            logFiles('renameFileToDB workspace=%s %s -> %s', params[0], oldFile, newFile);
            const updateQuery = 'UPDATE t_files SET filename=$1 WHERE filename=$2 AND workspace=$3';
            pgPool
                .query(updateQuery, [newFile, oldFile, params[0]])
                .then((r: { rowCount: number }) => {
                    logFiles('renameFileToDB OK workspace=%s rows=%s', params[0], r.rowCount);
                })
                .catch((err: Error) => {
                    logErr('FILES', err);
                    logFiles('renameFileToDB FAILED workspace=%s', params[0]);
                });
        }

        function decrypt(iv: string, t: string): string[] {
            iv = iv.replace(/\-/g, '+').replace(/_/g, '/');
            t = t.replace(/\-/g, '+').replace(/_/g, '/');
            const initialVector = Buffer.from(iv, 'base64');
            const token = Buffer.from(t, 'base64').toString('hex');
            const key = Buffer.from(workspaceTokenKey, 'utf8');
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, initialVector);
            decipher.setAutoPadding(false);
            const deciphered = decipher.update(token, 'hex', 'utf-8') + decipher.final('utf-8');
            const result = JSON.parse(deciphered.substr(0, deciphered.search('}') + 1));
            return [
                result['workspace'],
                result['user'],
                result['organization'],
                result['write'] ? 'true' : 'false',
                result['wsid']
            ];
        }

        function safeDecrypt(iv: string, token: string): string[] | undefined {
            try {
                return decrypt(iv, token);
            } catch (e: unknown) {
                logErr('HTTP', e);
                logHttp('decrypt failed — bad token or iv');
                return undefined;
            }
        }

        function logRequest(req: express.Request, extra?: string): void {
            const ip = requestIp.getClientIp(req);
            logHttp('%s %s ip=%s %s', req.method, req.path, ip, extra ?? '');
        }

        void createWatcher(hostFs + 'tmp/');

        app.get('/itoi/config', (_req, res) => {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.json({ itlingoCloudUrl });
            res.end();
        });

        app.get('/getWorkspace', (req, res) => {
            logRequest(req);
            const ip = requestIp.getClientIp(req);
            if (!(ip in currentEditors)) {
                logHttp('getWorkspace 401 no session for ip=%s', ip);
                res.statusCode = 401;
                res.end();
                return;
            }
            logHttp(
                'getWorkspace 200 ip=%s folder=%s readonly=%s',
                ip,
                currentEditors[ip].foldername,
                !currentEditors[ip].write
            );
            res.statusCode = 200;
            res.setHeader('Content-Type', 'json/application');
            res.json({
                foldername: currentEditors[ip].foldername,
                readonly: !currentEditors[ip].write
            });
            res.end();
        });

        app.get('/createTempWorkspace', (req, res) => {
            logRequest(req, 'createTempWorkspace');
            const ip = requestIp.getClientIp(req);
            if (req.query.iv === undefined || req.query.t === undefined) {
                logHttp('createTempWorkspace redirect — missing iv or t');
                res.statusCode = 301;
                res.redirect(itlingoCloudUrl);
                res.end();
                return;
            }
            const iv = req.query.iv as string;
            const token = req.query.t as string;
            const params = safeDecrypt(iv, token);
            if (!params) {
                logHttp('createTempWorkspace 400 decrypt failed ip=%s', ip);
                res.statusCode = 400;
                res.send('Invalid token');
                res.end();
                return;
            }
            logWorkspace('createTempWorkspace decrypted ip=%s workspace=%s write=%s wsid=%s', ip, params[0], params[3], params[4]);
            createWorkspace(ip, params);
            res.statusCode = 301;
            res.redirect('/');
            res.end();
        });

        app.get('/ping', (req, res) => {
            const ip = requestIp.getClientIp(req);
            if (currentEditors[ip]) {
                currentEditors[ip].time = Date.now();
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/plain');
            res.send('detected workspace of' + ip);
            res.end();
        });

        app.get('/setupRSL', (req, res) => {
            logRequest(req, 'setupRSL');
            const ip = requestIp.getClientIp(req);
            if (currentEditors[ip]) {
                logSetup('setupRSL ip=%s folder=%s', ip, currentEditors[ip].foldername);
                copyRSLFolder(currentEditors[ip].foldername);
            } else {
                logSetup('setupRSL skipped — no editor for ip=%s', ip);
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/plain');
            res.end();
        });

        app.get('/setupASL', (req, res) => {
            logRequest(req, 'setupASL');
            const ip = requestIp.getClientIp(req);
            if (currentEditors[ip]) {
                logSetup('setupASL ip=%s folder=%s', ip, currentEditors[ip].foldername);
                copyASLFolder(currentEditors[ip].foldername);
            } else {
                logSetup('setupASL skipped — no editor for ip=%s', ip);
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/plain');
            res.end();
        });

        app.get('/setupCustom', async (req, res) => {
            logRequest(req, 'setupCustom');
            const ip = requestIp.getClientIp(req);
            let responseItlingoCloud;
            if (currentEditors[ip]) {
                try {
                    responseItlingoCloud = await setupCustomFiles(currentEditors[ip]);
                    logSetup('setupCustom OK ip=%s', ip);
                } catch (e: unknown) {
                    logErr('SETUP', e);
                    logSetup('setupCustom FAILED ip=%s', ip);
                }
            } else {
                logSetup('setupCustom skipped — no editor for ip=%s', ip);
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'json/application');
            res.json(responseItlingoCloud?.data);
            res.end();
        });

        app.get('/setupCustomAccepted', async (req, res) => {
            logRequest(req, `setupCustomAccepted fileid=${req.query.fileid}`);
            const ip = requestIp.getClientIp(req);
            if (currentEditors[ip]) {
                try {
                    await downloadItlingoFiles(
                        currentEditors[ip],
                        req.query.filename as string,
                        req.query.fileid as string
                    );
                } catch (e: unknown) {
                    logErr('SETUP', e);
                }
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/plain');
            res.end();
        });

        async function setupCustomFiles(editor: Editor): Promise<any> {
            const requestURL = itlingoCloudUrl + 'token_api/get-file-list/' + editor.workspaceid;
            logSetup('setupCustomFiles GET %s', requestURL);
            return await axios.get<JSON>(requestURL);
        }

        async function downloadItlingoFiles(editor: Editor, filename: string, fileId: string): Promise<void> {
            const vUrl = itlingoCloudUrl + 'token_api/download-file/' + editor.workspaceid + '/' + fileId;
            logSetup('downloadItlingoFiles GET %s', vUrl);
            const response = await axios({
                url: vUrl,
                method: 'GET',
                responseType: 'arraybuffer'
            });
            const filenameToWrite = editor.foldername + '/' + filename;
            const body = response.data as Buffer | ArrayBuffer;
            const buf = Buffer.isBuffer(body) ? body : Buffer.from(body as ArrayBuffer);
            fs.writeFileSync(filenameToWrite, buf);
            logSetup('downloadItlingoFiles wrote %s', filenameToWrite);
        }

        function copyASLFolder(destPath: string): void {
            copyFolder('ASL', destPath);
        }
        function copyRSLFolder(destPath: string): void {
            copyFolder('RSL', destPath);
        }

        function copyFolder(arg: string, destPath: string): void {
            let src = '';
            switch (arg) {
                case 'ASL':
                    src = hostRoot + 'templates/ASL/';
                    break;
                case 'RSL':
                    src = hostRoot + 'templates/RSL/';
                    break;
                default:
                    logSetup('copyFolder unknown type=%s', arg);
                    return;
            }
            try {
                if (!fs.existsSync(src)) {
                    logSetup('copyFolder FAILED source missing: %s', src);
                    return;
                }
                logSetup('copyFolder %s -> %s', src, destPath);
                fs.cpSync(src, destPath, { recursive: true });
                logSetup('copyFolder OK %s', arg);
            } catch (e: unknown) {
                logErr('SETUP', e);
                logSetup('copyFolder FAILED %s', arg);
            }
        }

        function createWorkspace(ip: string, params: string[]): void {
            const wuuid = uuid.v4();
            const randomFoldername = hostFs + 'tmp/' + wuuid + '/Workspace-' + params[0];
            logWorkspace(
                'createWorkspace ip=%s uuid=%s folder=%s workspaceId=%s write=%s',
                ip,
                wuuid,
                randomFoldername,
                params[0],
                params[3]
            );
            try {
                fs.mkdirSync(randomFoldername, { recursive: true });
                currentEditors[ip] = {
                    foldername: randomFoldername,
                    write: params[3] === 'true',
                    time: Date.now(),
                    workspaceid: Number.parseInt(params[4], 10)
                };
                workspaces.set(wuuid, params);
                logWorkspace('createWorkspace mkdir OK, registered editor for ip=%s', ip);
                logWorkspace('createWorkspace invoking pullFilesFromDb for workspace=%s', params[0]);
                pullFilesFromDb(randomFoldername, params);
            } catch (err: unknown) {
                logErr('WORKSPACE', err);
                logWorkspace('createWorkspace FAILED ip=%s path=%s', ip, randomFoldername);
            }
        }

        async function createWatcher(watchPath: string): Promise<void> {
            let watcher: nsfw.NSFW | undefined;
            try {
                watcher = await nsfw.default(
                    fs.realpathSync(watchPath),
                    (events: nsfw.FileChangeEvent[]) => {
                        for (const event of events) {
                            if (event.action === nsfw.actions.RENAMED) {
                                const re = event as nsfw.RenamedFileEvent;
                                const paramsRename = fetchParamsFromEvent(event);
                                if (!paramsRename) {
                                    continue;
                                }
                                logWatcher(
                                    'RENAMED %s workspace=%s',
                                    renamedEventDescription(re),
                                    paramsRename[0]
                                );
                                renameFileToDB(re);
                                continue;
                            }
                            const rel = eventFilePath(event);
                            try {
                                if (fs.existsSync(rel) && fs.statSync(rel).isDirectory()) {
                                    continue;
                                }
                            } catch {
                                /* DELETE may leave missing path */
                            }
                            const params = fetchParamsFromEvent(event);
                            if (!params) {
                                continue;
                            }
                            if (event.action === nsfw.actions.CREATED) {
                                logWatcher('CREATED file=%s workspace=%s', rel, params[0]);
                                void addFileToDB(event as nsfw.CreatedFileEvent);
                            }
                            if (event.action === nsfw.actions.DELETED) {
                                logWatcher('DELETED file=%s workspace=%s', rel, params[0]);
                                deleteFileToDB(event as nsfw.DeletedFileEvent);
                            }
                            if (event.action === nsfw.actions.MODIFIED) {
                                logWatcher('MODIFIED file=%s workspace=%s', rel, params[0]);
                                void changeFileToDB(event as nsfw.ModifiedFileEvent);
                            }
                        }
                    },
                    {
                        errorCallback: (error: Error) => {
                            console.warn(`[ITOI:WATCHER] Failed to watch "${watchPath}":`, error);
                        }
                    }
                );
                logWatcher('started watcher on %s', watchPath);
                await watcher.start();
            } catch (e: unknown) {
                logErr('WATCHER', e);
                logWatcher('could not start watcher on %s — ensure directory exists', watchPath);
            }
        }
    }
}
