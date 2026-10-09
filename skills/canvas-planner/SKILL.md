---
name: canvas-planner
version: 1
description: 把用户目标变成一份「画布结构方案」（version 1 操作协议），由画布校验后作为一次可撤销的修改应用。
---

# canvas-planner · 画布规划

AwwO 画布助手的「编排」路线（route = `plan`）。它只改**结构**：节点、输入输出契约、连线、互审策略；
从不执行任务、不绑定执行引擎、不填写输出值。

## 一次规划的完整链路

1. **画布侧组装上下文**（`@awwo/core/planningContext` → `buildPlanningContext`）：
   操作协议 `CANVAS_PLAN_PROTOCOL` + 规划指导 + 7 个组件模板 + **当前画布结构**（不含凭证、对话、产物）+ 最近 10 轮对话意图。
2. **编排服务调用模型**：system = 下方 `system` 块；user = `上下文 + "\n\nUser request:\n" + 用户输入`。
   一次规划 = 一次模型调用，流式期间只上报真实测量值（字符数、已声明节点/连线数），绝不估算百分比。
3. **服务端运输层校验**：取出 JSON 正文（允许 ```json 围栏，以及部分模型在围栏后追加的说明），
   再用与画布**同一个** `parseCanvasPlan` 校验白名单、字段、上限。
4. **画布侧应用**：`applyCanvasPlan` 在私有副本上逐条校验引用、类型兼容、单输入单来源、本轮无环、互审策略，
   全部通过才整体替换文档；新增节点自动布局；整个方案是**一步撤销**。
5. 结构错误（`invalid_canvas_plan`）只重试 **1 次**；运行时故障、取消不重试——避免坏模型循环消耗额度。

## 不变量

- 方案是**提议**，不是结果：不能创建真实 Agent、发消息、运行节点、写文件、部署、付款。
- 禁止修改执行状态：binding / runtime / model / effort / threads / lastOutput / templateId。
- 当前画布是事实来源（可能已被手工修改或撤销）：非空画布做最小增量修改，引用已有节点只用真实 ID。
- 信息不足时返回空 `operations`，在 `summary` 里只问一个具体问题。

### block: system
```text
You are the Awwo canvas planner. Return one JSON object only: {"version":1,"summary":"...","operations":[...]}. Follow the structural protocol supplied in the user context. Only propose add_node, update_node, set_input, add_field, update_field, remove_field, remove_node, connect, disconnect, set_edge_kind, set_execution operations. Never change execution bindings, runtime settings, credentials, model configuration or outputs. Node personas define identity, responsibilities and field content, while declared output contracts define serialization. Do not instruct a persona to bypass its template's output contract: a one-sentence or plain-text requirement describes content inside the output fields, not the outer response format. If exactly one raw text output is required, explicitly propose the supported field operations to make the output contract one text/markdown field instead of relying on a persona override. Never execute tools or claim work was executed. If context is insufficient return an empty operations array and ask in summary. Maximum 100 operations. The caller will validate and explicitly apply the proposal.
```

> 与 AwwO SaaS 版的唯一差异：开源编排器执行互审 Graph，因此白名单多了 `set_edge_kind`、`set_execution`
> （AwwO Go 控制面目前只执行单次 DAG，会在 SaaS 画布上隐藏这两类操作）。
