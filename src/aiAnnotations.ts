import { normalizeStore, type AppStore } from './localStore';
import type { AppSettings, CodexAnnotation, VocabItem } from './types';

const AI_ANNOTATION_VERSION = 'ai-annotation-v4';

export function applyAiAnnotationsToStore(store: AppStore, annotations: CodexAnnotation[]) {
  store.vocab = store.vocab.map((item) => {
    if (!shouldUpdateAiAnnotation(item)) return item;
    const annotation = annotations.find((candidate) => {
      if (candidate.id && item.id === candidate.id) return true;
      const sameWord = item.word.toLowerCase() === candidate.word.toLowerCase();
      const sameQuote = !candidate.quoteText || item.quoteText === candidate.quoteText;
      return sameWord && sameQuote;
    });
    return annotation
      ? {
        ...item,
        aiMeaningZh: annotation.meaningZh,
        aiPartOfSpeech: annotation.partOfSpeech,
        aiPhonetic: annotation.phonetic,
        aiOtherMeanings: annotation.otherMeanings,
        aiRootFamily: annotation.rootFamily,
        aiAnnotationVersion: annotation.annotationVersion ?? AI_ANNOTATION_VERSION,
        aiNote: annotation.note,
        examples: annotation.examples?.length ? annotation.examples : item.examples,
        updatedAt: new Date().toISOString()
      }
      : item;
  });
}


export async function requestWordLookup(settings: AppSettings, word: string): Promise<CodexAnnotation> {
  if (!settings.aiApiKey.trim()) {
    throw new Error('Please enter an AI API Key in Settings first.');
  }
  const parsed = await requestJson(settings, [
    {
      role: 'system',
      content: [
        'You are an English-Chinese dictionary and vocabulary learning assistant. Return only valid JSON, no Markdown.',
        'Return exactly one object with: word, meaningZh, partOfSpeech, phonetic, otherMeanings, rootFamily, note, examples, annotationVersion.',
        'examples must be an array of objects. Each object must use exactly these keys: text and translationZh.',
        'examples[].text must be an English sentence containing the target word. examples[].translationZh must be the Chinese translation.',
        'Do not put the English example in translationZh. Do not use keys like sentence, example, textEn, english, translation, or zh.',
        'meaningZh, note, and examples.translationZh must be Chinese.',
        'meaningZh should include 2-4 concise Chinese meanings.',
        'phonetic should use IPA where possible.',
        'examples must include at least one simple English sentence and Chinese translation.',
        'otherMeanings should include at least 2 common senses.',
        'rootFamily should include at least 2 related words.'
      ].join('\n')
    },
    { role: 'user', content: JSON.stringify({ word }) }
  ], 0.2);
  const item = Array.isArray(parsed?.annotations) ? parsed.annotations[0] : parsed;
  if (!item?.word || !item?.meaningZh) throw new Error('AI lookup returned incomplete data.');
  return {
    word: String(item.word),
    meaningZh: String(item.meaningZh),
    partOfSpeech: item.partOfSpeech ? String(item.partOfSpeech) : undefined,
    phonetic: item.phonetic ? String(item.phonetic) : undefined,
    otherMeanings: Array.isArray(item.otherMeanings) ? item.otherMeanings : [],
    rootFamily: Array.isArray(item.rootFamily) ? item.rootFamily : [],
    note: item.note ? String(item.note) : undefined,
    examples: normalizeLookupExamples(item.examples, String(item.word)),
    annotationVersion: item.annotationVersion ?? AI_ANNOTATION_VERSION
  };
}

export async function requestAiAnnotationsForStore(store: AppStore, ids?: number[]) {
  const normalized = normalizeStore(store);
  const targets = ids?.length
    ? normalized.vocab.filter((item) => item.id && ids.includes(item.id))
    : normalized.vocab.filter(shouldUpdateAiAnnotation).slice(0, 8);
  if (targets.length === 0) return { annotations: [], updated: 0 };

  const annotations = await requestAiAnnotations(normalized.settings, targets);
  return { annotations, updated: annotations.length };
}

export async function requestWordExample(settings: AppSettings, word: string) {
  const apiKey = settings.aiApiKey.trim();
  if (!apiKey) return fallbackWordExample(word);

  const parsed = await requestJson(settings, [
    {
      role: 'system',
      content: 'Return only JSON with this shape: {"text":"a short simple English sentence","translationZh":"Chinese translation"}. The sentence must clearly demonstrate the target word.'
    },
    {
      role: 'user',
      content: JSON.stringify({ word })
    }
  ], 0.3);

  if (!parsed.text || !hasChinese(parsed.translationZh)) return fallbackWordExample(word);
  return {
    text: String(parsed.text),
    translationZh: String(parsed.translationZh)
  };
}

