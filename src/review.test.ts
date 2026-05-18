import { describe, expect, it } from 'vitest';
import { nextReviewState, partOfSpeechZh, reviewPriority, weightedRandomVocab } from './review';
import type { VocabItem } from './types';

const base: VocabItem = {
  id: 1,
  word: 'resilient',
  quoteText: 'She remained resilient.',
  meaningZh: '有韧性的',
  mastery: 4,
  reviewStep: 1,
  nextReviewAt: '2026-05-17T00:00:00.000Z',
  createdAt: '2026-05-17T00:00:00.000Z',
  updatedAt: '2026-05-17T00:00:00.000Z'
};

describe('nextReviewState', () => {
  it('moves good answers to the next interval', () => {
    const next = nextReviewState(base, 'good', [1, 3, 7], new Date('2026-05-17T00:00:00.000Z'));
    expect(next.reviewStep).toBe(2);
    expect(next.mastery).toBe(5);
    expect(next.nextReviewAt).toBe('2026-05-22T01:48:00.000Z');
    expect(next.lastReviewedAt).toBe('2026-05-17T00:00:00.000Z');
  });

  it('resets forgotten cards to the first interval', () => {
    const next = nextReviewState(base, 'forgot', [1, 3, 7], new Date('2026-05-17T00:00:00.000Z'));
    expect(next.reviewStep).toBe(0);
    expect(next.mastery).toBe(1);
    expect(next.nextReviewAt).toBe('2026-05-17T06:00:00.000Z');
    expect(next.lapseCount).toBe(1);
  });

  it('schedules hard answers sooner than remembered answers', () => {
    const now = new Date('2026-05-17T00:00:00.000Z');
    const hard = nextReviewState(base, 'hard', [1, 3, 7], now);
    const good = nextReviewState(base, 'good', [1, 3, 7], now);
    expect(new Date(hard.nextReviewAt).getTime()).toBeLessThan(new Date(good.nextReviewAt).getTime());
    expect(hard.reviewStep).toBe(1);
    expect(good.reviewStep).toBe(2);
  });

  it('gives weak overdue cards higher priority', () => {
    const now = new Date('2026-05-20T00:00:00.000Z');
    const weak = { ...base, mastery: 1, nextReviewAt: '2026-05-18T00:00:00.000Z' };
    const strong = { ...base, mastery: 9, nextReviewAt: '2026-05-22T00:00:00.000Z' };
    expect(reviewPriority(weak, now)).toBeGreaterThan(reviewPriority(strong, now));
  });

  it('translates common parts of speech to Chinese', () => {
    expect(partOfSpeechZh('noun')).toBe('名词');
    expect(partOfSpeechZh('verb')).toBe('动词');
    expect(partOfSpeechZh('adjective')).toBe('形容词');
  });

  it('can still draw a heavily seen random word without giving it zero weight', () => {
    const selected = weightedRandomVocab([
      { ...base, id: 1, randomStudyCount: 100, lastRandomAt: '2026-05-17T00:00:00.000Z' }
    ], new Date('2026-05-17T00:00:00.000Z'));
    expect(selected?.id).toBe(1);
  });
});
