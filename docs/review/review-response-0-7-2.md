## 0-7-2 回复（对应 `code-review-0-7-2.md`）

### 基线与结论

- 评审基线：v0.6.3 `f4045ea9163014389ef0406cae4d56bd527d9ddf`；本报告复核的前次整改提交为 `147f76b6e9c8d240ebd9b78cdd617a59dd7533e8`。
- 本回复及 R72-1 整改将提交为新的修正 commit。该 commit 不因本回复自动成为已评审 commit，仍须由下一份独立版本化 code review 覆盖后才可解除发布阻止。
- R72-1 已修正；未修改 `code-review-0-7-2.md` 或任何历史 review/response。

### R72-1 — Fetch Standard safe-port policy 遗漏 6000

- [x] **已修正。** `test/llmClient.test.ts` 现以 Fetch Standard [bad-port table](https://fetch.spec.whatwg.org/#port-blocking) 为唯一 policy source：加入 `6000` 和标准成员 `0`，移除非标准的 `4333`。集合现在与当前标准表精确相等；`isFetchSafeTestPort()` 仍以 `0..65535` 范围检查拒绝不可能由 TCP listen 返回的 `65536`。
- [x] **完整策略和边界回归已更新。** 测试以标准完整 83 项的数组与 helper set 做 exact equality，并逐项断言拒绝。还显式断言 `5060`、`5061`、`6000`、`6667`、`10080`、`0` 和 `65536` 均为 `false`，正常端口 `18080` 为 `true`。
- [x] **真实 retry 生命周期测试保留并强化。** 测试用真实 `http.Server` 的首次 listener 模拟 `6000` 分配；第二次 `listen` 前必须观察到第一次 listener 的 `close`，再确认成功安全监听。这覆盖 listen → inspect → close → retry 的实际资源生命周期，而不是仅检查端口数组。
- [x] **异常清理保持。** `withServer()` 将 listener 分配/retry 和测试回调置于 `try/finally` 中，异常时若 server 仍在监听则关闭；正常路径也关闭。
- 测试证据：`npx tsx --test test/llmClient.test.ts` 连续 12 次均为 8/8 通过；`npm test` 为 120/120 通过，约 409 秒。最终命令与结果见下表。

### 最终验证

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npx tsx --test test/llmClient.test.ts`（连续 12 次） | 每次 8/8 通过 |
| `npm test` | 120/120 通过，约 409 秒 |
| `npm run compile` | 通过 |
| `node --check media/main.js` | 通过 |
| `git diff --check` | 通过，无空白错误 |

R72-1 的新修正提交及本回复仍待独立 reviewer 复核；未推送、未打 tag。
