import { injectable } from 'inversify';
import * as express from 'express';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import axios from 'axios';
//const pg = require('pg');
import * as fs from 'fs';
import * as nsfw from 'nsfw'
import path = require("path");
import * as uuid from 'uuid';
// const { execFile } = require('node:child_process');
const { Pool } = require('pg');
const getDirName = require('path').dirname
const crypto = require('crypto')

//var getDirName = require('path').dirname;
let requestIp = require('request-ip');


// import { FileNavigatorWidget, FILE_NAVIGATOR_ID } from '@theia/navigator/lib/browser/navigator-widget';
// import { WorkspaceNode } from '@theia/navigator/lib/browser/navigator-tree';
// import URI from '@theia/core/lib/common/uri';

const hostfs = "/tmp/theia/workspaces/";
const hostroot = "/home/theia/pub/";
const staticFolderLength = (hostfs + 'tmp/').length + 36 + '/Workspace-'.length; // 73: hostfs+"tmp/" + UUID(36) + "/Workspace-"
const COM_KEY = "v8y/B?E(H+MbQeThWmZq4t7w!z$C&F)J";
// const itlingoCloudURL = "https://itlingocloud.herokuapp.com/";
const itlingoCloudURL = "http://localhost:8000/"
//var itlingoCloudURL = "http://172.26.128.1:8000/";
const currentEditors: {[ip:string]: Editor} = {};
const workspaces: Map<string, string[]> = new Map<string, string[]>();

type Editor = {
    foldername:string;
    write: boolean;
    time:number;
    workspaceid: number;
};

@injectable()
export class SwitchWSBackendContribution implements BackendApplicationContribution {
    
    //@inject(DiskFileSystemProvider) private readonly fileChangeCollection: DiskFileSystemProvider;
    // @inject(ApplicationShell)
    // protected readonly shell: ApplicationShell;

    // constructor(
    //     @inject(ILogger) protected readonly logger: ILogger) {}

