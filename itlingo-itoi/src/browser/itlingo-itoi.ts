
import { injectable, inject } from '@theia/core/shared/inversify';
import { Command, MessageService} from '@theia/core/lib/common';
import {  FrontendApplication, AbstractViewContribution } from '@theia/core/lib/browser';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";
import { GettingStartedWidget } from './itlingo-itoi-widget';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import * as monaco from '@theia/monaco-editor-core';
import { Widget } from '@theia/core/lib/browser/widgets';
import { ILogger } from "@theia/core/lib/common";
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import  TheiaURI from '@theia/core/lib/common/uri';

import axios from 'axios';



var path = '/home/theia/Workspaces';
var itlingoCloudURL = "https://itlingocloud.herokuapp.com/";
var itlingoCloudURL = "http://localhost:8000/"
var _switchingWorkspace = false;

export const TheiaExampleExtensionCommand: Command = {
    id: 'TheiaExampleExtension.command',
    label: 'Say Hello'
};


@injectable()
export class TheiaSendBdFileUpdates extends AbstractViewContribution<GettingStartedWidget>  implements FrontendApplicationContribution {

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;
    @inject(FrontendApplicationStateService)
    protected readonly stateService: FrontendApplicationStateService;
    @inject(WorkspaceService) private readonly workspaceService: WorkspaceService;
    // @inject(MonacoEditorService) private readonly monacoEditorService: MonacoEditorService,
    //@inject(MonacoWorkspace) private readonly monacoWorkspace: MonacoWorkspace,
    @inject(MessageService) private readonly messageService: MessageService;

   
    
    // @inject(WorkspaceCommandContribution) private readonly workspaceCommandContribution: WorkspaceCommandContribution,
    // @inject(CommandService) private readonly commandService: CommandService,
    //@inject(CommandService) private readonly commandService: CommandService,
    @inject(ILogger) protected readonly logger: ILogger;
    constructor(
    ) { 
        super({
            widgetId: GettingStartedWidget.ID,
            widgetName: GettingStartedWidget.LABEL,
            defaultWidgetOptions: {
                area: 'main',
            }
        });
    }

    private readonly:boolean = true;

    protected async switchWorkspace(path: string): Promise<void> {
        this.messageService.info(path);
         this.workspaceService.open(new TheiaURI(path), {
            preserveWindow: true
         });
    }

    private setReadOnly(){
        monaco.editor.onDidCreateEditor((codeEditor) =>{
            codeEditor.updateOptions({readOnly: this.readonly});
        });
        
        if(this.readonly){
            this.shell.widgets.forEach((widget: Widget) => {
                if (['terminal','process'].includes(widget.id) || widget.id.startsWith('debug') || widget.id.startsWith('scm')) {
                    widget.dispose();
                }
            });
            //this.quickView.showItem()
            
            var xMenuItems = document.getElementById("theia-top-panel") as HTMLElement;
            xMenuItems.classList.add("extension-readOnly");
            var styleElement = document.createElement('style');


            var styles = '.p-Widget.p-Menu { ';
            styles += 'pointer-events: none; ';
            styles += 'cursor: default; ';
            styles += ' }\n';
            styles += '.p-Menu-item { ';
            styles += 'opacity: var(--theia-mod-disabled-opacity); ';
            styles += 'pointer-events: none; ';
            styles += 'cursor: default;';
            styles += ' }\n';
            styles += '.p-Menu-item[data-command="file.download"] { ';
            styles += 'opacity: 1;';
            styles += 'pointer-events: all; ';
            styles += 'cursor: pointer; ';
            styles += ' }\n';
            styles += '.p-Menu-item[data-command="core.copy"] { ';
            styles += 'opacity: 1;';
            styles += 'pointer-events: all; ';
            styles += 'cursor: pointer; ';
            styles += ' }\n';
            styles += '.p-Menu-item[data-command="code-annotation.addNote"] { ';
            styles += 'opacity: 1;';
            styles += 'pointer-events: all; ';
            styles += 'cursor: pointer; ';
            styles += ' }\n';
            // // Add the first CSS rule to the stylesheet
            styleElement.innerHTML = styles;
            document.body.appendChild(styleElement);
            // var styles = '.p-Menu-item[data-command="core.cut"] {';
            // styles += '.p-mod-active';
            // styles += '}\n';
            // sheet?.insertRule(styles, 0);


        }
    }

     private compareFoldernames(path1: string, path2: string){
         return path1.substring(path1.length-77) === path2.substring(path2.length - 77);
     }
    configure(app: FrontendApplication): void{
        
    }
    onStart(app: FrontendApplication):void {
         if (_switchingWorkspace) {
             return;
         }
         _switchingWorkspace = true;

         this.stateService.reachedState('ready').then(() => {
             axios.get<JSON>('/getWorkspace',{},).then(
                 (response: any) => {
                     var prevRoot = this.workspaceService.tryGetRoots()[0] ;
                     
                    if (prevRoot != undefined) {
                        if (!this.compareFoldernames(response.data.foldername.toString(), prevRoot.resource.path.toString())){
                            path = '' + response.data.foldername;
                            this.messageService.info("Changing Workspace to:" + response.data.foldername + " PREV:" + prevRoot.resource.path);
                            this.switchWorkspace(path);
                        }
                    } else {
                        path = '' + response.data.foldername;
                        this.messageService.info("Setting Workspace to:" + response.data.foldername + " STATUS:" + response.status);
                        this.switchWorkspace(path);
                    }
                    this.openView({ reveal: true });
                    this.readonly = response.data.readonly;
                    console.log(this.readonly);
                    this.setReadOnly();
                    _switchingWorkspace = false;
                 }
             ).catch((error) => {
                _switchingWorkspace = false;
                //window.location.href = itlingoCloudURL;
             });
         });

        this.messageService.info("Welcome to ITLingo online IDE!");
    }
}
