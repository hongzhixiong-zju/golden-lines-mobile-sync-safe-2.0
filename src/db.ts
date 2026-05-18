import Dexie, { type Table } from 'dexie';
import type { AppSettings, AudioCacheMeta, Quote, ReviewLog, VocabItem } from './types';

export const DEFAULT_INTERVALS = [1, 3, 7, 14, 30];

class GoldenLinesDb extends Dexie {
  quotes!: Table<Quote, number>;
  vocab!: Table<VocabItem, number>;
  reviews!: Table<ReviewLog, number>;
  audioCache!: Table<AudioCacheMeta, number>;
  settings!: Table<AppSettings, string>;

  constructor() {
    super('golden-lines-db');
    this.version(1).stores({
      quotes: '++id, createdAt, *tags',
      vocab: '++id, word, quoteId, nextReviewAt, mastery, createdAt',
      reviews: '++id, vocabId, reviewedAt, rating',
      audioCache: '++id, cacheKey, provider, createdAt',
      settings: 'id'
    });
  }
}

export const db = new GoldenLinesDb();

export async function getSettings(): Promise<AppSettings> {
  const existing = await db.settings.get('default');
  const defaults: AppSettings = {
    id: 'default',
    collinsApiKey: '',
    aiApiKey: '',
    aiApiBaseUrl: 'https://api.deepseek.com',
    aiApiModel: 'deepseek-v4-flash',
    ttsMode: 'browser',
    intervals: DEFAULT_INTERVALS
  };
  if (existing) {
    return {
      ...defaults,
      ...existing
    };
  }
  await db.settings.put(defaults);
  return defaults;
}

export async function saveSettings(settings: AppSettings) {
  await db.settings.put(settings);
}

export async function exportAllData() {
  const [quotes, vocab, reviews, audioCache, settings] = await Promise.all([
    db.quotes.toArray(),
    db.vocab.toArray(),
    db.reviews.toArray(),
    db.audioCache.toArray(),
    db.settings.toArray()
  ]);
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    quotes,
    vocab,
    reviews,
    audioCache,
    settings
  };
}

export async function importAllData(payload: Awaited<ReturnType<typeof exportAllData>>) {
  const fallbackSettings = {
    id: 'default' as const,
    collinsApiKey: '',
    aiApiKey: '',
    aiApiBaseUrl: 'https://api.deepseek.com',
    aiApiModel: 'deepseek-v4-flash',
    ttsMode: 'browser' as const,
    intervals: DEFAULT_INTERVALS
  };
  await db.transaction('rw', [db.quotes, db.vocab, db.reviews, db.audioCache, db.settings], async () => {
    await Promise.all([
      db.quotes.clear(),
      db.vocab.clear(),
      db.reviews.clear(),
      db.audioCache.clear(),
      db.settings.clear()
    ]);
    await db.quotes.bulkPut(payload.quotes ?? []);
    await db.vocab.bulkPut(payload.vocab ?? []);
    await db.reviews.bulkPut(payload.reviews ?? []);
    await db.audioCache.bulkPut(payload.audioCache ?? []);
    await db.settings.bulkPut(payload.settings?.length ? payload.settings : [fallbackSettings]);
  });
}
