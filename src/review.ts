import type { ReviewRating, VocabItem } from './types';

export const RATING_LABEL: Record<ReviewRating, string> = {
  forgot: '忘了',
  hard: '模糊',
  good: '记得',
  easy: '很熟'
};

const DAY_MS = 24 * 60 * 60 * 1000;

const RATING_RULES: Record<ReviewRating, {
  stepDelta: number;
  masteryDelta: number;
  intervalFactor: number;
  minimumDays: number;
}> = {
  forgot: { stepDelta: -2, masteryDelta: -3, intervalFactor: 0.3, minimumDays: 0.25 },
  hard: { stepDelta: 0, masteryDelta: -1, intervalFactor: 0.65, minimumDays: 0.5 },
  good: { stepDelta: 1, masteryDelta: 1, intervalFactor: 1, minimumDays: 1 },
  easy: { stepDelta: 2, masteryDelta: 2, intervalFactor: 1.8, minimumDays: 2 }
};

export function isDue(item: VocabItem, now = new Date()) {
  return new Date(item.nextReviewAt).getTime() <= now.getTime();
}

export function partOfSpeechZh(partOfSpeech?: string): string {
  if (!partOfSpeech) return '词性待补';
  const normalized = partOfSpeech.trim().toLowerCase();
  const map: Record<string, string> = {
    n: '名词',
    noun: '名词',
    v: '动词',
    verb: '动词',
    vi: '不及物动词',
    vt: '及物动词',
    adj: '形容词',
    adjective: '形容词',
    adv: '副词',
    adverb: '副词',
    gerund: '动名词',
    'attributive noun': '名词作定语',
    prep: '介词',
    preposition: '介词',
    conj: '连词',
    conjunction: '连词',
    pron: '代词',
    pronoun: '代词',
    interj: '感叹词',
    article: '冠词',
    det: '限定词',
    determiner: '限定词',
    phrase: '短语'
  };
  if (normalized.includes('/')) {
    return normalized
      .split('/')
      .map((part) => partOfSpeechZh(part.trim()))
      .join(' / ');
  }
  return map[normalized] ?? partOfSpeech;
}

export function reviewPriority(item: VocabItem, now = new Date()) {
  const nextReviewAt = new Date(item.nextReviewAt).getTime();
  const overdueDays = (now.getTime() - nextReviewAt) / DAY_MS;
  const lastTouchedAt = new Date(item.lastReviewedAt || item.createdAt).getTime();
  const idleDays = Math.max(0, (now.getTime() - lastTouchedAt) / DAY_MS);
  const masteryRisk = 10 - Math.max(0, Math.min(10, item.mastery));
  const lapseRisk = Math.min(4, item.lapseCount ?? 0) * 1.5;
  const ageRisk = Math.min(4, idleDays / 7);
  const dueRisk = overdueDays > 0 ? Math.min(8, overdueDays * 2) : overdueDays * 0.5;
  return masteryRisk + lapseRisk + ageRisk + dueRisk;
}

export function sortByReviewPriority(items: VocabItem[], now = new Date()) {
  return items
    .slice()
    .sort((a, b) => reviewPriority(b, now) - reviewPriority(a, now));
}

export function nextReviewState(
  item: VocabItem,
  rating: ReviewRating,
  intervals: number[],
  now = new Date()
) {
  const safeIntervals = intervals.length ? intervals : [1];
  const maxStep = Math.max(0, safeIntervals.length - 1);
  const rule = RATING_RULES[rating];
  const nextStep = Math.max(0, Math.min(maxStep, item.reviewStep + rule.stepDelta));
  const baseDays = safeIntervals[nextStep] ?? safeIntervals[safeIntervals.length - 1] ?? 1;
  const lastTouchedAt = new Date(item.lastReviewedAt || item.createdAt).getTime();
  const daysSinceTouch = Math.max(0, (now.getTime() - lastTouchedAt) / DAY_MS);
  const elapsedPressure = Math.max(0.75, Math.min(1.4, daysSinceTouch / Math.max(1, baseDays)));
  const masteryFactor = Math.max(0.7, Math.min(1.35, 0.7 + item.mastery / 15));
  const nextIntervalDays = Math.max(
    rule.minimumDays,
    baseDays * rule.intervalFactor * elapsedPressure * masteryFactor
  );
  const nextDate = new Date(now.getTime() + nextIntervalDays * DAY_MS);
  const nextMastery = Math.max(0, Math.min(10, item.mastery + rule.masteryDelta));
  return {
    reviewStep: nextStep,
    mastery: nextMastery,
    nextReviewAt: nextDate.toISOString(),
    lastReviewedAt: now.toISOString(),
    lapseCount: rating === 'forgot' ? (item.lapseCount ?? 0) + 1 : item.lapseCount ?? 0
  };
}

export function weightedRandomVocab(items: VocabItem[], now = new Date()) {
  if (items.length === 0) return undefined;
  const weighted = items.map((item) => {
    const seenPenalty = 1 / (1 + (item.randomStudyCount ?? 0) * 1.4);
    const recencyPenalty = item.lastRandomAt
      ? Math.max(0.2, Math.min(1, (now.getTime() - new Date(item.lastRandomAt).getTime()) / (7 * DAY_MS)))
      : 1;
    return {
      item,
      weight: Math.max(0.05, seenPenalty * recencyPenalty)
    };
  });
  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  let cursor = Math.random() * total;
  for (const entry of weighted) {
    cursor -= entry.weight;
    if (cursor <= 0) return entry.item;
  }
  return weighted[weighted.length - 1]?.item;
}
