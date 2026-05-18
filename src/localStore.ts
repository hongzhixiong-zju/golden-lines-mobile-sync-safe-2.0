import type { AppSettings, Article, AudioCacheMeta, Quote, ReviewLog, VocabItem } from './types';
import { DEFAULT_INTERVALS } from './db';

export interface AppStore {
  version: number;
  versionLabel: string;
  updatedAt?: string;
  articles: Article[];
  quotes: Quote[];
  vocab: VocabItem[];
  reviews: ReviewLog[];
  audioCache: AudioCacheMeta[];
  settings: AppSettings;
  nextIds: {
    quote: number;
    article: number;
    vocab: number;
    review: number;
    audio: number;
  };
}

const DB_NAME = 'golden-lines-mobile-store';
const DB_VERSION = 1;
const STORE_NAME = 'kv';
const APP_STORE_KEY = 'app-store';
const INITIAL_STORE_URLS = [new URL('vocab-store.json', window.location.href).toString(), '/api/store'];

export function emptyStore(): AppStore {
  return {
    version: 1,
    versionLabel: 'v1',
    updatedAt: new Date().toISOString(),
    articles: [],
    quotes: [],
    vocab: [],
    reviews: [],
    audioCache: [],
    settings: {
      id: 'default',
      collinsApiKey: '',
      aiApiKey: '',
      aiApiBaseUrl: 'https://api.deepseek.com',
      aiApiModel: 'deepseek-v4-flash',
      ttsMode: 'browser',
      intervals: DEFAULT_INTERVALS
    },
    nextIds: {
      quote: 1,
      article: 1,
      vocab: 1,
      review: 1,
      audio: 1
    }
  };
}

export async function loadStore() {
  const cached = await readCachedStore();
  if (cached) return cached;

  const initial = await loadInitialStore();
  await saveStore(initial);
  return initial;
}

export async function saveStore(store: AppStore) {
  await writeCachedStore(normalizeStore(store));
}

export function normalizeStore(raw: Partial<AppStore>): AppStore {
  const base = emptyStore();
  const quotes = raw.quotes ?? [];
  const articles = raw.articles ?? [];
  const vocab = raw.vocab ?? [];
  const reviews = raw.reviews ?? [];
  const audioCache = raw.audioCache ?? [];
  return {
    version: raw.version ?? 1,
    versionLabel: raw.versionLabel ?? `v${raw.version ?? 1}`,
    updatedAt: raw.updatedAt ?? new Date().toISOString(),
    articles: articles.map((article) => ({
      ...article,
      annotations: article.annotations ?? []
    })),
    quotes,
    vocab: vocab.map((item) => ({
      ...item,
      examples: item.examples?.length
        ? item.examples
        : [{
          quoteId: item.quoteId,
          text: item.quoteText,
          source: quotes.find((quote) => quote.id === item.quoteId)?.source,
          addedAt: item.createdAt
        }]
    })),
    reviews,
    audioCache,
    settings: {
      ...base.settings,
      ...(raw.settings ?? {})
    },
    nextIds: {
      quote: Math.max(raw.nextIds?.quote ?? 1, maxId(quotes) + 1),
      article: Math.max(raw.nextIds?.article ?? 1, maxId(articles) + 1),
      vocab: Math.max(raw.nextIds?.vocab ?? 1, maxId(vocab) + 1),
      review: Math.max(raw.nextIds?.review ?? 1, maxId(reviews) + 1),
      audio: Math.max(raw.nextIds?.audio ?? 1, maxId(audioCache) + 1)
    }
  };
}

async function loadInitialStore() {
  for (const url of INITIAL_STORE_URLS) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) return normalizeStore(await response.json());
    } catch {
      // Try the next bootstrap source.
    }
  }
  return emptyStore();
}

async function readCachedStore() {
  try {
    const stored = await idbGet<Partial<AppStore>>(APP_STORE_KEY);
    return stored ? normalizeStore(stored) : null;
  } catch {
    const fallback = localStorage.getItem(APP_STORE_KEY);
    return fallback ? normalizeStore(JSON.parse(fallback)) : null;
  }
}

async function writeCachedStore(store: AppStore) {
  try {
    await idbSet(APP_STORE_KEY, store);
  } catch {
    localStorage.setItem(APP_STORE_KEY, JSON.stringify(store));
  }
}

function openDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet<T>(key: string) {
  const database = await openDb();
  return new Promise<T | undefined>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function idbSet<T>(key: string, value: T) {
  const database = await openDb();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(value, key);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

function maxId(items: Array<{ id?: number }>) {
  return items.reduce((max, item) => Math.max(max, item.id ?? 0), 0);
}
