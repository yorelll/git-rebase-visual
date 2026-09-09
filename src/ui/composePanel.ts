import * as vscode from "vscode";

export interface ComposePayload {
  mode: string;
  hash?: string;
  thenEdit: boolean;
  ai: boolean;
  messageOnly?: boolean;
  original: string;
  trailers: string;
  model?: string;
}

/**
 * Editor-area compose surface. Its webview owns draft state with getState(),
 * while retainContextWhenHidden preserves it across view switches. A single
 * panel is a small session registry: reopening focuses and updates the same
 * compose session rather than silently dropping an in-progress draft.
 */
export class ComposePanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private payload?: ComposePayload;
  private ready = false;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri, private readonly onMessage: (message: any) => void) {}

  open(payload: ComposePayload): void {
    this.payload = payload;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel("gitRebaseVisual.compose", "Compose commit message", vscode.ViewColumn.Active, {
        enableScripts: true, retainContextWhenHidden: true,
      });
      this.panel.webview.html = this.html(this.panel.webview);
      this.disposables.push(
        this.panel.webview.onDidReceiveMessage((message) => {
          if (message?.type === "composeReady") {
            this.ready = true;
            if (this.payload) this.post({ type: "openCompose", ...this.payload });
            return;
          }
          this.onMessage(message);
        }),
        this.panel.onDidDispose(() => {
          this.panel = undefined;
          this.ready = false;
          while (this.disposables.length) this.disposables.pop()!.dispose();
        })
      );
    }
    this.panel.title = payload.ai ? "AI compose commit message" : "Compose commit message";
    this.panel.reveal(vscode.ViewColumn.Active, true);
    if (this.ready) this.post({ type: "openCompose", ...payload });
  }

  post(message: any): void { void this.panel?.webview.postMessage(message); }
  visible(): boolean { return !!this.panel && !this.disposed; }
  dispose(): void {
    this.disposed = true;
    this.panel?.dispose();
    while (this.disposables.length) this.disposables.pop()!.dispose();
  }

  private html(webview: vscode.Webview): string {
    const nonce = Array.from({ length: 24 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>
:root{color-scheme:light dark} body{margin:0;padding:22px;max-width:920px;font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background)} h1{font-size:18px;margin:0 0 12px}.row{display:flex;gap:10px;align-items:center}.grow{flex:1} label{display:block;font-size:12px;margin:14px 0 5px;color:var(--vscode-descriptionForeground)} input,textarea{width:100%;box-sizing:border-box;font:13px var(--vscode-editor-font-family);color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border, var(--vscode-panel-border));padding:8px;border-radius:3px}textarea{min-height:210px;line-height:1.5;background-image:linear-gradient(to right,transparent calc(72ch - 1px),var(--vscode-editorRuler-foreground,transparent) calc(72ch - 1px),var(--vscode-editorRuler-foreground,transparent) 72ch,transparent 72ch);background-attachment:local}details{margin-top:12px;border:1px solid var(--vscode-panel-border);padding:7px}pre{white-space:pre-wrap;max-height:180px;overflow:auto}.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}button{border:0;border-radius:3px;padding:6px 12px;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}button.primary{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}.error{color:var(--vscode-errorForeground);white-space:pre-wrap}.muted{font-size:11px;color:var(--vscode-descriptionForeground)}#restore{display:none}</style></head><body>
<h1 id="title">Compose commit message</h1><div id="error" class="error" role="alert"></div><details><summary>原始 message（展开查看）</summary><pre id="original"></pre></details><details id="trailers"><summary>Trailer（原样保留）</summary><pre id="trailer"></pre></details>
<label>Subject <span id="counter">0/72</span></label><input id="subject" maxlength="200" autofocus><label>Body（72 列参考线）</label><textarea id="body"></textarea><section id="ai"><label>补充信息给 AI（可选）</label><textarea id="extra" style="min-height:56px" placeholder="例如：关联 IPCSDK-31159，或要求输出对应链接…"></textarea><div class="row"><button id="generate">生成</button><button id="cancel" style="display:none">取消生成</button><button id="restore">恢复到生成前</button><span id="model" class="muted grow"></span></div></section><div class="actions"><button id="copy">仅生成 message（不提交）</button><button id="close">取消 / Escape</button><button id="apply" class="primary">应用 Ctrl/Cmd+Enter</button></div>
<script nonce="${nonce}">(()=>{const v=acquireVsCodeApi(),$=id=>document.getElementById(id);let ctx=null,before='',generating=false;const text=()=>[$('subject').value,$('body').value].filter((x,i)=>i===0||x.trim()).join('\n\n').trim();const set=(m)=>{const lines=(m||'').replace(/\r/g,'').split('\n');$('subject').value=lines.shift()||'';if(lines[0]==='')lines.shift();$('body').value=lines.join('\n');count()};const count=()=>{$('counter').textContent=$('subject').value.length+'/72';$('counter').style.color=$('subject').value.length>72?'var(--vscode-errorForeground)':$('subject').value.length>50?'var(--vscode-editorWarning-foreground)':''};$('subject').oninput=count;function post(type,x={}){v.postMessage({type,...x})}$('generate').onclick=()=>{before=text();generating=true;$('generate').textContent='生成中…';$('generate').disabled=true;$('cancel').style.display='';post('generate',{mode:ctx.mode,hash:ctx.hash,extra:$('extra').value})};$('cancel').onclick=()=>post('cancelGeneration');$('restore').onclick=()=>set(before);$('apply').onclick=()=>{const message=text();if(!message){$('error').textContent='Commit message 不能为空。';return}if(ctx.messageOnly){post('copyText',{text:message});return}post('apply',{mode:ctx.mode,hash:ctx.hash,message,thenEdit:ctx.thenEdit,messageOnly:ctx.messageOnly})};$('copy').onclick=()=>{post('copyText',{text:text()});$('error').textContent='已复制 message；未提交。'};$('close').onclick=()=>post('closeCompose');document.addEventListener('keydown',e=>{if(e.key==='Escape')post('closeCompose');if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){$('apply').click();}});post('composeReady');addEventListener('message',e=>{const m=e.data;if(m.type==='openCompose'){ctx=m;$('title').textContent=m.ai?'AI 生成 commit message':'Compose commit message';$('original').textContent=m.original||'';$('trailer').textContent=m.trailers||'';$('trailers').style.display=m.trailers?'':'none';$('ai').style.display=m.ai?'':'none';$('model').textContent=m.model?'模型: '+m.model+' · diff 信息由 Git 生成':'';set(m.original||'');$('error').textContent='';v.setState({draft:text(),ctx})}if(m.type==='genDelta'){$('body').value+=m.text||''}if(m.type==='genResult'){generating=false;$('generate').textContent='重新生成';$('generate').disabled=false;$('cancel').style.display='none';$('restore').style.display='';set(m.text||text())}if(m.type==='genCancelled'||m.type==='genError'){generating=false;$('generate').textContent='重新生成';$('generate').disabled=false;$('cancel').style.display='none';if(m.message)$('error').textContent=m.message}if(m.type==='applySucceeded')post('closeCompose');if(m.type==='applyFailed')$('error').textContent=m.message||'应用失败'}});const saved=v.getState();if(saved?.draft)set(saved.draft);})();</script></body></html>`;
  }
}