    configure(app: express.Application) {

        // const client = new Client({
        //     host:'ec2-52-31-217-108.eu-west-1.compute.amazonawas.com',
            
        // });


        const connectionString = process.env.DATABASE_URL;
        console.log("CONSTRING - " + connectionString)
        let pgPoolOptions:Object = {connectionString,
            ssl: false
        };
        if (process.env.ITOI_PROD === "PROD"){
            console.log("PROD");
            pgPoolOptions = {connectionString,
                ssl: {
                    rejectUnauthorized: false
                }
            };
            //Lauch LS servers
            console.log("PROD-launch ls");
            // execFile("/home/theia/ls/rsl/bin/start-ls-itlingo --port 6008");
            // execFile("/home/theia/ls/asl/bin/start-asl-ls-itlingo --port 6009");
        }
        const pgPool = new Pool(pgPoolOptions);



        function fetchParamsFromEvent(event: nsfw.FileChangeEvent){
            let splitPaths = event.directory.split(path.sep);
            if (splitPaths.length < 6) return undefined;
            let params = workspaces.get(splitPaths[5]) as string[];
            return params;
        }
        
        function pullFilesFromDb(destinationFolder: string, params: string[]) {
            console.log("PullFiles to:");
            console.log(destinationFolder);
            console.log(params[0]);
            const selectQuery = "SELECT filename, file FROM t_files WHERE workspace=$1";
            pgPool.query(selectQuery, [params[0]], (err:Error, res:any) => {
                console.log("SELECT")
                if (err) return;
                console.log(res); 
                res.rows.forEach((element:any) => {
                    fs.mkdirSync(getDirName(destinationFolder + '/' + element.filename), {recursive: true});
                    fs.writeFileSync(destinationFolder + '/' + element.filename, element.file);
                    console.log("write permissions: " + params[3]);
                    //if(params[3]==="false"){
                    //fs.chmodSync(destinationFolder + '/' + element.filename, 0o444);
                    //} 
                });
            });
        }


        async function addFileToDB( event:nsfw.CreatedFileEvent){
            
            console.log("Add file");
            console.log(event.directory);
            console.log(event.file);
            let params = fetchParamsFromEvent(event);
            const fullfilepath = event.directory + '/' + event.file;
            const removeNameLength = staticFolderLength + params[0].length + 1;
            const onlyFile = fullfilepath.substring(removeNameLength);
            console.log("woot: " + onlyFile + " " + fullfilepath);
            const client = await pgPool.connect();
            await client.query("SELECT filename, workspace FROM t_files WHERE filename=$1 AND workspace=$2", [onlyFile,params[0]], (err:any, res:any) =>
            {
                if(err) {
                    console.error("AddFileToDB ERROR");
                    console.error(err.stack);
                    return;
                }
                if(res.rowCount > 0){
                    console.log("File Already Exists");
                } else {
                    
                    var rawData = fs.readFileSync(fullfilepath);
                    console.log(params);
                    client.query("INSERT INTO t_files (filename, workspace, file) VALUES ($1, $2, $3)",
                    [onlyFile,params[0], rawData], (err:Error,resI:any) => {
                        if(err) {
                            console.error("AddFileToDB Insert ERROR");
                            console.error(err.stack);
                            return;
                        }
                        //console.log("Inserted " + resI.row[0]);
                    });
                }
            });
            client.release();
        }


       async function changeFileToDB( event: nsfw.ModifiedFileEvent) {
            console.log("Change File");
            console.log(event.directory);
            console.log(event.file);
            let params = fetchParamsFromEvent(event);

            const client = await pgPool.connect();
            try {
                const fullfilepath = event.directory + '/' + event.file;
                const removeNameLength = staticFolderLength + params[0].length + 1;
                const onlyFile = fullfilepath.substring(removeNameLength);
                console.log("woot: " + onlyFile + " " + fullfilepath);
                var rawData = fs.readFileSync(fullfilepath);

                await client.query("BEGIN");
                const deleteQuery = "DELETE FROM t_files WHERE filename = $1 AND workspace = $2;"
                await client.query(deleteQuery,[onlyFile, params[0]]);

                const insertQuery = "INSERT INTO t_files(filename, workspace, file) VALUES ($1, $2, $3)"
                client.query(insertQuery, [onlyFile,params[0], rawData]);

                await client.query("COMMIT");
            } catch (e) {
                await client.query("ROLLBACK");
            } finally {
                client.release();
            }
        }

        function deleteFileToDB( event: nsfw.DeletedFileEvent) {
            console.log("Delete File");
            console.log(event.directory);
            console.log(event.file);
            let params = fetchParamsFromEvent(event);
            const fullfilepath = event.directory + '/' + event.file;
            const removeNameLength = staticFolderLength + params[0].length + 1;
            const onlyFile = fullfilepath.substring(removeNameLength);
            console.log("woot: " + onlyFile + " " + fullfilepath);
            let deleteQuery;
            deleteQuery = "DELETE FROM t_files WHERE filename = $1 AND workspace = $2;"
            pgPool.query(deleteQuery,[onlyFile, params[0]]);
        }

        function renameFileToDB( event: nsfw.RenamedFileEvent) {
            console.log("Rename File");
            console.log(event.directory);
            console.log(event.oldFile);

            console.log(event.newDirectory);
            console.log(event.newFile);
            let params = fetchParamsFromEvent(event);
            const fullfilepath = event.directory + '/' + event.oldFile;
            const newfullfilepath = event.newDirectory + '/' + event.newFile;
            const removeNameLength = staticFolderLength + params[0].length + 1;
            const oldFile = fullfilepath.substring(removeNameLength);
            const newFile = newfullfilepath.substring(removeNameLength);

            const updateQuery = "UPDATE t_files SET filename=$1 WHERE filename=$2 AND workspace=$3";
            pgPool.query(updateQuery, [newFile, oldFile, params[0]]);
        }

        function decrypt(iv: string, t: string): string[] {
            iv = iv.replace(/\-/g, '+').replace(/_/g, '/');
            t = t.replace(/\-/g, '+').replace(/_/g, '/');
            const initialVector = Buffer.from(iv, 'base64');
            const token = Buffer.from(t, 'base64').toString('hex');
            const key = Buffer.from(COM_KEY,'utf8');
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, initialVector);
            decipher.setAutoPadding(false);
            const deciphered = decipher.update(token, 'hex', 'utf-8') + decipher.final('utf-8');
            let result = JSON.parse(deciphered.substr(0, deciphered.search('}')+1));
            return [result['workspace'], result['user'], result['organization'],result['write']?"true":"false",result['wsid']]
        }

        // app.post('/setWorkspace', (req, res) => {
        //     // const widget = this.shell.getWidgetById(FILE_NAVIGATOR_ID) as FileNavigatorWidget | undefined;
        //     // if (!widget) {
        //     //     return;
        //     // }
            
        //     path = req.body.path;
        //     path = path.replace("\\", "/");
        //     console.log('setWorkspace :' + path);
        //     // let uri = Uri.file('/some/path/to/folder');
        //     // let success = await commands.executeCommand('vscode.openFolder', uri);
        //     // if (WorkspaceNode.is(widget.model.root)) {
        //     //     widget.model.selectNode(widget.model.getNodesByUri(new URI(path)).next().value);
        //     // }
        //      res.send("done!");
        //      res.end();
        // });


        createWatcher(hostfs + 'tmp/')
        app.get('/getWorkspace', (req, res) => {
            let ip = requestIp.getClientIp(req);
            console.log(currentEditors);
            console.log(ip);
            if(!(ip in currentEditors)){
                res.statusCode = 401;
                res.end();
                return
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'json/application');
            res.json({
                foldername: currentEditors[ip].foldername,  
                readonly: !currentEditors[ip].write
            });
            res.end();
        });

