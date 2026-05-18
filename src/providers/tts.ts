import type { TtsMode } from '../types';

export interface TTSProvider {
  mode: TtsMode;
  speak(text: string, lang?: string): Promise<void>;
  stop(): void;
}

export class BrowserTTSProvider implements TTSProvider {
  mode: TtsMode = 'browser';

  async speak(text: string, lang = 'en-US') {
    if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) {
      throw new Error('This browser does not support system speech. Try Chrome/Edge on Android or Safari on iOS.');
    }

    window.speechSynthesis.cancel();
    window.speechSynthesis.resume();
    await loadVoices();

    const chunks = splitForSpeech(text);
    for (const chunk of chunks) {
      await speakChunk(chunk, lang);
    }
  }

  stop() {
    window.speechSynthesis?.cancel();
  }
}

export class FutureAiTTSProvider implements TTSProvider {
  mode: TtsMode = 'future-ai';

  async speak() {
    throw new Error('AI voice is reserved for a future version. Use browser speech for now.');
  }

  stop() {}
}

export function createTtsProvider(mode: TtsMode): TTSProvider {
  return mode === 'future-ai' ? new FutureAiTTSProvider() : new BrowserTTSProvider();
}

function speakChunk(text: string, lang: string) {
  return new Promise<void>((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.voice = chooseVoice(lang);
    utterance.rate = lang.startsWith('zh') ? 0.9 : 0.86;
    utterance.pitch = 1;

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve();
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      reject(new Error('Speech failed. On phones, tap once on the page and try again.'));
    };

    const timeout = window.setTimeout(finish, Math.max(6000, text.length * 180));
    utterance.onend = finish;
    utterance.onerror = fail;
    window.speechSynthesis.resume();
    window.speechSynthesis.speak(utterance);
  });
}

function chooseVoice(lang: string) {
  const voices = window.speechSynthesis.getVoices();
  const normalized = lang.toLowerCase();
  return voices.find((voice) => voice.lang.toLowerCase() === normalized) ??
    voices.find((voice) => voice.lang.toLowerCase().startsWith(normalized.split('-')[0])) ??
    null;
}

function loadVoices() {
  return new Promise<void>((resolve) => {
    if (window.speechSynthesis.getVoices().length > 0) {
      resolve();
      return;
    }
    const timeout = window.setTimeout(resolve, 800);
    window.speechSynthesis.onvoiceschanged = () => {
      window.clearTimeout(timeout);
      resolve();
    };
  });
}

function splitForSpeech(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const sentences = normalized.match(/[^.!?。！？]+[.!?。！？]?/g) ?? [normalized];
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const next = current ? `${current} ${sentence.trim()}` : sentence.trim();
    if (next.length > 180 && current) {
      chunks.push(current);
      current = sentence.trim();
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
