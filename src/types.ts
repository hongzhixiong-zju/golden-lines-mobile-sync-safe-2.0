export type ReviewRating = 'forgot' | 'hard' | 'good' | 'easy';

export type TtsMode = 'browser' | 'future-ai';

export interface VocabSense {
  meaningZh: string;
  partOfSpeech?: string;
}

export interface RootFamilyEntry {
  word: string;
  meaningZh?: string;
  partOfSpeech?: string;
}

export interface Quote {
  id?: number;
  text: string;
  source?: string;
  tags: string[];
  vocabIds: number[];
  createdAt: string;
}

export interface Article {
  id?: number;
  title: string;
  text: string;
  source?: string;
  annotations?: ArticleAnnotation[];
  createdAt: string;
  updatedAt: string;
}

export interface ArticleAnnotation {
  id: number;
  text: string;
  translationZh: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VocabItem {
  id?: number;
  word: string;
  quoteId?: number;
  quoteText: string;
  examples?: VocabExample[];
  meaningZh: string;
  partOfSpeech?: string;
  phonetic?: string;
  note?: string;
  otherMeanings?: Array<string | VocabSense>;
  aiMeaningZh?: string;
  aiPartOfSpeech?: string;
  aiPhonetic?: string;
  aiNote?: string;
  aiOtherMeanings?: Array<string | VocabSense>;
  aiRootFamily?: Array<string | RootFamilyEntry>;
  aiAnnotationVersion?: string;
  mastery: number;
  reviewStep: number;
  nextReviewAt: string;
  lastReviewedAt?: string;
  lapseCount?: number;
  randomStudyCount?: number;
  lastRandomAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VocabExample {
  quoteId?: number;
  text: string;
  translationZh?: string;
  source?: string;
  addedAt: string;
}

export interface ReviewLog {
  id?: number;
  vocabId: number;
  reviewedAt: string;
  rating: ReviewRating;
  previousStep: number;
  nextStep: number;
  nextReviewAt: string;
}

export interface AudioCacheMeta {
  id?: number;
  cacheKey: string;
  text: string;
  provider: TtsMode;
  createdAt: string;
}

export interface AppSettings {
  id: 'default';
  collinsApiKey: string;
  aiApiKey: string;
  aiApiBaseUrl: string;
  aiApiModel: string;
  ttsMode: TtsMode;
  intervals: number[];
}

export interface DictionaryEntry {
  word: string;
  meaningZh: string;
  partOfSpeech?: string;
  phonetic?: string;
  note?: string;
  source: 'codex' | 'collins' | 'manual' | 'fallback';
}

export interface CodexAnnotation {
  id?: number;
  word: string;
  quoteText?: string;
  meaningZh: string;
  partOfSpeech?: string;
  phonetic?: string;
  otherMeanings?: Array<string | VocabSense>;
  note?: string;
  examples?: VocabExample[];
  rootFamily?: Array<string | RootFamilyEntry>;
  annotationVersion?: string;
}