        app.get('/createTempWorkspace', (req, res) => {
            let ip = requestIp.getClientIp(req);
            if(req.query.iv == undefined || req.query.t == undefined) {
                res.statusCode = 301;
                res.redirect(itlingoCloudURL);
                res.end();
            } else {
                let iv = req.query.iv as string;
                let token = req.query.t as string;
                
                let params = decrypt(iv, token);
                console.log("after decrypt");
                console.log(params);
                createWorkspace(ip, params);
                res.statusCode = 301;
                res.redirect('/');
                res.end();
            }
        });

        app.get('/ping', (req, res) => {
            let ip = requestIp.getClientIp(req);
            if(currentEditors[ip]) currentEditors[ip].time =  Date.now();
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/plain');
            res.send("detected workspace of" + ip);
            res.end();
        });



        app.get('/setupRSL', (req, res) => {
            let ip = requestIp.getClientIp(req);
            if(currentEditors[ip]) {
                copyRSLFolder(currentEditors[ip].foldername)
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/plain');
            res.end();
        });

        app.get('/setupASL', (req, res) => {
            let ip = requestIp.getClientIp(req);
            if(currentEditors[ip]) {
                copyASLFolder(currentEditors[ip].foldername)
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/plain');
            res.end();
        });


        app.get('/setupCustom',async (req, res) => {
            let ip = requestIp.getClientIp(req);
            let responseItlingoCloud;
            if(currentEditors[ip]) {
                responseItlingoCloud = await setupCustomFiles(currentEditors[ip]);
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'json/application');
            res.json(responseItlingoCloud?.data);
            res.end();
        });

        app.get('/setupCustomAccepted',async (req, res) => {
            let ip = requestIp.getClientIp(req);
            console.log('setupCustomAccepted');
            console.log(req.query.fileid);
            if(currentEditors[ip]) {
                 downloadItlingoFiles(currentEditors[ip], req.query.filename as string, req.query.fileid as string);
            }
            
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/plain');
            res.end();
        });



        async function setupCustomFiles(editor:Editor){
            let requestURL = itlingoCloudURL + 'token_api/get-file-list/' + editor.workspaceid;
            console.log("CustomRequestURL:" + requestURL);
            return await axios.get<JSON>(requestURL);
        }

        async function downloadItlingoFiles(editor:Editor, filename:string,fileId:string){
            let vUrl =  itlingoCloudURL + 'token_api/download-file/' + editor.workspaceid + '/' + fileId;
            console.log(vUrl);
            axios({
                url: vUrl,
                method: 'GET',
                responseType: 'blob', // important
            }).then((response) => {
                let filenameToWrite = editor.foldername + '/' + filename;
                console.log(filenameToWrite)
                fs.writeFileSync(filenameToWrite, response.data);
            });
        }

        function copyASLFolder(path:string){
            copyFolder('ASL', path);
        }
        function copyRSLFolder(path:string){
            copyFolder('RSL', path);
        }

        function copyFolder(arg: string, path:string){
            switch (arg) {
                case 'ASL':
                    fs.cpSync(hostroot + 'templates/ASL/', path, { recursive: true });
                    break;
                case 'RSL':
                    fs.cpSync(hostroot + 'templates/RSL/', path, { recursive: true });
                    break;
            
                default:
                    break;
            }
        }

function createWorkspace(ip:string, params:string[]){
    let wuuid = uuid.v4();
    var randomFoldername = hostfs + 'tmp/' + wuuid + '/Workspace-'+ params[0];

     fs.mkdir(randomFoldername, {recursive: true},(err:any) => {
         if (err) throw err;
         currentEditors[ip] = {
            foldername: randomFoldername,
            write: params[3]=="true",
            time: Date.now(),
            workspaceid: Number.parseInt(params[4]),
         };
     });
     workspaces.set(wuuid, params);
    pullFilesFromDb(randomFoldername,params);
}


    async function  createWatcher(path:string){
        let watcher: nsfw.NSFW | undefined = await nsfw.default(fs.realpathSync(path), (events: nsfw.FileChangeEvent[]) => {
            for (const event of events) {
                const fullpath = event.directory + '/' + (event as any).file;
                try {
                    if (fs.existsSync(fullpath) && fs.statSync(fullpath).isDirectory()) continue;
                } catch (_) { /* path may no longer exist for DELETE events */ }
                let params = fetchParamsFromEvent(event);
                if (!params) continue;
                if (event.action === nsfw.actions.CREATED) {
                    console.log('File', path, 'has been added');
                    addFileToDB( event);
                }
                if (event.action === nsfw.actions.DELETED) {
                    console.log('File', path, 'has been removed');
                    deleteFileToDB( event);
                }
                if (event.action === nsfw.actions.MODIFIED) {
                    console.log('File', path, 'has been changed');
                    changeFileToDB( event);
                }
                if (event.action === nsfw.actions.RENAMED) {
                    console.log('File', path, 'has been changed');
                    renameFileToDB( event);
                }
            }
        }, {
                errorCallback: error => {
                    // see https://github.com/atom/github/issues/342
                    console.warn(`Failed to watch "${path}":`, error);
                }
            });
        console.log('created watcher for:' + path);
        await watcher.start();
        return watcher;
    }

    }
}
