# Git Rebase Visual — 补充代码评审报告（0.7.2）

> **评审基线**：`f4045ea9163014389ef0406cae4d56bd527d9ddf`（v0.6.3）。
>
> **前序评审**：[`code-review-0-7-1.md`](code-review-0-7-1.md) 发现 R71-1；本次只独立复核其整改提交。
>
> **本次独立复核覆盖提交**：`147f76b6e9c8d240ebd9b78cdd617a59dd7533e8` — `fix: complete LLM safe port policy`。
>
> **范围**：Fetch/URL Standard forbidden-port 集合、`listen(0)` 后 inspect/close/retry 的资源及异常清理、`withServer()` cleanup、端口边界与 IPv4 loopback、retry 回归是否实际触发服务器生命周期，以及原有 LLM deadline/cancellation/SSE 语义和 0.7.1 回复/台账准确性。
>
> **结论**：**不批准 / 不可发布。** 发现 1 项 P1：所谓完整集合仍遗漏 Fetch 标准明确禁止的 `6000`（X11）。Windows 当前动态 TCP 范围包含该端口，故 `listen(0)` 仍可随机得到一个会被 Fetch 在 handler 之前拒绝的端口。`147f76b` 需要 Agent A 再次修复并接受独立复核。

---

## 1. Finding

### R72-1 — P1：safe-port policy 仍遗漏 Fetch bad port `6000`，LLM 测试仍可随机在 handler 前失败

- [ ] **未修复；发布阻止。**

**位置**：`test/llmClient.test.ts` 的 `fetchForbiddenPorts`、`isFetchSafeTestPort()`、policy exact-equality regression（约 10–20、70–87 行）。

