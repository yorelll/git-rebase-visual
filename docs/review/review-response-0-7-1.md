## 0-7-1 回复（对应 `code-review-0-7-1.md`）

### 基线与结论

- 评审基线：v0.6.3 `f4045ea9163014389ef0406cae4d56bd527d9ddf`；本报告复核的整改提交为 `ed9c11c9f7b886b90908d41071a284a4dac3f704`。
- 本回复及 R71-1 整改将提交为新的修正 commit。该 commit 不因本回复自动成为已评审 commit，仍须由下一份独立版本化 code review 覆盖后才可解除发布阻止。
- R71-1 已修正；未修改 `code-review-0-7-1.md`。

### R71-1 — Fetch forbidden-port safe helper 遗漏 5060/5061

- [x] **已修正。** `test/llmClient.test.ts` 的 shared `fetchForbiddenPorts` 已加入 `5060`、`5061`，并逐项与 Fetch/URL Standard 当前完整 bad-port table 核对。`isFetchSafeTestPort()` 还显式拒绝无效的 `0` 和大于 `65535` 的端口。
- [x] **完整策略回归已加入。** 回归测试对 helper 集合和完整标准端口列表进行 exact equality 断言，并逐项验证所有 forbidden port 都返回 `false`；其中明确覆盖 `5060`、`5061`、`6667` 与 `10080`。这避免仅针对本次遗漏端口的局部断言再次遗漏标准集合中的其他端口。
- [x] **资源清理保持且加固。** `listenOnFetchSafePort()` 继续遵循 listen → inspect → forbidden 时 `close` → retry 的流程；`withServer()` 现将 listen/retry 包含在 `try/finally` 中，因此 listen 或 retry 路径异常后若 server 仍处于 listening 状态也会关闭。正常执行完成同样保证关闭。
- 测试证据：`npx tsx --test test/llmClient.test.ts` 连续 12 次均为 8/8 通过；`npm test` 为 120/120 通过。最终命令和结果见下表。

### 最终验证

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npx tsx --test test/llmClient.test.ts`（连续 12 次） | 每次 8/8 通过 |
| `npm test` | 120/120 通过，约 382 秒 |
| `npm run compile` | 通过 |
| `node --check media/main.js` | 通过 |
| `git diff --check` | 通过，无空白错误 |

R71-1 的新修正提交及本回复仍待独立 reviewer 复核；未推送、未打 tag。
