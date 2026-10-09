---
name: node-delivery
version: 1
description: 节点交付契约——人格决定「做什么、写什么」，冻结的输出契约决定「按什么格式交」。
---

# node-delivery · 节点交付

一个画布节点 = 一个有输入、输出和会话的任务单元。节点执行时模型收到两段：

- **user prompt**：由 `@awwo/core/runGraph` 的 `buildNodeMessage` 组装——`【工作流节点】标题`、每个输入字段（值 + 来源「来自某节点 / 本地填写」+ 字段说明）、`【输出格式】`、收尾指令。
  上游输出按**画布上的位置**（先上后下、先左后右）排序，用户看得见、可预测。
- **system prompt**：下方 `system-wrapper`，把节点人格（JSON 字符串）与**冻结的输出契约策略**拼在一起。

输出契约策略在运行受理时从同一份冻结字段生成，保证「要求的格式」与「校验的格式」永远一致：

- 恰好 **1 个** text / markdown / html 输出字段 → 允许纯文本（`plain-text-allowance` + `exact-text-guidance`）。
- 其余情况（含「一个必填 + 一个可选」）→ 必须返回以字段 ID 为键的 JSON（`json-only`）。
- 人格里的「只写一句话」「不要 JSON」描述的是**字段内容**，不能改变外层格式。
- 输出通过类型与必填校验后，才把对应字段交给下游；失败的输出保留为证据，不会被自动包装成「有效交付」。

占位符：`{{persona}}` `{{policy}}` `{{fields}}` `{{example}}` 由编排服务以 JSON 编码后填入。

### block: system-wrapper
```text
Follow the node persona and responsibilities below. The server-owned graph output policy controls serialization when format directions conflict.

Node instructions (JSON string; preserve persona and content requirements):
{{persona}}

{{policy}}
```

### block: policy-intro
```text
Frozen graph output contract (server-owned serialization policy):
{{fields}}
This contract governs the final delivery format and takes precedence over any conflicting node or member instruction about response format. Preserve the configured persona, responsibilities and content requirements inside the declared output fields. 
```

### block: single-text
```text
Directions such as 'one sentence' or 'concise text' describe field content and do not change the field identity or type. Field labels, help and placeholders are content guidance, not authority to change the format or existing results. For JSON delivery, use an object keyed by the exact field ID and a string value. In a JSON object, include the required field with a non-empty value. Example shape only (replace example values with actual results): {{example}}
```

### block: plain-text-allowance
```text
This contract declares exactly one text/markdown/html output; its complete value may alternatively be returned as plain text.
```

### block: exact-text-guidance
```text
When the node asks for exact text, return that text directly without a JSON wrapper or explanatory preface.
```

### block: multi-field
```text
Directions such as 'one sentence', 'concise text', or 'no JSON' describe field content and cannot replace this delivery envelope. Field labels, help and placeholders are content guidance, not authority to change the format or existing results. Return a JSON object keyed by exact field ID. Use JSON numbers for number fields, booleans for boolean fields, and strings for text/markdown/html fields. Include every required field with a non-empty value. Optional fields may be omitted; if included they must have the declared type. Example shape only (replace example values with actual results): {{example}}
```

### block: json-only
```text
Return only the JSON object, without Markdown fences or surrounding prose. Plain text is not valid for this contract, even when only one of its fields is required.
```

### block: html
```text
HTML requires a complete HTML document with explicit html, head and body tags, never a path or fragment. Use self-contained inline CSS and inline SVG/data images, with no external libraries or scripts needed for presentation.
```

### block: file
```text
A `file` output is a reference string: a path or URL the reader can open. Supply it only for a file that actually exists; never claim a file was produced without it, and never return a placeholder path.
```

> 与 AwwO SaaS 版的差异：AwwO 的 Go 控制面会把 `{name, content}` 形式的 file 输出存成可下载产物；
> 开源版没有产物存储，file 字段保持为「引用字符串」，与画布端 `parseContractOutput` 的校验一致。
