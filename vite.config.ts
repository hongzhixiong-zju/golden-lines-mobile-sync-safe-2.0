import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs/promises';
import path from 'node:path';

const storePath = path.resolve(process.cwd(), 'data/vocab-store.json');
const AI_ANNOTATION_VERSION = 'ai-annotation-v4';

function localStorePlugin() {
  return {
    name: 'local-vocab-store',
    configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use('/api/store', async (req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        try {
          if (req.method === 'GET') {
            await fs.mkdir(path.dirname(storePath), { recursive: true });
            try {
              res.end(await fs.readFile(storePath, 'utf8'));
            } catch {
              res.end(JSON.stringify({ version: 1 }));
            }
            return;
          }

          if (req.method === 'PUT') {
            const chunks: Buffer[] = [];
            req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            req.on('end', async () => {
              await fs.mkdir(path.dirname(storePath), { recursive: true });
              const raw = Buffer.concat(chunks).toString('utf8');
              JSON.parse(raw);
              await fs.writeFile(storePath, `${JSON.stringify(JSON.parse(raw), null, 2)}\n`, 'utf8');
              res.end(JSON.stringify({ ok: true }));
            });
            return;
          }

          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }));
        }
      });
      server.middlewares.use('/api/ai-annotations', async (req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        try {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
          }

          const store = JSON.parse(await fs.readFile(storePath, 'utf8'));
          const bodyText = await readRequestBody(req);
          const body = bodyText ? JSON.parse(bodyText) : {};
          const targetIds = Array.isArray(body.ids)
            ? body.ids.map((id: unknown) => Number(id)).filter((id: number) => Number.isFinite(id))
            : [];
          const settings = store.settings ?? {};
          const apiKey = String(settings.aiApiKey ?? '').trim();
          if (!apiKey) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: '请先填写 AI API Key' }));
            return;
          }

          const candidates = targetIds.length
            ? (store.vocab ?? []).filter((item: any) => targetIds.includes(item.id))
            : (store.vocab ?? []).filter(shouldAnnotate).slice(0, 8);
          const pending = candidates.filter((item: any) => targetIds.length ? true : shouldAnnotate(item));
          if (pending.length === 0) {
            res.end(JSON.stringify({ updated: 0 }));
            return;
          }

          const annotations = validateAnnotations(await requestAiAnnotations({
            apiKey,
            baseUrl: String(settings.aiApiBaseUrl || 'https://api.openai.com/v1'),
            model: String(settings.aiApiModel || 'gpt-4o-mini'),
            vocab: pending
          }));

          store.vocab = store.vocab.map((item: any) => {
            const annotation = annotations.find((candidate: any) =>
              (candidate.id && item.id === candidate.id) ||
              String(candidate.word ?? '').toLowerCase() === String(item.word ?? '').toLowerCase()
            );
            return annotation ? applyAnnotation(item, annotation) : item;
          });
          store.updatedAt = new Date().toISOString();
          await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
          res.end(JSON.stringify({ updated: annotations.length }));
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }));
        }
      });
      server.middlewares.use('/api/word-example', async (req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        try {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
          }
          const body = JSON.parse(await readRequestBody(req));
          const word = String(body.word ?? '').trim();
          if (!word) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: '缺少单词' }));
            return;
          }
          const store = JSON.parse(await fs.readFile(storePath, 'utf8'));
          const settings = store.settings ?? {};
          const apiKey = String(settings.aiApiKey ?? '').trim();
          if (!apiKey) {
            res.end(JSON.stringify({
              text: `I want to learn the word ${word}.`,
              translationZh: `我想学习 ${word} 这个词。`
            }));
            return;
          }
          res.end(JSON.stringify(await requestWordExample({
            apiKey,
            baseUrl: String(settings.aiApiBaseUrl || 'https://api.deepseek.com'),
            model: String(settings.aiApiModel || 'deepseek-v4-flash'),
            word
          })));
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }));
        }
      });
    }
  };
}

