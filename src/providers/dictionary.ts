import type { DictionaryEntry } from '../types';

export interface DictionaryProvider {
  lookup(word: string): Promise<DictionaryEntry>;
}

export class CollinsDictionaryProvider implements DictionaryProvider {
  constructor(private apiKey: string) {}

  async lookup(word: string): Promise<DictionaryEntry> {
    if (!this.apiKey.trim()) {
      return fallbackEntry(word, '请手动补充中文释义');
    }

    const url = new URL(`https://api.collinsdictionary.com/api/v1/dictionaries/english-chinese/search/first/`);
    url.searchParams.set('q', word);
    const response = await fetch(url, {
      headers: {
        accessKey: this.apiKey
      }
    });

    if (!response.ok) {
      throw new Error(`Collins lookup failed: ${response.status}`);
    }

    const data = await response.json();
    return normalizeCollins(word, data);
  }
}

export class FreeDictionaryProvider implements DictionaryProvider {
  async lookup(word: string): Promise<DictionaryEntry> {
    const response = await fetch(`https://freedictionaryapi.com/api/v1/entries/en/${encodeURIComponent(word)}`);
    if (!response.ok) {
      throw new Error(`Free dictionary lookup failed: ${response.status}`);
    }

    const data = (await response.json()) as FreeDictionaryApiResponse;
    const entry = data.entries?.[0] ?? data.entry;
    const firstSense = entry?.senses?.[0];
    const firstDefinition = firstSense?.definition ?? entry?.definitions?.[0]?.definition;
    const firstExample = firstSense?.examples?.[0] ?? entry?.definitions?.[0]?.example;
    const zhTranslation = findChineseTranslation(entry);

    if (!firstDefinition && !zhTranslation) {
      throw new Error('Free dictionary returned no definition');
    }

    return {
      word,
      meaningZh: [
        zhTranslation ? `中文参考：${zhTranslation}` : '',
        firstDefinition ? `英英释义：${firstDefinition}` : '',
        firstExample ? `例句：${firstExample}` : ''
      ].filter(Boolean).join('\n'),
      partOfSpeech: firstSense?.partOfSpeech ?? entry?.partOfSpeech,
      phonetic: entry?.pronunciations?.find((item) => item.ipa)?.ipa ?? entry?.phonetic,
      source: 'fallback'
    };
  }
}

export async function lookupDictionary(word: string, collinsApiKey: string, manualMeaning = '') {
  const accessKey = normalizeCollinsAccessKey(collinsApiKey);
  if (accessKey) {
    return new CollinsDictionaryProvider(accessKey).lookup(word);
  }

  try {
    return await new FreeDictionaryProvider().lookup(word);
  } catch {
    return fallbackEntry(word, manualMeaning || '自动词典暂未查到，请手动补充释义');
  }
}

function normalizeCollinsAccessKey(value: string) {
  const trimmed = value.trim();
  if (!trimmed || /^curl\s+/i.test(trimmed) || /^https?:\/\//i.test(trimmed)) {
    return '';
  }
  return trimmed;
}

export function fallbackEntry(word: string, meaningZh = ''): DictionaryEntry {
  return {
    word,
    meaningZh,
    source: meaningZh ? 'manual' : 'fallback'
  };
}

interface FreeDictionaryApiResponse {
  entry?: FreeDictionaryEntry;
  entries?: FreeDictionaryEntry[];
}

interface FreeDictionaryEntry {
  phonetic?: string;
  partOfSpeech?: string;
  pronunciations?: Array<{ ipa?: string }>;
  translations?: Record<string, string[] | string> | Array<{ language?: string; text?: string }>;
  senses?: Array<{
    definition?: string;
    partOfSpeech?: string;
    examples?: string[];
    translations?: Record<string, string[] | string> | Array<{ language?: string; text?: string }>;
  }>;
  definitions?: Array<{
    definition?: string;
    example?: string;
  }>;
}

function findChineseTranslation(entry?: FreeDictionaryEntry) {
  if (!entry) return '';
  return normalizeTranslation(entry.translations) || normalizeTranslation(entry.senses?.find((sense) => sense.translations)?.translations);
}

function normalizeTranslation(translations?: FreeDictionaryEntry['translations']) {
  if (!translations) return '';
  if (Array.isArray(translations)) {
    return translations.find((item) => /zh|chinese|中文/i.test(item.language ?? ''))?.text ?? '';
  }
  const candidates = translations.zh ?? translations['zh-CN'] ?? translations.chinese ?? translations.Chinese;
  return Array.isArray(candidates) ? candidates.join('；') : candidates ?? '';
}

function normalizeCollins(word: string, data: unknown): DictionaryEntry {
  const asRecord = data as Record<string, unknown>;
  const entryContent = String(asRecord.entryContent ?? asRecord.content ?? '');
  const partOfSpeech = extractText(entryContent, /<span class="pos">(.*?)<\/span>/i);
  const phonetic = extractText(entryContent, /<span class="pron">(.*?)<\/span>/i);
  const meaningZh =
    extractText(entryContent, /<span class="quote">(.*?)<\/span>/i) ||
    extractText(entryContent, /<div class="def">(.*?)<\/div>/i) ||
    '未能自动解析释义，请手动补充';

  return {
    word,
    meaningZh,
    partOfSpeech,
    phonetic,
    source: 'collins'
  };
}

function extractText(html: string, pattern: RegExp) {
  const match = html.match(pattern)?.[1];
  return match
    ?.replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}
