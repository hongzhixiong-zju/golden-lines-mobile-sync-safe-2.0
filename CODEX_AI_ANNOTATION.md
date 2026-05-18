# Codex AI 注释更新方法

词库的唯一可信数据源是：

```text
data/vocab-store.json
```

当前 AI 注释规则版本：

```text
ai-annotation-v4
```

用户说“给词库补 AI 注释”时，Codex 直接编辑 `data/vocab-store.json`，不要求用户导出、复制、粘贴或提供 API Key。

应用内也保留“用 API 更新 AI 注释”按钮。该按钮通过本地 Vite 服务端的 `/api/ai-annotations` 调用 OpenAI 兼容的 Chat Completions 接口，并按同一套 `ai-annotation-v4` 结构写回词库。Codex 命令更新和应用内 API 更新应保持字段格式一致。

## 更新原则

- 不覆盖原始词典字段：`meaningZh`、`partOfSpeech`、`phonetic`、`note`。
- UI 会优先显示 AI 字段，原始字段只作为最后的“原始词典参考”。
- 同一规则版本下，已经有 `aiAnnotationVersion: "ai-annotation-v3"` 的词卡不要重复更新。
- 只有以下情况才重写已有 AI 注释：
  - 用户明确要求重写；
  - 本文件的规则版本升级；
  - 词卡缺少必要 AI 字段。
- 每次写入 JSON 后必须递增根级 `version`，更新 `versionLabel` 和根级 `updatedAt`。

## 必填 AI 字段

每个更新过的词卡必须写入：

- `aiMeaningZh`：简洁中文含义，只给短释义，不写长句解释。例：`移民、迁移、人口流动`。
- `aiPartOfSpeech`：词典基本词性。例：`verb`、`noun`、`adjective`。
- `aiPhonetic`：IPA 音标，优先美式发音。
- `aiOtherMeanings`：其他常见意思数组，每项必须包含词性和中文含义。格式：`{"partOfSpeech":"noun","meaningZh":"迁徙；迁移"}`。没有就用 `[]`。
- `aiRootFamily`：常用同词根单词数组，每项必须包含单词、词性和中文含义。格式：`{"word":"migrate","partOfSpeech":"verb","meaningZh":"迁移；移居"}`。没有明确常用同根词就用 `[]`。
- `aiNote`：简短用法提示，1 句话即可。
- `aiAnnotationVersion`：当前规则版本，例如 `ai-annotation-v3`。
- `examples[].translationZh`：每个例句的完整中文翻译。

## 词形归并

如果用户保存的是明显变形，应把词卡主词 `word` 改成传统词典形式：

- 复数名词 -> 单数：`indicators` -> `indicator`
- 过去式/过去分词 -> 原形：`augmented` -> `augment`
- -ing 形式 -> 原形，除非该形式在原句中是固定名词术语：`forecasting` 可保留为 `forecasting`，因为 `forecasting model` 中它是领域常用名词性定语。
- 大写普通词 -> 小写：`Migration` -> `migration`，除非是专有名词不可拆。

保留原句在 `examples[].text` 里，不需要改原句。

## 含义写法

`aiMeaningZh` 要短，不要解释背景。

好：

```text
移民、迁移、人口流动
```

不好：

```text
在原句中是机构名 International Organisation for Migration 中的核心名词，指“移民、迁移、人口流动”。这里关注的是因冲突和自然灾害而被迫流离失所的人群。
```

背景、搭配、语境提示放进 `aiNote`，也要短。

## 示例

```json
{
  "word": "migration",
  "aiMeaningZh": "移民、迁移、人口流动",
  "aiPartOfSpeech": "noun",
  "aiPhonetic": "/maɪˈɡreɪʃən/",
  "aiOtherMeanings": [
    { "partOfSpeech": "noun", "meaningZh": "迁徙" },
    { "partOfSpeech": "noun", "meaningZh": "数据迁移" }
  ],
  "aiRootFamily": [
    { "word": "migrate", "partOfSpeech": "verb", "meaningZh": "迁移；移居" },
    { "word": "migrant", "partOfSpeech": "noun", "meaningZh": "移民；迁徙者" },
    { "word": "migratory", "partOfSpeech": "adjective", "meaningZh": "迁徙的；流动的" }
  ],
  "aiNote": "常用于人口、动物或数据从一处转移到另一处的正式语境。",
  "aiAnnotationVersion": "ai-annotation-v4"
}
```