function readRequestBody(req: import('node:http').IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function shouldAnnotate(item: any) {
  return item.aiAnnotationVersion !== AI_ANNOTATION_VERSION ||
    !hasChinese(item.aiMeaningZh) ||
    !item.aiPartOfSpeech ||
    !item.aiPhonetic ||
    !Array.isArray(item.aiOtherMeanings) ||
    item.aiOtherMeanings.length === 0 ||
    !item.aiOtherMeanings.every((sense: any) => hasChinese(sense?.meaningZh)) ||
    !Array.isArray(item.aiRootFamily) ||
    item.aiRootFamily.length === 0 ||
    !item.aiRootFamily.every((entry: any) => entry?.word && entry?.partOfSpeech && hasChinese(entry?.meaningZh)) ||
    !hasChinese(item.aiNote) ||
    !(item.examples ?? []).every((example: any) => hasChinese(example.translationZh));
}

function applyAnnotation(item: any, annotation: any) {
  return {
    ...item,
    aiMeaningZh: annotation.meaningZh,
    aiPartOfSpeech: annotation.partOfSpeech,
    aiPhonetic: annotation.phonetic,
    aiOtherMeanings: annotation.otherMeanings ?? [],
    aiRootFamily: annotation.rootFamily ?? [],
    aiNote: annotation.note,
    aiAnnotationVersion: annotation.annotationVersion ?? AI_ANNOTATION_VERSION,
    examples: annotation.examples?.length ? annotation.examples : item.examples,
    updatedAt: new Date().toISOString()
  };
}

async function requestAiAnnotations({
  apiKey,
  baseUrl,
  model,
  vocab
}: {
  apiKey: string;
  baseUrl: string;
  model: string;
  vocab: any[];
}) {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            '你是英语词库注释助手。只返回合法 JSON 对象，不要 Markdown，不要解释。',
            `annotationVersion 必须是 ${AI_ANNOTATION_VERSION}。`,
            '返回顶层格式必须是 {"annotations":[...]}。',
            '每个词必须输出：id, word, meaningZh, partOfSpeech, phonetic, otherMeanings, rootFamily, note, examples, annotationVersion。',
            '所有 meaningZh、note、translationZh 必须是中文。禁止把英文释义原样放进 meaningZh。',
            'meaningZh 写 2-4 个中文短释义，用顿号分隔，例如“选择、替代方案、可选项”。',
            'partOfSpeech 使用英文基本词性，例如 noun、verb、adjective、adverb。',
            'phonetic 使用 IPA，美式优先；不确定也要给常见读音。',
            'otherMeanings 至少给 2 项常见其他意思；每项格式为 {"partOfSpeech":"noun","meaningZh":"中文含义"}。',
            'rootFamily 至少给 2 项常用同词根/派生词；每项格式为 {"word":"...","partOfSpeech":"verb","meaningZh":"中文含义"}。',
            'note 必须给 1 句中文学习提示，说明原句语境或常见搭配。',
            'examples 必须保留每个原 text/source/addedAt/quoteId，并补完整中文 translationZh。',
            '如果某词确实没有明显其他意思或同根词，也要给最接近的常见派生/相关词，不要返回空数组。'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            annotations: vocab.map((item) => ({
              id: item.id,
              word: item.word,
              quoteText: item.quoteText,
              meaningZh: item.meaningZh,
              partOfSpeech: item.partOfSpeech,
              phonetic: item.phonetic,
              note: item.note,
              examples: item.examples
            }))
          })
        }
      ]
    })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`AI 注释接口失败：${response.status}${formatApiError(detail)}`);
  }
  const data = await response.json() as any;
  const content = String(data.choices?.[0]?.message?.content ?? '');
  const parsed = JSON.parse(stripJsonFence(content));
  const annotations = Array.isArray(parsed) ? parsed : parsed.annotations;
  if (!Array.isArray(annotations)) {
    throw new Error('AI 注释接口没有返回 annotations 数组');
  }
  return annotations;
}

async function requestWordExample({
  apiKey,
  baseUrl,
  model,
  word
}: {
  apiKey: string;
  baseUrl: string;
  model: string;
  word: string;
}) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: '只返回 JSON：{"text":"简单英文例句","translationZh":"中文翻译"}。例句必须简单易学，能清楚展示目标词含义。'
        },
        {
          role: 'user',
          content: JSON.stringify({ word })
        }
      ]
    })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`AI 例句接口失败：${response.status}${formatApiError(detail)}`);
  }
  const data = await response.json() as any;
  const parsed = JSON.parse(stripJsonFence(String(data.choices?.[0]?.message?.content ?? '{}')));
  if (!parsed.text || !hasChinese(parsed.translationZh)) {
    throw new Error('AI 例句返回不完整');
  }
  return {
    text: String(parsed.text),
    translationZh: String(parsed.translationZh)
  };
}

function validateAnnotations(annotations: any[]) {
  const bad = annotations.find((item) =>
    !hasChinese(item.meaningZh) ||
    !item.partOfSpeech ||
    !item.phonetic ||
    !Array.isArray(item.otherMeanings) ||
    item.otherMeanings.length === 0 ||
    !item.otherMeanings.every((sense: any) => sense?.partOfSpeech && hasChinese(sense?.meaningZh)) ||
    !Array.isArray(item.rootFamily) ||
    item.rootFamily.length === 0 ||
    !item.rootFamily.every((entry: any) => entry?.word && entry?.partOfSpeech && hasChinese(entry?.meaningZh)) ||
    !hasChinese(item.note) ||
    !(item.examples ?? []).every((example: any) => hasChinese(example.translationZh))
  );
  if (bad) {
    throw new Error(`AI 返回不完整：${bad.word ?? bad.id ?? '未知词'}。请重试，或换 deepseek-v4-pro。`);
  }
  return annotations;
}

function hasChinese(value: unknown) {
  return /[\u4e00-\u9fff]/.test(String(value ?? ''));
}

function formatApiError(detail: string) {
  if (!detail.trim()) return '';
  try {
    const parsed = JSON.parse(detail) as any;
    const message = parsed.error?.message ?? parsed.message ?? detail;
    return `，${message}`;
  } catch {
    return `，${detail.slice(0, 180)}`;
  }
}

function stripJsonFence(content: string) {
  return content
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
}

export default defineConfig({
  base: './',
  plugins: [react(), localStorePlugin()],
  build: {
    rollupOptions: {
      input: 'index.html'
    }
  },
  server: {
    port: 5173
  }
});