**根因**：`147f76b` 补入了 `5060` 和 `5061`，但 Fetch Standard 当前 [bad-port table](https://fetch.spec.whatwg.org/#port-blocking) 还包含 **`6000`**。本次独立将源码 policy 与标准表逐项比较，结果为：标准表 83 项，源码 set 82 项；标准项缺少 `0`、`6000`，另有非标准的 `4333`。

`0` 虽未放进 set，但 `isFetchSafeTestPort()` 的 `port > 0` 已正确拒绝它，因此不构成 allocation 漏网。相反，`6000` 既不在 set，也通过整数/范围检查：`isFetchSafeTestPort(6000)` 当前为 `true`。`4333` 的额外拒绝只会造成无害的重试，却使回复中“与完整标准表 exact equality”的声明不成立；不能替代缺失的 `6000`。

本 reviewer 在 Node `v24.16.0` 直接确认：

```text
fetch("http://127.0.0.1:6000") → fetch failed; cause=bad port
```

目标 Windows 的 TCP dynamic port range 为 `1024–15000`，其中包含 `6000`。因此 `server.listen(0, "127.0.0.1")` 仍可能分配到 6000；helper 会把它作为 safe URL 交给 `fetch`，所有 `withServer()` 测试会在 HTTP handler 前报 `fetch failed: bad port`。deadline、caller cancellation 和 SSE 的既有断言在该轮将不能验证各自的语义。

**必须修复**：

1. 以 Fetch Standard bad-port table 为唯一规范来源：补入 `6000`，将 `0` 作为标准表成员（或保留独立边界拒绝但不能再声称 set 本身 exact equality），并移除/单独说明非标准 `4333`。推荐使 policy set 与表精确相等，再由范围检查保护 `> 65535`。
2. 更新 exact-equality/table-driven regression，明确断言 `6000` 为 false；保留 `0`、`5060`、`5061`、`6667`、`10080`、`65536` 和正常端口的边界覆盖。retry regression 应继续使用真实 `http.Server`，在返回 forbidden allocation 后断言 close 后才能再次 listen；不能退化为只断言数组。
3. 不得改写本报告或 [`review-response-0-7-1.md`](review-response-0-7-1.md)。应新建 `review-response-0-7-2.md`，如实记录 R72-1 的决定、实现和测试；重新运行完整验证后交由下一轮独立 review。

---

## 2. 已核验但不足以解除阻止的问题

- `5060`、`5061`、`6667`、`10080` 已在源码 policy 中，且当前 Node Fetch 均以 `bad port` 拒绝；本问题是遗漏 `6000`，不是对前四项的回退。
- `isFetchSafeTestPort(0)` 和 `isFetchSafeTestPort(65536)` 均为 false；在真实 `127.0.0.1` loopback ephemeral port 上 Fetch 成功，IPv4 bind 行为正确。
- 默认路径确实是 `listen(0, "127.0.0.1")` → inspect returned port → forbidden 时 `close()` → retry。`withServer()` 已将 listen/retry 和 run 包在 `try/finally`，并只在 `server.listening` 时 close；listen/retry 或 handler 异常后不会遗留已监听的 server。
- retry 回归并非只检查数组：它使用真实 `http.Server`，首次 listener 返回模拟的 forbidden `5060`，随后验证 helper 已关闭并重新 listen（两次 attempts）后才返回 safe port。该测试的 server lifecycle 覆盖有效，但因为 policy/table regression 漏掉 `6000`，不能证明完整 forbidden-port 策略。
- 原有 LLM 语义仍由 focused tests 实际覆盖并通过：SSE delta/invalid event、非泄露 HTTP error、deadline、caller cancellation、mid-stream cancellation 和 mid-stream deadline；不过一旦分配到遗漏的 6000，上述 HTTP-handler 语义测试会先因 bad port 失败。

---

## 3. 文档与台账核验

- [`review-response-0-7-1.md`](review-response-0-7-1.md) 对 `5060/5061`、0/65536 边界、cleanup 和其记录的 120/120 测试结果的描述可由本轮复现；但其“当前完整 bad-port table”“exact equality”及“R71-1 已修正”的结论不准确，因为缺少 `6000` 且 set 有额外 `4333`。按版本化流程不修改历史回复；R72-1 的后续答复应位于新文件 `review-response-0-7-2.md`。
- [`code-review-commit.md`](code-review-commit.md) 中 `ed9c11c` 的历史记录与其当时的 R71-1 状态相符，但尚未覆盖本次目标 `147f76b`。本报告提交时会在同一 docs-only change 追加该完整 SHA、报告路径和未批准状态。

---

## 4. 独立验证证据

所有命令在目标 worktree `D:\work\tools\git plugin\.claude\worktrees\agent-a6fea5ad466242226`、提交 `147f76b6e9c8d240ebd9b78cdd617a59dd7533e8` 上执行；本 reviewer 未修改目标实现。

| 命令 / 方法 | 结果 |
| --- | --- |
| Fetch Standard 当前 bad-port table 与源码 set 逐项比较 | 标准 83 项；源码 82 项；缺 `0, 6000`，多 `4333`。其中 0 已由 predicate 拒绝，6000 会漏过。 |
| Node Fetch `127.0.0.1:5060/:5061/:6000/:6667/:10080` | 五者均为 `cause=bad port`；确认 R72-1。 |
| `netsh int ipv4 show dynamicport tcp` | `1024–15000`（13977 ports），包含 6000。 |
| IPv4 loopback probe | `server.listen(0, "127.0.0.1")` 实际 Fetch 返回预期内容。 |
| `npm run typecheck` | 通过。 |
| `npx tsx --test test/llmClient.test.ts` 连续 12 次 | 每次 **8/8 通过**；覆盖现有 retry、deadline/cancel/SSE 语义，但不能覆盖漏掉的 6000 policy。 |
| `npm test` | **120/120 通过**，约 404 秒。 |
| `npm run compile` | 通过。 |
| `node --check media/main.js` | 通过。 |
| `git diff --check 147f76b^..147f76b` | 通过，无空白错误。 |
| target worktree `git status --short` | 无输出，干净。 |

---

## 5. 后续要求

1. Agent A 应在新的 implementation commit 中完成 R72-1，且不得修改既有 `code-review-0-7-1.md`、本报告或历史回复。
2. Agent A 应新建 [`review-response-0-7-2.md`](review-response-0-7-2.md)，逐项说明 R72-1 的整改、精确测试证据和最终验证结果。
3. 整改 implementation commit 不会自动视为已评审；须由新的独立版本化 review 覆盖后才可解除 0.7 发布阻止。
