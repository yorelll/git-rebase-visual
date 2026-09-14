import * as vscode from "vscode";
import { PanelLifecycle } from "./panelLifecycle";

export interface CommitInspectorCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
  locked: boolean;
}

export interface CommitInspectorPayload {
  kind: "preview" | "single" | "batch";
  revision: number;
  commit?: CommitInspectorCommit;
  commits?: CommitInspectorCommit[];
  detail?: {
    author: string;
    email: string;
    relDate: string;
    absDate: string;
    message: string;
    stat: string;
  };
  llmConfigured: boolean;
  rebaseInProgress: boolean;
  hasStaged: boolean;
  generatedDiffEnabled?: boolean;
  generatedDiffReason?: string;
}

/**
 * An editor-area companion for hover detail and context actions. Unlike a fixed
 * sidebar tooltip/menu it never covers neighbouring commit rows. Hover previews
 * deliberately preserve focus; explicit context actions use the same panel.
 */
export class CommitInspectorPanel implements vscode.Disposable {
  private readonly lifecycle = new PanelLifecycle<vscode.WebviewPanel>();
  private readonly panelDisposables = new Map<number, vscode.Disposable[]>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (message: any) => void,
    private readonly onDidClose?: () => void
  ) {}

  open(payload: CommitInspectorPayload): void {
    let panel = this.lifecycle.current();
    if (!panel) {
      panel = vscode.window.createWebviewPanel(
        "gitRebaseVisual.commitInspector",
        "Git Rebase · Commit",
        // preserveFocus prevents this companion panel from becoming the active
        // editor while it is opening. Otherwise the provider's public
        // onDidChangeActiveTextEditor close bridge would immediately dispose it.
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.extensionUri] }
      );
      const lease = this.lifecycle.open(panel);
      const listeners: vscode.Disposable[] = [];
      listeners.push(
        panel.webview.onDidReceiveMessage((message) => this.onMessage(message)),
        panel.onDidDispose(() => {
          // Each native panel owns its listener collection. An old callback never
          // clears a successor panel or destroys its subscriptions.
          lease.release();
          this.disposePanelListeners(lease.id);
          this.onDidClose?.();
        })
      );
      this.panelDisposables.set(lease.id, listeners);
      panel.webview.html = this.html(panel.webview);
    }
    const prefix = payload.kind === "preview" ? "预览" : payload.kind === "batch" ? "批量操作" : payload.commit?.shortHash ?? "Commit";
    panel.title = `Git Rebase · ${prefix}`;
    void panel.webview.postMessage({ type: "show", payload });
  }

  close(): void {
    this.lifecycle.current()?.dispose();
  }

  dispose(): void {
    this.lifecycle.current()?.dispose();
    for (const id of [...this.panelDisposables.keys()]) this.disposePanelListeners(id);
  }

  private disposePanelListeners(id: number): void {
    const listeners = this.panelDisposables.get(id);
    if (!listeners) return;
    this.panelDisposables.delete(id);
    for (const listener of listeners) listener.dispose();
  }

  private html(webview: vscode.Webview): string {
    const nonce = Array.from({ length: 24 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>
:root{color-scheme:light dark}body{margin:0;padding:14px;box-sizing:border-box;font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background)}main{max-width:760px;margin:0 auto}.head{font:12px var(--vscode-editor-font-family);color:var(--vscode-descriptionForeground);margin-bottom:8px}.subject{font-size:16px;font-weight:600;line-height:1.4;margin:0 0 10px}.meta{font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:10px}.hint{font-size:11px;color:var(--vscode-descriptionForeground);margin:0 0 10px}.message{margin:8px 0 12px;max-height:42vh;overflow:auto;white-space:pre-wrap;word-break:break-word;background:var(--vscode-textCodeBlock-background,var(--vscode-editor-background));border:1px solid var(--vscode-panel-border);border-left:3px solid var(--vscode-focusBorder);padding:10px;font:12px/1.5 var(--vscode-editor-font-family)}.group{margin:10px 0;border-top:1px solid var(--vscode-panel-border);padding-top:8px}.group-title{font-size:10px;letter-spacing:.45px;text-transform:uppercase;color:var(--vscode-descriptionForeground);margin:0 0 5px}.actions{display:flex;flex-wrap:wrap;gap:6px}button{border:0;border-radius:3px;padding:5px 9px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);font:inherit;font-size:12px}button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button.danger{color:var(--vscode-errorForeground,var(--vscode-button-secondaryForeground)}button:disabled{opacity:.5}button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}.reason{font-size:11px;color:var(--vscode-descriptionForeground);margin:3px 0 0}</style></head><body><main id="app"></main><script nonce="${nonce}">(()=>{const v=acquireVsCodeApi(),app=document.getElementById('app');const post=(type,x={})=>v.postMessage({type,...x});const el=(tag,cls,text)=>{const x=document.createElement(tag);if(cls)x.className=cls;if(text!==undefined)x.textContent=text;return x};const action=(label,type,data={},o={})=>{const b=el('button',(o.primary?'primary ':'')+(o.danger?'danger ':''),label);b.disabled=!!o.disabled;b.title=o.title||'';if(!b.disabled)b.onclick=()=>post(type,data);return b};const group=(title,items,reason)=>{const g=el('section','group'),h=el('div','group-title',title),a=el('div','actions');a.append(...items);g.append(h,a);if(reason)g.append(el('div','reason',reason));return g};function detail(p,root){if(!p.detail)return;root.append(el('div','meta',p.detail.author+' <'+p.detail.email+'> · '+p.detail.relDate+' · '+p.detail.absDate+' · '+p.detail.stat),el('pre','message',p.detail.message));}function single(p){const c=p.commit,root=document.createDocumentFragment();root.append(el('div','head',c.shortHash+' · '+c.author+' · '+c.date),el('h1','subject',c.subject));detail(p,root);if(p.kind==='preview'){root.append(el('div','hint','悬停详情预览 · 可在右侧阅读或复制；下次预览/操作或编辑器切换时更新'));return root}root.append(group('变基与编辑',[action('⏸ 停靠在此 (edit)','rebaseTo',{hash:c.hash},{primary:true,disabled:p.rebaseInProgress,title:p.rebaseInProgress?'变基进行中。':'开始受确认保护的 edit rebase'}),action('✎ 编辑 message…','openCompose',{mode:'commit',hash:c.hash,ai:false,thenEdit:false}),action('✦ AI 生成 message…','openCompose',{mode:'commit',hash:c.hash,ai:true,thenEdit:false},{disabled:!p.llmConfigured,title:'请先配置 LLM。'}),action('⧉ 追加暂存区','appendStaged',{hash:c.hash},{disabled:c.locked||!p.hasStaged||p.rebaseInProgress,title:c.locked?'目标已锁定。':!p.hasStaged?'暂存区为空。':p.rebaseInProgress?'变基进行中。':''})]));root.append(group('查看',[action('⧉ 复制 hash','copyHash',{hash:c.hash}),action('⧉ 复制 message','copyMessage',{hash:c.hash}),action('◫ 打开变更…','openDiff',{hash:c.hash}),action('▤ 生成 Diff…','generateDiff',{hash:c.hash,revision:p.revision})]));root.append(group('保护',[action(c.locked?'🔓 解除锁定':'🔒 锁定 commit',c.locked?'unlock':'lock',{hash:c.hash})]));root.append(group('危险操作',[action('⌫ 删除 commit (drop)','drop',{hash:c.hash},{danger:true,disabled:c.locked,title:c.locked?'目标已锁定。':''})]));return root}function batch(p){const hashes=p.commits.map(c=>c.hash),root=document.createDocumentFragment();root.append(el('div','head','已选择 '+p.commits.length+' 个 commit'),el('h1','subject','批量 Commit 操作'));root.append(group('查看',[action('▤ 生成 Diff…','bulkGenerateDiff',{hashes,revision:p.revision},{disabled:!p.generatedDiffEnabled,title:p.generatedDiffReason||''})],p.generatedDiffEnabled?'':'仅支持连续 commit；请取消未连续选择或使用单项 Diff。'));root.append(group('保护',[action('🔒 批量锁定 commit','bulkLock',{hashes})]));root.append(group('危险操作',[action('⌫ 批量删除 commit','bulkDrop',{hashes},{danger:true})]));return root}addEventListener('message',e=>{if(e.data.type!=='show')return;const p=e.data.payload;app.innerHTML='';app.append(p.kind==='batch'?batch(p):single(p));});})();</script></body></html>`;
  }
}
