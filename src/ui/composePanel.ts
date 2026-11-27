import * as vscode from "vscode";
import {
  ComposeDraft,
  ComposePanelDelivery,
  ComposeSessionPayload,
} from "./composePanelState";

export interface ComposePayload {
  mode: string;
  hash?: string;
  thenEdit: boolean;
  ai: boolean;
  original: string;
  trailers: string;
  model?: string;
  /** Short immutable context shown in the tab/header; never used as authority. */
  subject?: string;
  /** edit-stop target action, selected by the banner rather than inferred. */
  editKind?: "amend" | "new";
  /** Recoverable dirty draft captured before a panel is disposed. */
  draft?: string;
  /** Changes only when the target context is known to have changed. */
  revision?: number;
}

/**
 * Editor-area compose surface. The panel keeps a dirty draft client-side while
 * the host owns the target session and validates it before any Git write.
 */
export class ComposePanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private disposed = false;
  private readonly delivery = new ComposePanelDelivery();
  private readonly disposables: vscode.Disposable[] = [];
  private active?: ComposeSessionPayload;
  private recoveredDraft?: ComposeDraft;
  /**
   * Sessions this panel incarnation has delivered. When a dirty page refuses an
   * overwrite it reports the session it kept on screen; the host must follow
   * that refusal, or Cancel/Escape would post the refused session while the
   * host's active target is the newer one and the close guard would swallow it.
   */
  private readonly retainedSessions = new Map<string, ComposeSessionPayload>();

  constructor(private readonly extensionUri: vscode.Uri, private readonly onMessage: (message: any) => void) {}

  open(payload: ComposePayload): void {
    const revision = payload.revision ?? 0;
    const sessionId = `${payload.mode}:${payload.hash ?? "working"}:${payload.thenEdit ? "edit" : "apply"}:${payload.editKind ?? "normal"}`;
    const session: ComposeSessionPayload = { ...payload, revision, sessionId };
    this.retain(session);
    const readyPayload = this.delivery.update(session);
    this.active = session;
    if (!this.panel) {
      this.delivery.reset();
      this.panel = vscode.window.createWebviewPanel(
        "gitRebaseVisual.compose",
        this.title(session),
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      // Register host listener/dispose first; only then set HTML. The page sends
      // composeReady after its listener is registered, making first delivery and
      // reload delivery explicit rather than timing-dependent.
      this.disposables.push(
        this.panel.webview.onDidReceiveMessage((message) => {
          if (message?.type === "composeReady") {
            const latest = this.delivery.markReady(message.sessionId, message.revision);
            if (latest) this.deliver(latest);
            return;
          }
          // The dirty page rejected a target switch. Follow it instead of
          // leaving host and page on different sessions: Cancel/Escape then
          // posts the session the host still considers active.
          if (message?.type === "composeRefused") {
            this.restoreRefusedSession(message);
            return;
          }
          if (message?.type === "composeDraft" && this.active && typeof message.draft === "string") {
            const sessionId = typeof message.sessionId === "string" ? message.sessionId : this.active.sessionId;
            const revision = typeof message.revision === "number" ? message.revision : this.active.revision;
            if (sessionId === this.active.sessionId && revision === this.active.revision) {
              this.recoveredDraft = { sessionId, revision, draft: message.draft };
            }
          }
          this.onMessage(message);
        }),
        this.panel.onDidDispose(() => {
          // Both the native tab close and Cancel/Escape retain the exact dirty
          // draft. Only an apply (or a target whose revision changed) clears it;
          // cancel must never silently destroy a long message.
          this.panel = undefined;
          this.active = undefined;
          this.retainedSessions.clear();
          this.delivery.reset();
          while (this.disposables.length) this.disposables.pop()!.dispose();
        })
      );
      this.panel.webview.html = this.html(this.panel.webview);
    }
    this.panel.title = this.title(session);
    this.panel.reveal(vscode.ViewColumn.Active, true);
    if (readyPayload) this.deliver(readyPayload);
  }

  /**
   * Closes the editor surface. The recovery copy is deliberately retained so
   * reopening the same target restores the message the user typed.
   */
  close(): void {
    this.panel?.dispose();
  }

  /** Removes a matching recovery record after an apply or a stale target. */
  clearDraft(sessionId?: unknown, revision?: unknown): void {
    if (
      this.recoveredDraft &&
      (sessionId === undefined || sessionId === this.recoveredDraft.sessionId) &&
      (revision === undefined || revision === this.recoveredDraft.revision)
    ) {
      this.recoveredDraft = undefined;
    }
  }

  acceptsActiveSession(sessionId: unknown, revision: unknown): boolean {
    return !!this.active && this.active.sessionId === sessionId && this.active.revision === revision;
  }

  activeSession(): ComposeSessionPayload | undefined {
    return this.active;
  }

  post(message: any): void { void this.panel?.webview.postMessage(message); }
  visible(): boolean { return !!this.panel && !this.disposed; }
  dispose(): void {
    this.disposed = true;
    this.panel?.dispose();
    while (this.disposables.length) this.disposables.pop()!.dispose();
  }

  private retain(session: ComposeSessionPayload): void {
    // Every delivered session may be the one a dirty page keeps on screen: the
    // page can refuse any number of newer targets, so no eviction is safe.
    this.retainedSessions.set(`${session.sessionId}|${session.revision}`, session);
  }

  /**
   * The page refused an overwrite because its draft is dirty. Move the host
   * back to the session the page actually shows so Cancel/Escape remains valid;
   * only the exact proposal that is still active may be refused, so a late
   * refusal cannot undo a newer accepted target.
   */
  private restoreRefusedSession(message: {
    sessionId?: unknown;
    revision?: unknown;
    incomingSessionId?: unknown;
    incomingRevision?: unknown;
  }): void {
    const active = this.active;
    if (
      !active ||
      typeof message.sessionId !== "string" ||
      typeof message.revision !== "number" ||
      message.incomingSessionId !== active.sessionId ||
      message.incomingRevision !== active.revision
    ) {
      return;
    }
    const retained = this.retainedSessions.get(`${message.sessionId}|${message.revision}`);
    if (!retained) return;
    if (retained.sessionId === active.sessionId && retained.revision === active.revision) return;
    this.active = retained;
    // Keep the tab title and reload delivery aligned with the session the page
    // is displaying.
    if (this.panel) this.panel.title = this.title(retained);
    this.delivery.update(retained);
  }

  private deliver(payload: ComposeSessionPayload): void {
    const draft = this.delivery.draftFor(payload, this.recoveredDraft);
    this.post({ type: "openCompose", ...payload, draft });
  }

  private title(payload: ComposeSessionPayload): string {
    const target = payload.hash?.slice(0, 8);
    const subject = payload.subject?.replace(/\s+/g, " ").trim();
    if (payload.mode === "commit" && target) {
      const prefix = payload.ai ? "AI message" : "编辑 message";
      return `${prefix} · ${target}${subject ? ` · ${subject.slice(0, 48)}` : ""}`;
    }
    if (payload.editKind === "new") return "新建 commit · edit 停靠";
    return payload.ai ? "AI compose commit message" : "Compose commit message";
  }

  private html(webview: vscode.Webview): string {
    const nonce = Array.from({ length: 24 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>
:root{color-scheme:light dark} body{margin:0;padding:22px;box-sizing:border-box;font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background)}main{max-width:860px;margin:0 auto}h1{font-size:18px;margin:0 0 4px}.context{font:12px var(--vscode-editor-font-family);color:var(--vscode-descriptionForeground);margin-bottom:12px}.warning{display:none;margin:0 0 10px;padding:7px 9px;border:1px solid var(--vscode-inputValidation-warningBorder,var(--vscode-panel-border));background:var(--vscode-inputValidation-warningBackground);color:var(--vscode-inputValidation-warningForeground,var(--vscode-foreground))}.row{display:flex;gap:10px;align-items:center}.grow{flex:1}label{display:block;font-size:12px;margin:14px 0 5px;color:var(--vscode-descriptionForeground)}input,textarea{width:100%;box-sizing:border-box;font:13px var(--vscode-editor-font-family);color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));padding:8px;border-radius:3px}textarea{min-height:210px;line-height:1.5}#body{background-image:repeating-linear-gradient(to bottom,transparent 0,transparent calc(1.5em - 1px),color-mix(in srgb,var(--vscode-editorRuler-foreground,transparent) 25%,transparent) calc(1.5em - 1px),color-mix(in srgb,var(--vscode-editorRuler-foreground,transparent) 25%,transparent) 1.5em);background-size:100% 1.5em;background-attachment:local}details{margin-top:12px;border:1px solid var(--vscode-panel-border);padding:7px}pre{white-space:pre-wrap;max-height:180px;overflow:auto}.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}button{border:0;border-radius:3px;padding:6px 12px;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}button.primary{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}.error{color:var(--vscode-inputValidation-errorForeground,var(--vscode-foreground));white-space:pre-wrap;border-left-width:2px;border-left-style:solid;border-left-color:var(--vscode-inputValidation-errorBorder,var(--vscode-errorForeground));padding-left:8px}.muted{font-size:11px;color:var(--vscode-descriptionForeground)}#restore{display:none}.dirty{display:none;color:var(--vscode-editorWarning-foreground)}body.is-dirty .dirty{display:inline}.diff-action{font-size:12px}</style></head><body><main>
<h1 id="title">Compose commit message <span class="dirty" aria-label="未保存草稿">●</span></h1><div id="context" class="context"></div><button id="diff" class="diff-action" type="button" style="display:none">打开目标变更…</button><div id="warning" class="warning" role="alert"></div><div id="error" class="error" role="alert"></div><details><summary id="original-summary">原始 message（展开查看）</summary><pre id="original"></pre></details><details id="trailers"><summary>Trailer（原样保留）</summary><pre id="trailer"></pre></details>
<label for="subject">Subject <span id="counter" aria-hidden="true">0/72</span></label><input id="subject" maxlength="200" autofocus><label for="body">Body（72 列参考线）</label><textarea id="body"></textarea><section id="ai"><label for="extra">补充信息给 AI（可选）</label><textarea id="extra" style="min-height:56px" placeholder="例如：关联 IPCSDK-31159，或要求输出对应链接…"></textarea><div class="row"><button id="generate">生成</button><button id="cancel" style="display:none">取消生成</button><button id="restore">恢复到生成前</button><span id="model" class="muted grow"></span></div></section><div class="actions"><button id="close">取消 / Escape</button><button id="apply" class="primary">应用 Ctrl/Cmd+Enter</button></div>
</main><script nonce="${nonce}">(()=>{const v=acquireVsCodeApi(),$=id=>document.getElementById(id);let ctx=null,before='',generating=false,dirty=false;const text=()=>[$('subject').value,$('body').value].filter((x,i)=>i===0||x.trim()).join('\\n\\n').trim();const key=()=>ctx?ctx.sessionId+'|'+ctx.revision:'';const saved=()=>v.getState()||{};function post(type,x={}){v.postMessage({type,...x})}function setDirty(value){dirty=value;document.body.classList.toggle('is-dirty',dirty);v.setState({draft:text(),ctxKey:key(),dirty});if(dirty&&ctx)post('composeDraft',{draft:text(),sessionId:ctx.sessionId,revision:ctx.revision})}const set=(m)=>{const lines=(m||'').replace(/\\r/g,'').split('\\n');$('subject').value=lines.shift()||'';if(lines[0]==='')lines.shift();$('body').value=lines.join('\\n');count()};const count=()=>{$('counter').textContent=$('subject').value.length+'/72';$('counter').style.color=$('subject').value.length>72?'var(--vscode-errorForeground)':$('subject').value.length>50?'var(--vscode-editorWarning-foreground)':''};$('subject').oninput=()=>{count();setDirty(true)};$('body').oninput=()=>setDirty(true);$('generate').onclick=()=>{if(!ctx)return;before=text();generating=true;$('generate').textContent='生成中…';$('generate').disabled=true;$('cancel').style.display='';post('generate',{mode:ctx.mode,hash:ctx.hash,extra:$('extra').value,sessionId:ctx.sessionId,revision:ctx.revision})};$('cancel').onclick=()=>post('cancelGeneration');$('restore').onclick=()=>{set(before);setDirty(true)};$('diff').onclick=()=>{if(ctx&&ctx.hash)post('openDiff',{hash:ctx.hash})};$('apply').onclick=()=>{if(!ctx)return;const message=text();if(!message){$('error').textContent='Commit message 不能为空。';return}if(ctx.editKind){post(ctx.editKind==='amend'?'commitEditAmend':'commitEditNew',{message,sessionId:ctx.sessionId,revision:ctx.revision});return}post('apply',{mode:ctx.mode,hash:ctx.hash,message,thenEdit:ctx.thenEdit,sessionId:ctx.sessionId,revision:ctx.revision})};$('close').onclick=()=>{post('closeCompose',{dirty,sessionId:ctx&&ctx.sessionId,revision:ctx&&ctx.revision})};document.addEventListener('keydown',e=>{if(e.key==='Escape')$('close').click();if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){$('apply').click();}});addEventListener('message',e=>{const m=e.data;if(m.type==='openCompose'){const state=saved(),incomingKey=m.sessionId+'|'+m.revision,same=state.ctxKey===incomingKey;if(ctx&&key()!==incomingKey&&dirty){$('warning').textContent='目标 commit 已变化；当前草稿未被覆盖。请确认后重新打开目标。';$('warning').style.display='block';post('composeRefused',{sessionId:ctx.sessionId,revision:ctx.revision,incomingSessionId:m.sessionId,incomingRevision:m.revision});return}ctx=m;$('title').firstChild.textContent=m.ai?'AI 生成 commit message ':'Compose commit message ';$('context').textContent=m.hash?(m.hash.slice(0,8)+' · '+(m.subject||m.original.split('\\n')[0]||'commit message')):(m.editKind==='new'?'edit 停靠：新建 commit':'');$('diff').style.display=m.hash?'':'none';$('original').textContent=m.original||'';$('original-summary').textContent='原始 message'+(m.original?': '+m.original.split('\\n')[0]:'')+'（展开查看）';$('trailer').textContent=m.trailers||'';$('trailers').style.display=m.trailers?'':'none';$('ai').style.display=m.ai?'':'none';$('apply').textContent=m.editKind==='amend'?'Amend Ctrl/Cmd+Enter':m.editKind==='new'?'新建 commit Ctrl/Cmd+Enter':'应用 Ctrl/Cmd+Enter';$('model').textContent=m.model?'模型: '+m.model+' · diff 信息由 Git 生成':'';if(m.draft!==undefined){set(m.draft);setDirty(true)}else if(!same||!state.dirty){set(m.original||'');setDirty(false)}else{set(state.draft||'');setDirty(true)}$('error').textContent='';$('warning').style.display='none'}if(m.type==='staleTarget'){$('warning').textContent=m.message||'目标 commit 已变化，建议重新打开。';$('warning').style.display='block'}if(m.type==='genDelta'){$('body').value+=m.text||'';setDirty(true)}if(m.type==='genResult'){generating=false;$('generate').textContent='重新生成';$('generate').disabled=false;$('cancel').style.display='none';$('restore').style.display='';set(m.text||text());setDirty(true)}if(m.type==='genCancelled'||m.type==='genError'){generating=false;$('generate').textContent='重新生成';$('generate').disabled=false;$('cancel').style.display='none';if(m.message)$('error').textContent=m.message}if(m.type==='applySucceeded'){setDirty(false);post('closeCompose',{sessionId:ctx&&ctx.sessionId,revision:ctx&&ctx.revision})}if(m.type==='applyFailed')$('error').textContent=m.message||'应用失败'});const initial=saved();const initialKey=initial.ctxKey||'';const splitAt=initialKey.lastIndexOf('|');post('composeReady',{sessionId:splitAt>=0?initialKey.slice(0,splitAt):undefined,revision:splitAt>=0?Number(initialKey.slice(splitAt+1)):undefined});})();</script></body></html>`;
  }
}