export async function requestWordLemma(settings: AppSettings, word: string) {
  const fallback = word.trim().toLowerCase();
  const apiKey = settings.aiApiKey.trim();
  if (!apiKey) return fallback;

  const parsed = await requestJson(settings, [
    {
      role: 'system',
      content: [
        'Return only JSON with this shape: {"lemma":"base_form"}.',
        'Convert the English input word to its dictionary headword/base form.',
        'Handle plural nouns, verb tenses, -ing forms, comparatives and superlatives.',
        'Return one lowercase English word only in lemma. Do not translate.'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({ word })
    }
  ], 0);

  const lemma = String(parsed.lemma ?? '').trim().toLowerCase();
  return /^[a-z][a-z'-]*$/.test(lemma) ? lemma : fallback;
}

export async function requestArticleTranslation(settings: AppSettings, text: string) {
  const apiKey = settings.aiApiKey.trim();
  if (!apiKey) return `中文解释：${text}`;

  const parsed = await requestJson(settings, [
    {
      role: 'system',
      content: 'Return only JSON with this shape: {"translationZh":"中文解释"}. Explain the selected English word or phrase in concise Chinese for article reading. Do not add Markdown.'
    },
    {
      role: 'user',
      content: JSON.stringify({ text })
    }
  ], 0.2);

  if (!hasChinese(parsed.translationZh)) throw new Error('AI translation returned incomplete data.');
  return String(parsed.translationZh);
}

async function requestAiAnnotations(settings: AppSettings, vocab: VocabItem[]): Promise<CodexAnnotation[]> {
  if (!settings.aiApiKey.trim()) {
    throw new Error('Please enter an AI API Key in Settings first.');
  }

  const parsed = await requestJson(settings, [
    {
      role: 'system',
      content: [
        'You are an English vocabulary annotation assistant. Return only valid JSON, no Markdown.',
        `annotationVersion must be ${AI_ANNOTATION_VERSION}.`,
        'Top-level format must be {"annotations":[...]}.',
        'Each annotation must include: id, word, meaningZh, partOfSpeech, phonetic, otherMeanings, rootFamily, note, examples, annotationVersion.',
        'All meaningZh, note, and translationZh values must be Chinese.',
        'meaningZh should contain 2-4 concise Chinese meanings separated by Chinese punctuation.',
        'partOfSpeech should use English labels such as noun, verb, adjective, adverb.',
        'phonetic should use IPA where possible.',
        'otherMeanings must contain at least 2 common senses as {"partOfSpeech":"noun","meaningZh":"中文含义"}.',
        'rootFamily must contain at least 2 related forms as {"word":"...","partOfSpeech":"verb","meaningZh":"中文含义"}.',
        'note must be one Chinese learning note about usage, context, or collocation.',
        'examples must preserve each input example text/source/addedAt/quoteId and add translationZh.'
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
  ], 0.2);

  const annotations = Array.isArray(parsed) ? parsed : parsed.annotations;
  if (!Array.isArray(annotations)) throw new Error('AI API did not return an annotations array.');
  return annotations.filter((item: CodexAnnotation) => item.word && item.meaningZh);
}

async function requestJson(settings: AppSettings, messages: Array<{ role: 'system' | 'user'; content: string }>, temperature: number) {
  const response = await fetch(`${settings.aiApiBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.aiApiKey.trim()}`
    },
    body: JSON.stringify({
      model: settings.aiApiModel || 'deepseek-v4-flash',
      temperature,
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      messages
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`AI API request failed (${response.status}): ${formatApiError(detail)}`);
  }

  const data = await response.json() as any;
  return JSON.parse(stripJsonFence(String(data.choices?.[0]?.message?.content ?? '{}')));
}

function normalizeLookupExamples(raw: unknown, word: string) {
  const examples = Array.isArray(raw) ? raw : [];
  const normalized = examples
    .map((example: any) => {
      const text = String(
        example?.text ??
        example?.sentence ??
        example?.example ??
        example?.textEn ??
        example?.english ??
        example?.en ??
        ''
      ).trim();
      const translationZh = String(
        example?.translationZh ??
        example?.translation ??
        example?.meaningZh ??
        example?.zh ??
        example?.chinese ??
        ''
      ).trim();
      return text ? { text, translationZh, addedAt: new Date().toISOString() } : null;
    })
    .filter(Boolean) as Array<{ text: string; translationZh?: string; addedAt: string }>;

  if (normalized.length > 0) return normalized;
  return [{
    text: 'I want to learn the word ' + word + '.',
    translationZh: '我想学习 ' + word + ' 这个词。',
    addedAt: new Date().toISOString()
  }];
}

function fallbackWordExample(word: string) {
  return {
    text: `I want to learn the word ${word}.`,
    translationZh: `我想学习 ${word} 这个词。`
  };
}

function shouldUpdateAiAnnotation(item: VocabItem) {
  return item.aiAnnotationVersion !== AI_ANNOTATION_VERSION ||
    !item.aiMeaningZh ||
    !item.aiPartOfSpeech ||
    !item.aiPhonetic ||
    !item.aiNote ||
    !item.aiOtherMeanings ||
    !item.aiRootFamily ||
    !(item.examples ?? []).every((example) => example.translationZh);
}

function hasChinese(value: unknown) {
  return /[\u4e00-\u9fff]/.test(String(value ?? ''));
}

function stripJsonFence(content: string) {
  return content.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
}

function formatApiError(detail: string) {
  if (!detail.trim()) return 'No response body';
  try {
    const parsed = JSON.parse(detail) as any;
    return parsed.error?.message ?? parsed.message ?? detail;
  } catch {
    return detail.slice(0, 180);
  }
}
