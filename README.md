# 飞书知识库问答机器人（DeepSeek）

在飞书私聊或群里 @机器人 提问，机器人会**并行**检索以下资料，交给 DeepSeek 生成答案，并 **@相关负责人**：

| 来源 | 说明 |
| --- | --- |
| 飞书知识库 | 把配置的知识空间整棵树同步到本地（增量，按文档编辑时间），本地 BM25 检索；回答附文档链接 |
| 消息里贴的文档链接 | `/wiki/`、`/docx/` 链接会被直接读取，不要求在已配置空间内 |
| 项目目录 | `bot.config.json` 可配置多个目录；Git 仓库用 `git grep`，普通目录用遍历检索 |
| 历史消息 | 群里读取飞书最近 N 条消息 + 本地保存的群问答记录；私聊保留 2 小时会话 |

收到消息会先打一个表情（默认 `OnIt`）表示正在处理。基于飞书官方 SDK 长连接，无需公网 IP。

## 1. 飞书应用配置

在 https://open.feishu.cn/app 创建企业自建应用并添加「机器人」能力，然后开通以下**应用身份**权限：

- 消息：`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`、`im:message:readonly`、`im:message.group_msg`、`im:message:send_as_bot`、`im:message.reactions:write_only`（表情，可选）
- 知识库：`wiki:wiki:readonly`、`docx:document:readonly`、`docs:doc:readonly`（旧版文档，可选）
- 通讯录（可选，用于按邮箱配置负责人、显示文档负责人姓名）：`contact:user.id:readonly`、`contact:user.base:readonly`

再做两件事：

1. **把应用加入知识空间**：知识库 → 设置 → 成员设置 → 添加应用为成员（可阅读即可）。否则同步会报错码 `99991672` / `131006`。
2. 「事件与回调」选择**长连接**，添加 `im.message.receive_v1`，创建版本并发布；可用范围包含使用者。

## 2. 本地配置

双击 `start.bat`，第一次会生成并打开 `.env` 和 `bot.config.json`。

`.env`：飞书 App ID / Secret 和 DeepSeek Key（`AI_BASE_URL` 默认 `https://api.deepseek.com/v1`，`AI_MODEL` 默认 `deepseek-chat`）。

`bot.config.json`：

```jsonc
{
  "wiki": [
    // scope: "space" 同步整个知识空间；"subtree" 只同步该节点及其子文档
    { "name": "OnePiece 知识库", "url": "https://xxx.feishu.cn/wiki/<节点token>", "scope": "space" }
  ],
  "projects": [
    // 路径用正斜杠；guides 为每次都会带上的项目说明文档；excludes 追加排除目录
    { "name": "OnePiece", "root": "D:/OnePiece/onepiece", "guides": ["Client/Assets/MD~/README.md"], "excludes": ["Packages"] }
  ],
  "codex": {
    // AI_PROVIDER=codex 时，Codex 可只读查看的项目目录（在第一个目录里运行）；留空则 Codex 只用提示里的资料
    // CICD 打包分析不会查看目录（打包机最多等 120 秒）
    "projectDirs": ["D:/OnePiece/onepiece"]
  },
  "routing": {
    "notifyDocOwners": true,   // 命中知识库文档的负责人也作为候选
    "maxNotify": 3,
    "rules": [
      {
        "name": "打包 / CICD",
        "keywords": ["打包", "cicd"],          // 问题包含任一关键词
        "paths": ["Tools/Build"],              // 或命中的代码路径以此开头
        "wiki": ["打包"],                      // 或命中的知识库文档路径包含此文字
        "users": [{ "name": "张三", "openId": "ou_xxx" }, { "email": "lisi@example.com" }],
        "dm": false                            // true：除了群里 @，还私信推送问题和答案
      }
    ]
  }
}
```

**相关人怎么选**：规则命中的人 + 命中文档的负责人组成候选，DeepSeek 判断谁真正需要跟进，在群回复末尾 @ 他们；提问人自己不会被 @。模型没给出判断时回退为只通知规则命中的人。私聊提问时只在答案末尾列出建议联系人。

open_id 可在飞书管理后台或通过 `lark-cli contact` 查询；也可以只填邮箱（需要通讯录权限）。

## 3. 运行

```powershell
npm run check   # 检查配置和项目目录，不连接飞书
npm run sync    # 只同步一次知识库并退出；可加关键词试检索：npm run sync -- 打包
npm test        # 本地模拟测试
npm start       # 启动机器人
```

聊天指令：`/help`、`/sync`（立即同步知识库）、`/status`、`/reset`（清空当前上下文）。

## 4. 文档变更监测（docWatch）

移植自「飞书文档变更通知机器人」（原 Python 版，见交接文档）。随机器人启动，启动时先检查一次，之后每小时 `checkMinutes`（默认 :00 / :30）检查：

1. 读知识库节点的编辑时间，没变就跳过；10 分钟内刚编辑过的先不推（`staleMinutes`，避免推半成品）。
2. 拉取 docx 全部 block，按 block_id 与本地基线比对，精确到段落的新增 / 修改 / 删除。
3. 归因：人工确认 > 跨系统主题（`topics`）> DeepSeek 判断 > 关键词与角色规则；模型不可用时自动降级为关键词，并每天给维护者发一次告警。
4. 按负责人分组私聊发送。**只有全部发送成功才推进基线**，失败的下一轮重试。
5. 归不上的变更私聊问维护者（`clarify.asker`），回复数字（如 `1,7`）即记住该标题的归属并补发；与已有记录冲突时转给决策人（`arbiter`）。
6. 每天 `digest.time` 把当天发出的通知汇总给 `digest.to`。

配置在 `bot.config.json` 的 `docWatch`，归因规则文件 `doc-watch.mapping.json` 与原项目的 `mapping.json` 格式相同（可直接拷贝）。

**open_id 必须换绑**：飞书的 open_id 按应用区分，原 mapping.json 里的 open_id 属于旧应用，当前机器人发不出去。请每位负责人（以及决策人、日报接收人）私聊机器人发送：

```
/bind 自己的姓名
```

其他私聊指令：`取消推送` / `恢复推送`。另外需要开通 `im:message:send_as_bot`，且应用可用范围覆盖所有接收人（否则报 230013）。

```powershell
npm run watch                       # 立即检查一次（首次只建基线，不发消息）
npm run watch -- --dry-run --force  # 只打印将要发送的内容，不发送、不更新基线
npm run watch -- --digest --dry-run # 预览今天的日报
```

运行数据在 `data/doc-watch/`：`snapshots/` 基线、`learned.json` 人工确认的归属、`bindings.json` 绑定关系、`notify-log.jsonl` 发送记录、`escalations.jsonl` 升级记录。

⚠️ 新旧两套不要同时运行，否则同一变更会推送两次：启用本模块前请停掉原机器上的 `FeishuDocBot` 计划任务（`schtasks /Delete /TN "FeishuDocBot" /F`）。

## 5. 数据与安全

- 知识库缓存在 `data/wiki/`，群问答记录在 `data/group-context/`，都只在本机；`.env`、`bot.config.json`、`data/` 已被 Git 忽略。
- 每次提问会把问题、相关知识库片段、代码片段和群消息发给配置的 AI 服务，可能产生费用。
- 同步失败时保留已有缓存；只有完整同步成功时才删除已不存在的文档。
- 日志不打印密钥和聊天正文。
