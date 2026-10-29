# dsh-withdraw

给 [DeepSeek Harness](https://github.com/deepseek-ai)（下称 DSH）用的插件：**右键已发出的消息，就可以修改或撤回它**。

- 右键一条用户消息 → 弹出「修改 / 撤回」两个选项。
- 动手之前先让模型停下来（暂停思考），改完再让它按新内容继续。
- 撤回之后不再继续生成，对话就停在被撤回的位置。

```
┌──────────────────────────────┐
│ 你：帮我看看这个报错            │  ← 在这里右键
│ ──────────────────────────── │
│   修改        撤回            │
└──────────────────────────────┘
```

## 行为

| 操作 | 对话里发生什么 | 模型侧发生什么 |
| --- | --- | --- |
| **撤回** | 这条消息以及它之后的所有内容一起消失，原地留下一条 `（已撤回）` | 不再继续生成，思考结束 |
| **修改** | 这条消息原地变成新正文，它之后的旧回答被清掉 | 先暂停，保存后读取新正文重新回答 |

两个操作都作用于「点了右键的那一条」及其之后的内容，**不会**新开一个会话，也不会 fork 出新对话——用的就是当前会话线的历史替换语义。

## 安装

插件是一个标准的 DSH bundle（`package.json` + `cordis.patch.yml` + Host 半 `index.js` + Client 半 `client.js`）。

```text
1. 把本目录放到任意位置，例如 D:\deepseek harness\dsh-withdraw
2. 让 DSH 安装这个 bundle：plugin_manager(install_bundle, target = <上面这个绝对路径>)
3. 刷新 Web UI
```

装好之后，右键任意一条用户消息即可看到菜单。卸载用 `plugin_manager(set_plugin, target = "include:dsh-withdraw", enabled = false)`，或直接移除该 bundle。

要求：DSH `0.2.1-rc.3` 及以上（Host 与 Client 半同版本），Node `^22.19.0 || >=24`。

## 它是怎么做到的

DSH 的会话日志是 append-only 的，没有「删除历史」的接口；能改写历史的只有 Session 自带的 **surface 替换**语义：追加一条事件，并用 `surfaceOp: {op: 'replace', startSeq, endSeq}` 让 `[startSeq, endSeq]` 这段节点整体让位给它。

所以：

- **撤回** = 用一条 `（已撤回）` 替换「目标消息 … 当前最后一条节点」，这条消息及其之后的内容一并从 surface 里消失。
- **修改** = 用一条 `（已修改）` 完成同样的替换，然后 `agent.followup()` 把新正文排进 inbox；宿主会把这条 inbox 消息再追加一行到日志里，等它出现后再做第二次替换，把两行合并成一行——界面上始终只有一条消息。
- **暂停** = `agent.cancel({ kind: 'user' })`（和停止按钮同一条路径，但不保留 inbox）。被取消的流会把已经写出来的部分存成一条 `assistant/message { interrupted: true }`，半段内容原样留在对话里。
- **继续** = `agent.followup()` 补一条短消息，让模型接着往下写。平台没有「让轮次继续运行、只中止步骤」的原语，唤醒一轮只能靠 inbox 里的用户消息。

改写过程会因为宿主还在写日志而失败（`surface replace: sourceEventSeqs must include every shadowed surface node`），所以每次改写都是「重新取快照 → 定位 → 替换」的原子尝试，失败重试；替换之后又冒出新节点时，从刚换出来的那个节点继续往后折。

## 斜杠命令

右键菜单背后是四条普通命令，也可以直接在输入框里敲：

| 命令 | 作用 |
| --- | --- |
| `/withdraw [json]` | 撤回。`json` 可省略，省略时作用于最后一条用户消息；也可写 `{"turn": 3}` 或 `{"seq": 1225}` |
| `/revise [json]` | 修改。需要 `{"text": "新正文"}`，控制台返回结果只用来报告错误 |
| `/withdraw-pause` | 只暂停：立刻停下正在生成的回答，不改写任何内容 |
| `/withdraw-resume` | 从暂停处接着把被打断的那段答完 |

命令的 `command/run`、`command/done` 行默认不会在对话里显示（客户端把这几条命令渲染成空白行，只有出错才显示一行小字）。

## 已知取舍

- **暂停是「取消」实现的**。平台没有真正的 suspend/resume，所以「暂停」的准确含义是「停在这里，已经写出来的半段留着」。恢复靠补一条消息重新唤醒，因此会多出一条用户气泡 `（继续）`。
- **撤回会留下一条 `（已撤回）` 占位行**。surface 替换必须有一个替代节点（`nodes.splice(start, len, newSeq)`），无法替换成空，所以那条消息之后的内容整体消失，但会留下这一行作为标记。
- 只处理用户消息。助手消息、工具结果不在这个插件的目标范围内。
- 日志：改写时会往 `debug.log` 写排查信息（路径可用环境变量 `DSH_WITHDRAW_LOG` 覆盖，默认在插件目录下）。发布包里不含该文件。

## 开发

```bash
node --check index.js
node --check client.js
node test/logic.test.mjs     # 纯 node 的假 ctx / 假 session / 假 agent 回归测试
```

`test/logic.test.mjs` 不依赖 DSH 运行时：它直接 `import` Host 半，用假的 ctx、session、agent 覆盖定位、撤回、修改、合并、暂停、恢复、以及「只剩系统提示时拒绝改写」等场景。

## English

A DeepSeek Harness plugin that lets you **edit or withdraw an already-sent message** by right-clicking it. It pauses the model before rewriting (the platform has no suspend primitive, so "pause" means cancelling the turn while keeping the partial answer), rewrites the session's surface by replacing the target message and everything after it, and resumes generation with the new text.

Commands: `/withdraw`, `/revise`, `/withdraw-pause`, `/withdraw-resume`. Requires DSH `0.2.1-rc.3+` and Node `^22.19.0 || >=24`. See the Chinese sections above for behavior details and caveats.

## License

MIT