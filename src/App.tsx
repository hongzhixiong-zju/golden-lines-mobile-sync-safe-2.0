import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fallbackEntry, lookupDictionary } from './providers/dictionary';
import { createTtsProvider } from './providers/tts';
import { applyAiAnnotationsToStore, requestAiAnnotationsForStore, requestArticleTranslation, requestWordExample, requestWordLemma, requestWordLookup } from './aiAnnotations';
import { isDue, nextReviewState, partOfSpeechZh, RATING_LABEL, sortByReviewPriority, weightedRandomVocab } from './review';
import { emptyStore, loadStore, saveStore, type AppStore } from './localStore';
import { loadSyncConfig, overwriteGist, pullStoreFromGist, pushStoreToGist, rememberSuccessfulSync, saveSyncConfig, testGistConnection, type SyncConfig } from './sync';
import { db as legacyDb } from './db';
import type { AppSettings, Article, ArticleAnnotation, CodexAnnotation, Quote, ReviewLog, ReviewRating, RootFamilyEntry, VocabItem, VocabSense } from './types';
import { downloadJson, formatDate, readJsonFile, splitWords, todayIso } from './utils';

type View = 'sentenceCapture' | 'wordLookup' | 'wordCapture' | 'articleCapture' | 'articleReader' | 'library' | 'review' | 'report' | 'settings';
type ReviewMode = 'due' | 'focus' | 'random' | 'listen';
type LibraryTab = 'words' | 'quotes';
type LibrarySortMode = 'alphabet' | 'createdAsc' | 'createdDesc';
const AI_ANNOTATION_VERSION = 'ai-annotation-v4';

const viewLabels: Record<View, string> = {
  sentenceCapture: '句子新增',
  wordLookup: 'AI查词',
  wordCapture: '单词新增',
  articleCapture: '文章新增',
  articleReader: '文章阅读',
  library: '摘录',
  review: '复习',
  report: '报告',
  settings: '设置'
};

const SOURCE_PRESETS = ['论文', '生活', '听力学习'];

export default function App() {
  const [view, setView] = useState<View>('sentenceCapture');
  const [libraryTab, setLibraryTab] = useState<LibraryTab>('words');
  const [store, setStore] = useState<AppStore>(emptyStore());
  const [loadStatus, setLoadStatus] = useState('');
  const [syncNotice, setSyncNotice] = useState('');
  const dueCount = useMemo(() => store.vocab.filter((item) => isDue(item)).length, [store.vocab]);

  useEffect(() => {
    refreshStore();
  }, []);

  useEffect(() => {
    if (!store.updatedAt) return;
    void syncFromCloudOnStartup(store);
  }, []);

  useEffect(() => {
    window.__goldenLinesCodex = {
      async listVocab() {
        return (await loadStore()).vocab.slice().reverse();
      },
      async listPendingAiAnnotations() {
        return (await loadStore()).vocab
          .filter(shouldUpdateAiAnnotation)
          .slice()
          .reverse();
      },
      async applyAiAnnotations(payload) {
        const annotations = normalizeAnnotations(payload);
        const next = await loadStore();
        applyAnnotationsToStore(next, annotations);
        await saveStore(next);
        setStore(next);
        return { updated: annotations.length };
      },
      async clearAiAnnotations(ids) {
        const next = await loadStore();
        const targetIds = ids?.length ? ids : next.vocab.map((item) => item.id).filter(Boolean) as number[];
        next.vocab = next.vocab.map((item) =>
          item.id && targetIds.includes(item.id)
            ? { ...item, aiMeaningZh: undefined, aiPartOfSpeech: undefined, aiPhonetic: undefined, aiNote: undefined, updatedAt: todayIso() }
            : item
        );
        await saveStore(next);
        setStore(next);
        return { cleared: targetIds.length };
      }
    };

    return () => {
      delete window.__goldenLinesCodex;
    };
  }, []);

  async function refreshStore() {
    try {
      const next = await loadStore();
      if (next.quotes.length === 0 && next.vocab.length === 0) {
        const migrated = await migrateLegacyIndexedDb(next);
        if (migrated.vocab.length > 0 || migrated.quotes.length > 0) {
          await saveStore(migrated);
          setStore(migrated);
          setLoadStatus(`已从旧浏览器数据库迁移 ${migrated.vocab.length} 个重点词到 data/vocab-store.json。`);
          return;
        }
      }
      setStore(next);
      setLoadStatus('');
      void syncFromCloudOnStartup(next);
    } catch (error) {
      setLoadStatus(error instanceof Error ? error.message : '读取本地词库失败');
    }
  }

  async function commitStore(next: AppStore, options: { skipAutoPush?: boolean } = {}) {
    const committed = stampStore(next);
    await saveStore(committed);
    setStore({ ...committed });
    if (!options.skipAutoPush) void autoPushStore(committed);
    return committed;
  }

  async function finalizeStoreAfterEdit(next: AppStore, ids?: number[]) {
    const saved = await commitStore(next, { skipAutoPush: true });
    let finalStore = saved;
    let aiMessage = 'AI annotation skipped: no target words.';
    let aiFailed = false;
    if (ids?.length) {
      try {
        setSyncNotice('Completing AI annotations before cloud sync...');
        const result = await requestAiAnnotationsForStore(saved, ids);
        if (result.updated > 0) {
          const annotated = cloneStore(saved);
          applyAiAnnotationsToStore(annotated, result.annotations);
          finalStore = stampStore(annotated);
          await saveStore(finalStore);
          setStore({ ...finalStore });
        }
        aiMessage = 'AI annotations updated for ' + result.updated + ' words.';
      } catch (error) {
        aiFailed = true;
        aiMessage = error instanceof Error ? 'AI annotations did not finish: ' + error.message : 'AI annotations did not finish.';
      }
    }
    if (aiFailed) {
      const cloudMessage = 'Cloud sync skipped because AI annotations did not finish.';
      setSyncNotice(cloudMessage);
      return { store: finalStore, aiMessage, cloudMessage };
    }
    const cloudMessage = await autoPushStore(finalStore, true);
    return { store: finalStore, aiMessage, cloudMessage };
  }

  function stampStore(next: AppStore) {
    const stamped = cloneStore(next);
    stamped.version = Math.max(store.version ?? 1, stamped.version ?? 1) + 1;
    stamped.versionLabel = 'v' + stamped.version;
    stamped.updatedAt = todayIso();
    return stamped;
  }

  async function autoPushStore(next: AppStore, reportSkipped = false) {
    const config = loadSyncConfig();
    if (!config.autoSync || !config.token.trim()) {
      const message = 'Cloud sync skipped: enable auto sync and enter a GitHub token/Gist ID in Settings.';
      if (reportSkipped) setSyncNotice(message);
      return message;
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      const message = 'Offline. Changes are saved locally and will need cloud sync later.';
      setSyncNotice(message);
      return message;
    }
    try {
      setSyncNotice('Syncing changes to GitHub Gist...');
      const result = await pushStoreToGist(config, next);
      rememberSuccessfulSync(config, result);
      const message = 'Cloud sync complete at ' + new Date().toLocaleTimeString() + '.';
      setSyncNotice(message);
      return message;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Cloud sync failed.';
      setSyncNotice(message);
      return message;
    }
  }

  async function syncFromCloudOnStartup(current: AppStore) {
    const config = loadSyncConfig();
    if (!config.token.trim() || !config.gistId.trim()) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    try {
      const remote = await pullStoreFromGist(config);
      const remoteTime = new Date(remote.store.updatedAt ?? 0).getTime();
      const localTime = new Date(current.updatedAt ?? 0).getTime();
      if (remoteTime > localTime) {
        await saveStore(remote.store);
        setStore(remote.store);
        rememberSuccessfulSync(config, remote);
        setSyncNotice('Loaded newer cloud data from GitHub Gist after page refresh.');
      }
    } catch (error) {
      setSyncNotice(error instanceof Error ? error.message : 'Cloud startup sync failed.');
    }
  }

  async function updateSettings(settings: AppSettings) {
    await commitStore({ ...store, settings });
  }

  const tts = useMemo(
    () => createTtsProvider(store.settings.ttsMode),
    [store.settings.ttsMode]
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Golden Lines</p>
          <h1>金句词库</h1>
        </div>
        <nav aria-label="主导航">
          {(Object.keys(viewLabels) as View[]).map((key) => (
            <button
              key={key}
              className={view === key ? 'active' : ''}
              onClick={() => setView(key)}
            >
              <span>{viewLabels[key]}</span>
              {key === 'review' && dueCount > 0 ? <b>{dueCount}</b> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-stats">
          <button type="button" onClick={() => { setLibraryTab('words'); setView('library'); }}>
            <strong>{store.vocab.length}</strong>
            <span>个重点词</span>
          </button>
          <button type="button" onClick={() => { setLibraryTab('quotes'); setView('library'); }}>
            <strong>{store.quotes.length}</strong>
            <span>条摘录</span>
          </button>
          <strong>{store.versionLabel}</strong>
          <span>词库版本</span>
        </div>
      </aside>

      <main>
        {loadStatus ? <p className="status">{loadStatus}</p> : null}
        {syncNotice ? <p className="status sync-status">{syncNotice}</p> : null}
        {view === 'sentenceCapture' ? <Capture store={store} onCommit={commitStore} onFinalize={finalizeStoreAfterEdit} onRefresh={refreshStore} /> : null}
        {view === 'wordLookup' ? <WordLookup store={store} speak={tts.speak.bind(tts)} onFinalize={finalizeStoreAfterEdit} onRefresh={refreshStore} /> : null}
        {view === 'wordCapture' ? <WordCapture store={store} onCommit={commitStore} onFinalize={finalizeStoreAfterEdit} onRefresh={refreshStore} /> : null}
        {view === 'articleCapture' ? <ArticleCapture store={store} onCommit={commitStore} /> : null}
        {view === 'articleReader' ? <ArticleReader store={store} speak={tts.speak.bind(tts)} stop={tts.stop.bind(tts)} onCommit={commitStore} onFinalize={finalizeStoreAfterEdit} onRefresh={refreshStore} /> : null}
        {view === 'library' ? <Library store={store} initialTab={libraryTab} speak={tts.speak.bind(tts)} onCommit={commitStore} onFinalize={finalizeStoreAfterEdit} onRefresh={refreshStore} /> : null}
        {view === 'review' ? <Review store={store} speak={tts.speak.bind(tts)} stop={tts.stop.bind(tts)} onCommit={commitStore} /> : null}
        {view === 'report' ? <Report quotes={store.quotes} vocab={store.vocab} reviews={store.reviews} /> : null}
        {view === 'settings' ? (
          <Settings store={store} onChange={updateSettings} onCommit={commitStore} onFinalize={finalizeStoreAfterEdit} onRefresh={refreshStore} onSyncNotice={setSyncNotice} />
        ) : null}
      </main>
    </div>
  );
}

function Capture({
  store,
  onCommit,
  onFinalize,
  onRefresh
}: {
  store: AppStore;
  onCommit: (store: AppStore) => Promise<AppStore>;
  onFinalize: (store: AppStore, ids?: number[]) => Promise<{ aiMessage: string; cloudMessage?: string }>;
  onRefresh: () => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [source, setSource] = useState('');
  const [tags, setTags] = useState('');
  const [words, setWords] = useState('');
  const [manualMeaning, setManualMeaning] = useState('');
  const [status, setStatus] = useState('');
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const selectedWords = normalizeWordList(splitWords(words));

  function addSelectedTextAsWords() {
    const area = textRef.current;
    if (!area) return;
    const selected = area.value.slice(area.selectionStart, area.selectionEnd);
    const tokens = selected
      .split(/\s+/)
      .map(normalizeImportedWord)
      .filter(Boolean);
    if (tokens.length === 0) {
      setStatus('请先在英文摘录中选中一个或几个词。');
      return;
    }
    const merged = normalizeWordList([...selectedWords, ...tokens]);
    setWords(merged.join(', '));
    setStatus(`已加入：${tokens.join('、')}`);
  }

  async function saveQuote() {
    if (!text.trim() || selectedWords.length === 0) {
      setStatus('请先填写英文摘录和至少一个重点词。');
      return;
    }

    setStatus('正在保存到项目文件夹里的词库...');
    const now = todayIso();
    const next = cloneStore(store);
    const quoteId = next.nextIds.quote++;
    const quote: Quote = {
      id: quoteId,
      text: text.trim(),
      source: source.trim(),
      tags: splitWords(tags),
      vocabIds: [],
      createdAt: now
    };
    const touchedVocabIds: number[] = [];

    for (const word of selectedWords) {
      const vocabId = await upsertVocabFromExample(next, {
        word,
        quoteId,
        quoteText: text.trim(),
        source: source.trim(),
        manualMeaning,
        now
      });
      quote.vocabIds.push(vocabId);
      touchedVocabIds.push(vocabId);
    }

    next.quotes.push(quote);
    const result = await onFinalize(next, touchedVocabIds);
    await onRefresh();
    setText('');
    setSource('');
    setTags('');
    setWords('');
    setManualMeaning('');
    setStatus(`Saved ${quote.vocabIds.length} words. ${result.aiMessage} ${result.cloudMessage ?? ''}`);
  }

  return (
    <section className="screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Capture</p>
          <h2>新增金句</h2>
        </div>
        <button className="primary" onClick={saveQuote}>保存</button>
      </header>

      <div className="capture-layout">
        <label className="field wide">
          <span>英文摘录</span>
          <textarea ref={textRef} value={text} onChange={(event) => setText(event.target.value)} placeholder="Paste a sentence or paragraph that is worth remembering." />
        </label>
        <label className="field">
          <span>重点词</span>
          <div className="word-picker">
            <input value={words} onChange={(event) => setWords(event.target.value)} placeholder="resilient, deliberate" />
            <button type="button" onClick={addSelectedTextAsWords}>加入选中词</button>
          </div>
        </label>
        <label className="field">
          <span>来源</span>
          <input value={source} onChange={(event) => setSource(event.target.value)} placeholder="书名、文章或场景" />
          <div className="source-cards" aria-label="常用来源">
            {SOURCE_PRESETS.map((preset) => (
              <button
                type="button"
                key={preset}
                className={source === preset ? 'active' : ''}
                onClick={() => setSource(preset)}
              >
                {preset}
              </button>
            ))}
          </div>
        </label>
        <label className="field">
          <span>标签</span>
          <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="writing, work" />
        </label>
        <label className="field">
          <span>默认释义</span>
          <input value={manualMeaning} onChange={(event) => setManualMeaning(event.target.value)} placeholder="可留空，之后由 Codex 补 AI 注释" />
        </label>
      </div>

      <div className="preview-band">
        <span>{selectedWords.length} 个词将创建为复习卡</span>
        <p>{selectedWords.join(' · ') || '还没有重点词'}</p>
      </div>
      {status ? <p className="status">{status}</p> : null}
    </section>
  );
}


function WordLookup({
  store,
  speak,
  onFinalize,
  onRefresh
}: {
  store: AppStore;
  speak: (text: string, lang?: string) => Promise<void>;
  onFinalize: (store: AppStore, ids?: number[]) => Promise<{ aiMessage: string; cloudMessage?: string }>;
  onRefresh: () => Promise<void>;
}) {
  const [word, setWord] = useState('');
  const [lookup, setLookup] = useState<CodexAnnotation | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  async function lookupWord() {
    const target = await resolveImportedWord(store.settings, word);
    if (!target) {
      setStatus('Please enter a word first.');
      return;
    }
    setBusy(true);
    setStatus('Looking up with AI...');
    try {
      const result = await requestWordLookup(store.settings, target);
      setLookup(result);
      setStatus('Lookup complete.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'AI lookup failed.');
    } finally {
      setBusy(false);
    }
  }

  async function addToLibrary() {
    if (!lookup) return;
    setBusy(true);
    setStatus('Adding to vocabulary library...');
    try {
      const now = todayIso();
      const next = cloneStore(store);
      const quoteId = next.nextIds.quote++;
      const firstExample = lookup.examples?.[0];
      const quoteText = firstExample?.text || 'I want to learn the word ' + lookup.word + '.';
      const translationZh = firstExample?.translationZh;
      const vocabId = await upsertVocabFromExample(next, {
        word: lookup.word,
        quoteId,
        quoteText,
        source: 'AI查词',
        translationZh,
        manualMeaning: lookup.meaningZh,
        now
      });
      next.quotes.push({
        id: quoteId,
        text: quoteText,
        source: 'AI查词',
        tags: ['lookup'],
        vocabIds: [vocabId],
        createdAt: now
      });
      next.vocab = next.vocab.map((item) => item.id === vocabId
        ? {
          ...item,
          aiMeaningZh: lookup.meaningZh,
          aiPartOfSpeech: lookup.partOfSpeech,
          aiPhonetic: lookup.phonetic,
          aiOtherMeanings: lookup.otherMeanings,
          aiRootFamily: lookup.rootFamily,
          aiNote: lookup.note,
          aiAnnotationVersion: lookup.annotationVersion ?? AI_ANNOTATION_VERSION,
          examples: lookup.examples?.length ? lookup.examples.map((example) => ({ ...example, quoteId, addedAt: example.addedAt ?? now })) : item.examples,
          updatedAt: now
        }
        : item
      );
      const result = await onFinalize(next, [vocabId]);
      await onRefresh();
      setStatus('Added to vocabulary library. ' + (result.cloudMessage ?? ''));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Adding word failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Lookup</p>
          <h2>AI查词</h2>
        </div>
        <button className="primary" disabled={busy} onClick={lookupWord}>{busy ? '处理中...' : 'AI翻译'}</button>
      </header>

      <div className="lookup-panel">
        <label className="field">
          <span>输入单词</span>
          <input value={word} onChange={(event) => setWord(event.target.value)} placeholder="resilient" onKeyDown={(event) => { if (event.key === 'Enter') void lookupWord(); }} />
        </label>
        {lookup ? (
          <article className="word-entry lookup-result">
            <div className="word-entry-head">
              <div className="word-title">
                <h3>{lookup.word}</h3>
                <em>{partOfSpeechZh(lookup.partOfSpeech)}</em>
              </div>
              <div className="pronounce">
                <span>{lookup.phonetic || 'phonetic pending'}</span>
                <button className="icon-btn" title="朗读单词" onClick={() => speak(lookup.word)}>▶</button>
              </div>
            </div>
            <div className="word-blocks">
              <InfoBlock title="中文释义" body={lookup.meaningZh} emphasis />
              <InfoBlock title="其他含义" body={formatSenseList(lookup.otherMeanings)} />
              <InfoBlock title="同词根/相关词" body={formatRootFamily(lookup.rootFamily)} />
              <InfoBlock title="学习笔记" body={lookup.note || '暂无笔记'} />
            </div>
            <ExamplesPreview examples={lookup.examples ?? []} speak={speak} />
            <div className="card-actions">
              <button className="primary" disabled={busy} onClick={addToLibrary}>添加至单词库</button>
              <button disabled={busy} onClick={() => speak(lookup.word)}>朗读单词</button>
            </div>
          </article>
        ) : null}
        {status ? <p className="status">{status}</p> : null}
      </div>
    </section>
  );
}

function ExamplesPreview({ examples, speak }: { examples: VocabItem['examples']; speak: (text: string, lang?: string) => Promise<void> }) {
  if (!examples?.length) return null;
  return (
    <div className="examples-block">
      <span>例句</span>
      {examples.map((example, index) => (
        <div className="example-row" key={example.text + '-' + index}>
          <p>{example.text}</p>
          {example.translationZh ? <small>{example.translationZh}</small> : null}
          <button className="small-btn" onClick={() => speak(example.text)}>朗读例句</button>
        </div>
      ))}
    </div>
  );
}

function WordCapture({
  store,
  onCommit,
  onFinalize,
  onRefresh
}: {
  store: AppStore;
  onCommit: (store: AppStore) => Promise<AppStore>;
  onFinalize: (store: AppStore, ids?: number[]) => Promise<{ aiMessage: string; cloudMessage?: string }>;
  onRefresh: () => Promise<void>;
}) {
  const [words, setWords] = useState('');
  const [status, setStatus] = useState('');
  const selectedWords = normalizeWordList(splitWords(words));

  async function saveWords() {
    if (selectedWords.length === 0) {
      setStatus('请先输入至少一个英文单词。');
      return;
    }
    setStatus('正在生成简单例句并写入词库...');
    const now = todayIso();
    const next = cloneStore(store);
    const saved: string[] = [];
    const touchedVocabIds: number[] = [];
    for (const word of selectedWords) {
      const normalizedWord = await resolveImportedWord(store.settings, word);
      if (!normalizedWord) continue;
      const generated = await generateWordExample(normalizedWord);
      const quoteId = next.nextIds.quote++;
      const quote: Quote = {
        id: quoteId,
        text: generated.text,
        source: '单词新增',
        tags: ['word'],
        vocabIds: [],
        createdAt: now
      };
      const vocabId = await upsertVocabFromExample(next, {
        word: normalizedWord,
        quoteId,
        quoteText: generated.text,
        source: '单词新增',
        translationZh: generated.translationZh,
        manualMeaning: '',
        now
      });
      quote.vocabIds.push(vocabId);
      touchedVocabIds.push(vocabId);
      next.quotes.push(quote);
      saved.push(normalizedWord);
    }
    const result = await onFinalize(next, touchedVocabIds);
    await onRefresh();
    setWords('');
    setStatus(`Added: ${saved.join(', ')}. ${result.aiMessage} ${result.cloudMessage ?? ''}`);
  }

  return (
    <section className="screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Word</p>
          <h2>单词新增</h2>
        </div>
        <button className="primary" onClick={saveWords}>生成并保存</button>
      </header>
      <label className="field">
        <span>单词</span>
        <input value={words} onChange={(event) => setWords(event.target.value)} placeholder="alternative, precise, context" />
      </label>
      <div className="preview-band">
        <span>{selectedWords.length} 个词将加入同一个学习词库</span>
        <p>{selectedWords.join(' · ') || '还没有输入单词'}</p>
      </div>
      {status ? <p className="status">{status}</p> : null}
    </section>
  );
}

function ArticleCapture({
  store,
  onCommit
}: {
  store: AppStore;
  onCommit: (store: AppStore) => Promise<unknown>;
}) {
  const [title, setTitle] = useState('');
  const [source, setSource] = useState('');
  const [rawText, setRawText] = useState('');
  const [status, setStatus] = useState('');
  const cleanedText = cleanEnglishArticle(rawText);

  async function saveArticle() {
    if (!cleanedText.trim()) {
      setStatus('请粘贴一篇包含英文内容的文章。');
      return;
    }
    const now = todayIso();
    const next = cloneStore(store);
    const article: Article = {
      id: next.nextIds.article++,
      title: title.trim() || `Article ${next.nextIds.article - 1}`,
      source: source.trim(),
      text: cleanedText,
      annotations: [],
      createdAt: now,
      updatedAt: now
    };
    next.articles.unshift(article);
    await onCommit(next);
    setTitle('');
    setSource('');
    setRawText('');
    setStatus('文章已存档。可以到“文章阅读”里打开、朗读并滑词加入词库。');
  }

  return (
    <section className="screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Article</p>
          <h2>文章新增</h2>
        </div>
        <button className="primary" onClick={saveArticle}>保存文章</button>
      </header>
      <div className="capture-layout">
        <label className="field">
          <span>标题</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="文章标题" />
        </label>
        <label className="field">
          <span>来源</span>
          <input value={source} onChange={(event) => setSource(event.target.value)} placeholder="网站、论文、听力材料" />
        </label>
        <label className="field wide">
          <span>文章原文</span>
          <textarea value={rawText} onChange={(event) => setRawText(event.target.value)} placeholder="粘贴文章；中文噪声会自动清理，仅保留英文内容。" />
        </label>
      </div>
      <div className="preview-band">
        <span>清理预览</span>
        <p>{cleanedText.slice(0, 240) || '等待粘贴文章'}</p>
      </div>
      {status ? <p className="status">{status}</p> : null}
    </section>
  );
}

function ArticleReader({
  store,
  speak,
  stop,
  onCommit,
  onFinalize,
  onRefresh
}: {
  store: AppStore;
  speak: (text: string, lang?: string) => Promise<void>;
  stop: () => void;
  onCommit: (store: AppStore) => Promise<unknown>;
  onFinalize: (store: AppStore, ids?: number[]) => Promise<{ aiMessage: string; cloudMessage?: string }>;
  onRefresh: () => Promise<void>;
}) {
  const [activeId, setActiveId] = useState<number | null>(store.articles[0]?.id ?? null);
  const [status, setStatus] = useState('');
  const [readingIndex, setReadingIndex] = useState<number | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [editingArticle, setEditingArticle] = useState(false);
  const [expandedArticleWord, setExpandedArticleWord] = useState<{ id: number; sentenceIndex: number; collapsed: boolean } | null>(null);
  const [articleDraft, setArticleDraft] = useState({ title: '', source: '', text: '' });
  const activeArticle = store.articles.find((article) => article.id === activeId) ?? store.articles[0];
  const sentences = useMemo(() => activeArticle ? splitSentences(activeArticle.text) : [], [activeArticle]);
  const articleParagraphs = useMemo(() => activeArticle ? splitArticleParagraphs(activeArticle.text) : [], [activeArticle]);
  const articleVocabItems = useMemo(() => activeArticle ? vocabForArticle(store, activeArticle) : [], [store, activeArticle]);

  useEffect(() => () => stop(), [stop]);

  async function addSelectedWordFromArticle() {
    if (!activeArticle) return;
    const selection = window.getSelection()?.toString().trim() ?? '';
    const selectedSurface = selection.replace(/^[^A-Za-z'-]+|[^A-Za-z'-]+$/g, '');
    const word = await resolveImportedWord(store.settings, selectedSurface);
    if (!word) {
      setStatus('请先在文章中选中一个英文单词。');
      return;
    }
    const sentence = sentenceForWord(activeArticle.text, selectedSurface || word);
    const now = todayIso();
    const next = cloneStore(store);
    const quoteId = next.nextIds.quote++;
    const quote: Quote = {
      id: quoteId,
      text: sentence,
      source: activeArticle.title,
      tags: ['article'],
      vocabIds: [],
      createdAt: now
    };
    const vocabId = await upsertVocabFromExample(next, {
      word,
      quoteId,
      quoteText: sentence,
      source: activeArticle.title,
      now
    });
    quote.vocabIds.push(vocabId);
    next.quotes.push(quote);
    const result = await onFinalize(next, [vocabId]);
    await onRefresh();
    setStatus(`Added from article: ${word}. ${result.aiMessage} ${result.cloudMessage ?? ''}`);
  }

  function toggleArticleWordCard(item: VocabItem, sentenceIndex: number) {
    if (!item.id) return;
    const vocabId = item.id;
    setExpandedArticleWord((current) => {
      if (current?.id === vocabId && current.sentenceIndex === sentenceIndex) {
        return { ...current, collapsed: !current.collapsed };
      }
      return { id: vocabId, sentenceIndex, collapsed: false };
    });
  }

  async function translateSelectionForArticle() {
    if (!activeArticle) return;
    const selection = window.getSelection()?.toString().trim() ?? '';
    const text = selection.replace(/^\s+|\s+$/g, '');
    if (!/[A-Za-z]/.test(text)) {
      setStatus('请先在文章中选中英文单词或短语。');
      return;
    }
    setStatus('正在翻译选中内容...');
    try {
      const now = todayIso();
      const translationZh = await requestArticleTranslation(store.settings, text);
      const next = cloneStore(store);
      const annotation: ArticleAnnotation = {
        id: Date.now(),
        text,
        translationZh,
        createdAt: now,
        updatedAt: now
      };
      next.articles = next.articles.map((article) =>
        article.id === activeArticle.id
          ? { ...article, annotations: [...(article.annotations ?? []), annotation], updatedAt: now }
          : article
      );
      await onCommit(next);
      setStatus(`已添加文章注释：${text}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '划词翻译失败');
    }
  }

  async function deleteArticleAnnotation(annotationId: number) {
    if (!activeArticle) return;
    const now = todayIso();
    const next = cloneStore(store);
    next.articles = next.articles.map((article) =>
      article.id === activeArticle.id
        ? { ...article, annotations: (article.annotations ?? []).filter((annotation) => annotation.id !== annotationId), updatedAt: now }
        : article
    );
    await onCommit(next);
  }

  async function readArticle() {
    if (!activeArticle || sentences.length === 0) return;
    setIsReading(true);
    try {
      for (let i = 0; i < sentences.length; i += 1) {
        setReadingIndex(i);
        await speak(sentences[i], 'en-US');
      }
    } finally {
      setIsReading(false);
      setReadingIndex(null);
    }
  }

  function stopReading() {
    stop();
    setIsReading(false);
    setReadingIndex(null);
  }

  function startArticleEdit(article: Article) {
    setArticleDraft({ title: article.title, source: article.source ?? '', text: article.text });
    setEditingArticle(true);
  }

  async function saveArticleEdit(id: number) {
    const now = todayIso();
    const next = cloneStore(store);
    next.articles = next.articles.map((article) =>
      article.id === id
        ? { ...article, title: articleDraft.title, source: articleDraft.source, text: cleanEnglishArticle(articleDraft.text), updatedAt: now }
        : article
    );
    await onCommit(next);
    setEditingArticle(false);
    setStatus('文章已更新。');
  }

  return (
    <section className="screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Read</p>
          <h2>文章阅读</h2>
        </div>
        <span className="pill">{store.articles.length} 篇</span>
      </header>
      <div className="article-reader-layout">
        <aside className="article-list">
          {store.articles.map((article) => (
            <button key={article.id} className={activeArticle?.id === article.id ? 'active' : ''} onClick={() => setActiveId(article.id ?? null)}>
              <span>{article.title}</span>
              <small>{formatDate(article.createdAt)}</small>
            </button>
          ))}
        </aside>
        <article className="article-reader">
          {activeArticle ? (
            <>
              {editingArticle ? (
                <div className="edit-grid">
                  <label className="field">
                    <span>标题</span>
                    <input value={articleDraft.title} onChange={(event) => setArticleDraft({ ...articleDraft, title: event.target.value })} />
                  </label>
                  <label className="field">
                    <span>来源</span>
                    <input value={articleDraft.source} onChange={(event) => setArticleDraft({ ...articleDraft, source: event.target.value })} />
                  </label>
                  <label className="field wide">
                    <span>正文</span>
                    <textarea value={articleDraft.text} onChange={(event) => setArticleDraft({ ...articleDraft, text: event.target.value })} />
                  </label>
                  <div className="card-actions">
                    <button className="primary" onClick={() => saveArticleEdit(activeArticle.id!)}>保存文章</button>
                    <button onClick={() => setEditingArticle(false)}>取消</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="word-entry-head">
                    <div>
                      <small>导入日期：{formatDate(activeArticle.createdAt)}</small>
                      <h3>{activeArticle.title}</h3>
                      <small>{activeArticle.source || '未填写来源'}</small>
                    </div>
                    <div className="card-actions article-actions">
                      <button onClick={isReading ? stopReading : readArticle}>{isReading ? '停止朗读' : '朗读文章'}</button>
                      <button onClick={() => startArticleEdit(activeArticle)}>编辑文章</button>
                    </div>
                  </div>
                  <div className="floating-article-actions">
                    <button className="floating-add-word" onClick={addSelectedWordFromArticle}>加入选中词</button>
                    <button className="floating-note-button" onClick={translateSelectionForArticle}>翻译选中内容</button>
                  </div>
                  <div className="article-text">
                    {articleParagraphs.map((paragraph, paragraphIndex) => (
                      <div className="article-paragraph" key={`${activeArticle.id}-paragraph-${paragraphIndex}`}>
                        {paragraph.map(({ sentence, sentenceIndex }) => {
                          const sentenceNotes = annotationsForSentence(sentence, activeArticle.annotations ?? []);
                          return (
                            <span className="sentence-flow" key={`${activeArticle.id}-${sentenceIndex}`}>
                              <span className={readingIndex === sentenceIndex ? 'reading-now sentence-chunk' : 'sentence-chunk'}>
                            {renderArticleHighlights(sentence, articleVocabItems, activeArticle.annotations ?? [], (item) => toggleArticleWordCard(item, sentenceIndex))}
                          </span>{' '}
                              {sentenceNotes.length ? (
                                <span className="inline-article-notes">
                                  {sentenceNotes.map((annotation) => (
                                    <span className="inline-article-note" key={annotation.id}>
                                      <strong>{annotation.text}</strong>
                                      <span>{annotation.translationZh}</span>
                                    </span>
                                  ))}
                                </span>
                              ) : null}
                              {expandedArticleWord?.sentenceIndex === sentenceIndex ? (
                                <span className="inline-word-card">
                                  <button
                                    className="small-btn"
                                    onClick={() => setExpandedArticleWord((current) => current ? { ...current, collapsed: !current.collapsed } : current)}
                                  >
                                    {expandedArticleWord.collapsed ? '展开词卡' : '折叠词卡'}
                                  </button>
                                  {!expandedArticleWord.collapsed ? (
                                    (() => {
                                      const item = articleVocabItems.find((candidate) => candidate.id === expandedArticleWord.id);
                                      return item ? (
                                        <span className="article-mini-card selected">
                                          <span className="article-card-head">
                                            <span>
                                              <strong>{item.word}</strong>
                                              <small>{partOfSpeechZh(item.aiPartOfSpeech || item.partOfSpeech)} · {item.aiPhonetic || item.phonetic || '音标待补'}</small>
                                            </span>
                                            <button className="small-btn" onClick={() => speak(item.word)}>朗读单词</button>
                                          </span>
                                          <WordBlocks item={item} />
                                          <ExamplesBlock item={item} speak={speak} />
                                        </span>
                                      ) : null;
                                    })()
                                  ) : null}
                                </span>
                              ) : null}
                            </span>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                  <div className="article-bottom-panels">
                    <section>
                      <h3>文章词卡</h3>
                      {articleVocabItems.length ? articleVocabItems.map((item) => (
                        <div className="article-mini-card" key={item.id}>
                          <div className="article-card-head">
                            <div>
                              <strong>{item.word}</strong>
                              <small>{partOfSpeechZh(item.aiPartOfSpeech || item.partOfSpeech)} · {item.aiPhonetic || item.phonetic || '音标待补'}</small>
                            </div>
                            <button className="small-btn" onClick={() => speak(item.word)}>朗读单词</button>
                          </div>
                          <WordBlocks item={item} />
                          <ExamplesBlock item={item} speak={speak} />
                        </div>
                      )) : <p className="meta">还没有从这篇文章加入词库的单词。</p>}
                    </section>
                  </div>
                </>
              )}
            </>
          ) : (
            <p>还没有文章存档。</p>
          )}
        </article>
      </div>
      {status ? <p className="status">{status}</p> : null}
    </section>
  );
}

function Library({
  store,
  initialTab,
  speak,
  onCommit,
  onFinalize,
  onRefresh
}: {
  store: AppStore;
  initialTab: LibraryTab;
  speak: (text: string, lang?: string) => Promise<void>;
  onCommit: (store: AppStore) => Promise<unknown>;
  onFinalize: (store: AppStore, ids?: number[]) => Promise<{ aiMessage: string; cloudMessage?: string }>;
  onRefresh: () => Promise<void>;
}) {
  const [tab, setTab] = useState<LibraryTab>(initialTab);
  const [sortMode, setSortMode] = useState<LibrarySortMode>('createdDesc');
  const [search, setSearch] = useState('');
  const [editingWord, setEditingWord] = useState<number | null>(null);
  const [editingQuote, setEditingQuote] = useState<number | null>(null);
  const [libraryStatus, setLibraryStatus] = useState('');
  const [wordDraft, setWordDraft] = useState({
    word: '',
    meaningZh: '',
    partOfSpeech: '',
    phonetic: '',
    note: '',
    aiMeaningZh: '',
    aiPartOfSpeech: '',
    aiPhonetic: '',
    aiOtherMeanings: '',
    aiRootFamily: '',
    aiNote: '',
    examples: ''
  });
  const [quoteDraft, setQuoteDraft] = useState({ text: '', source: '', tags: '', vocabWords: '' });

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  function startEdit(item: VocabItem) {
    setEditingWord(item.id ?? null);
    setWordDraft({
      word: item.word,
      meaningZh: item.meaningZh,
      partOfSpeech: item.partOfSpeech ?? '',
      phonetic: item.phonetic ?? '',
      note: item.note ?? '',
      aiMeaningZh: item.aiMeaningZh ?? '',
      aiPartOfSpeech: item.aiPartOfSpeech ?? '',
      aiPhonetic: item.aiPhonetic ?? '',
      aiOtherMeanings: formatSenseList(item.aiOtherMeanings),
      aiRootFamily: formatRootFamily(item.aiRootFamily),
      aiNote: item.aiNote ?? '',
      examples: JSON.stringify(item.examples ?? [], null, 2)
    });
  }

  async function saveEdit(id: number) {
    const next = cloneStore(store);
    next.vocab = next.vocab.map((item) =>
      item.id === id
        ? {
          ...item,
          word: wordDraft.word,
          meaningZh: wordDraft.meaningZh,
          partOfSpeech: wordDraft.partOfSpeech,
          phonetic: wordDraft.phonetic,
          note: wordDraft.note,
          aiMeaningZh: wordDraft.aiMeaningZh,
          aiPartOfSpeech: wordDraft.aiPartOfSpeech,
          aiPhonetic: wordDraft.aiPhonetic,
          aiOtherMeanings: parseSenseDraft(wordDraft.aiOtherMeanings),
          aiRootFamily: parseRootFamilyDraft(wordDraft.aiRootFamily),
          aiNote: wordDraft.aiNote,
          examples: parseExamplesDraft(wordDraft.examples, item.examples ?? []),
          updatedAt: todayIso()
        }
        : item
    );
    await onCommit(next);
    setEditingWord(null);
    setLibraryStatus('Saved word edits.');
  }

  async function completeCurrentWord(id: number) {
    const target = store.vocab.find((item) => item.id === id);
    if (!target) return;
    setLibraryStatus(`Completing AI annotation for ${target.word}...`);
    const result = await onFinalize(cloneStore(store), [id]);
    await onRefresh();
    setLibraryStatus(`AI completed for ${target.word}. ${result.aiMessage} ${result.cloudMessage ?? ''}`);
  }

  function startQuoteEdit(quote: Quote) {
    setEditingQuote(quote.id ?? null);
    setQuoteDraft({
      text: quote.text,
      source: quote.source ?? '',
      tags: quote.tags.join(', '),
      vocabWords: quote.vocabIds
        .map((id) => store.vocab.find((item) => item.id === id)?.word)
        .filter(Boolean)
        .join(', ')
    });
  }

  async function deleteWord(id: number) {
    const target = store.vocab.find((item) => item.id === id);
    if (!target) return;
    if (!window.confirm(`Delete ${target.word}? This will also remove its review history and quote links.`)) return;
    const next = cloneStore(store);
    next.vocab = next.vocab.filter((item) => item.id !== id);
    next.reviews = next.reviews.filter((review) => review.vocabId !== id);
    next.quotes = next.quotes.map((quote) => ({
      ...quote,
      vocabIds: quote.vocabIds.filter((vocabId) => vocabId !== id)
    }));
    await onCommit(next);
    if (editingWord === id) setEditingWord(null);
  }

  async function saveQuoteEdit(id: number) {
    const next = cloneStore(store);
    const words = splitWords(quoteDraft.vocabWords);
    const vocabIds = next.vocab
      .filter((item) => words.some((word) => word.toLowerCase() === item.word.toLowerCase()))
      .map((item) => item.id!)
      .filter(Boolean);
    next.quotes = next.quotes.map((quote) =>
      quote.id === id
        ? { ...quote, text: quoteDraft.text, source: quoteDraft.source, tags: splitWords(quoteDraft.tags), vocabIds }
        : quote
    );
    next.vocab = next.vocab.map((item) =>
      vocabIds.includes(item.id!)
        ? { ...item, quoteText: quoteDraft.text, updatedAt: todayIso() }
        : item
    );
    await onCommit(next);
    setEditingQuote(null);
  }

  const normalizedSearch = search.trim().toLowerCase();
  const words = sortVocab(store.vocab, sortMode).filter((item) =>
    !normalizedSearch ||
    item.word.toLowerCase().includes(normalizedSearch) ||
    (item.aiMeaningZh || item.meaningZh).toLowerCase().includes(normalizedSearch)
  );
  const quotes = sortQuotes(store.quotes, sortMode).filter((quote) =>
    !normalizedSearch ||
    quote.text.toLowerCase().includes(normalizedSearch) ||
    (quote.source ?? '').toLowerCase().includes(normalizedSearch) ||
    quote.tags.some((tag) => tag.toLowerCase().includes(normalizedSearch))
  );

  return (
    <section className="screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Library</p>
          <h2>摘录库</h2>
        </div>
      </header>

      <div className="library-toolbar">
        <div className="segmented">
          <button className={tab === 'words' ? 'active' : ''} onClick={() => setTab('words')}>重点词</button>
          <button className={tab === 'quotes' ? 'active' : ''} onClick={() => setTab('quotes')}>摘录</button>
        </div>
        <select value={sortMode} onChange={(event) => setSortMode(event.target.value as LibrarySortMode)}>
          <option value="alphabet">字母表顺序</option>
          <option value="createdDesc">导入顺序：新到旧</option>
          <option value="createdAsc">导入顺序：旧到新</option>
        </select>
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tab === 'words' ? '搜索词汇或释义' : '搜索摘录、来源或标签'} />
      </div>

      {tab === 'words' ? (
        <div className="word-list">
          {words.map((item) => (
            <article className="word-entry" key={item.id}>
              <div className="word-entry-head">
                <div className="word-title">
                  <h3>{item.word}</h3>
                  <em>{partOfSpeechZh(item.aiPartOfSpeech || item.partOfSpeech)}</em>
                </div>
                <div className="pronounce">
                  <span>{item.aiPhonetic || item.phonetic || '音标待补'}</span>
                  <button className="icon-btn" title="朗读单词" onClick={() => speak(item.word)}>▶</button>
                </div>
              </div>
              {editingWord === item.id ? (
                <div className="edit-grid">
                  <label className="field"><span>单词</span><input value={wordDraft.word} onChange={(event) => setWordDraft({ ...wordDraft, word: event.target.value })} /></label>
                  <label className="field"><span>词性</span><input value={wordDraft.partOfSpeech} onChange={(event) => setWordDraft({ ...wordDraft, partOfSpeech: event.target.value })} /></label>
                  <label className="field"><span>音标</span><input value={wordDraft.phonetic} onChange={(event) => setWordDraft({ ...wordDraft, phonetic: event.target.value })} /></label>
                  <label className="field wide"><span>原始释义</span><textarea value={wordDraft.meaningZh} onChange={(event) => setWordDraft({ ...wordDraft, meaningZh: event.target.value })} /></label>
                  <label className="field wide"><span>原始笔记</span><textarea value={wordDraft.note} onChange={(event) => setWordDraft({ ...wordDraft, note: event.target.value })} /></label>
                  <label className="field"><span>AI 词性</span><input value={wordDraft.aiPartOfSpeech} onChange={(event) => setWordDraft({ ...wordDraft, aiPartOfSpeech: event.target.value })} /></label>
                  <label className="field"><span>AI 音标</span><input value={wordDraft.aiPhonetic} onChange={(event) => setWordDraft({ ...wordDraft, aiPhonetic: event.target.value })} /></label>
                  <label className="field wide"><span>AI 含义</span><textarea value={wordDraft.aiMeaningZh} onChange={(event) => setWordDraft({ ...wordDraft, aiMeaningZh: event.target.value })} /></label>
                  <label className="field wide"><span>其他意思</span><textarea value={wordDraft.aiOtherMeanings} onChange={(event) => setWordDraft({ ...wordDraft, aiOtherMeanings: event.target.value })} /></label>
                  <label className="field wide"><span>同词根常用词</span><textarea value={wordDraft.aiRootFamily} onChange={(event) => setWordDraft({ ...wordDraft, aiRootFamily: event.target.value })} /></label>
                  <label className="field wide"><span>AI 笔记</span><textarea value={wordDraft.aiNote} onChange={(event) => setWordDraft({ ...wordDraft, aiNote: event.target.value })} /></label>
                  <label className="field wide"><span>例句 JSON</span><textarea value={wordDraft.examples} onChange={(event) => setWordDraft({ ...wordDraft, examples: event.target.value })} /></label>
                  <div className="card-actions">
                    <button className="primary" onClick={() => saveEdit(item.id!)}>保存</button>
                    <button onClick={() => completeCurrentWord(item.id!)}>AI 补全当前词</button>
                    <button onClick={() => setEditingWord(null)}>取消</button>
                  </div>
                </div>
              ) : (
                <>
                  <WordBlocks item={item} />
                  <ExamplesBlock item={item} speak={speak} />
                  <div className="card-actions">
                    <button onClick={() => startEdit(item)}>编辑全部内容</button>
                    <button className="danger" onClick={() => deleteWord(item.id!)}>删除单词</button>
                  </div>
                </>
              )}
            </article>
          ))}
        </div>
      ) : (
        <div className="word-list">
          {quotes.map((quote) => (
            <article className="word-entry" key={quote.id}>
              {editingQuote === quote.id ? (
                <div className="edit-grid">
                  <label className="field wide"><span>摘录</span><textarea value={quoteDraft.text} onChange={(event) => setQuoteDraft({ ...quoteDraft, text: event.target.value })} /></label>
                  <label className="field"><span>来源</span><input value={quoteDraft.source} onChange={(event) => setQuoteDraft({ ...quoteDraft, source: event.target.value })} /></label>
                  <label className="field"><span>标签</span><input value={quoteDraft.tags} onChange={(event) => setQuoteDraft({ ...quoteDraft, tags: event.target.value })} /></label>
                  <label className="field wide"><span>关联词</span><input value={quoteDraft.vocabWords} onChange={(event) => setQuoteDraft({ ...quoteDraft, vocabWords: event.target.value })} /></label>
                  <div className="card-actions">
                    <button className="primary" onClick={() => saveQuoteEdit(quote.id!)}>保存</button>
                    <button onClick={() => setEditingQuote(null)}>取消</button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="quote-text">{quote.text}</p>
                  <p className="meta">{quote.source || '未填写来源'} · {formatDate(quote.createdAt)}</p>
                  <p className="meta">标签：{quote.tags.join('、') || '无'} · 关联词：{quote.vocabIds.map((id) => store.vocab.find((item) => item.id === id)?.word).filter(Boolean).join('、') || '无'}</p>
                  <div className="card-actions">
                    <button onClick={() => speak(quote.text)}>朗读摘录</button>
                    <button onClick={() => startQuoteEdit(quote)}>编辑摘录</button>
                  </div>
                </>
              )}
            </article>
          ))}
        </div>
      )}
      {libraryStatus ? <p className="status">{libraryStatus}</p> : null}
    </section>
  );
}

function Review({
  store,
  speak,
  stop,
  onCommit
}: {
  store: AppStore;
  speak: (text: string, lang?: string) => Promise<void>;
  stop: () => void;
  onCommit: (store: AppStore) => Promise<unknown>;
}) {
  const [mode, setMode] = useState<ReviewMode>('due');
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [randomId, setRandomId] = useState<number | null>(null);
  const [recentStudyIds, setRecentStudyIds] = useState<number[]>([]);
  const due = useMemo(() => sortByReviewPriority(store.vocab.filter((item) => isDue(item))), [store.vocab]);
  const focus = useMemo(() => {
    const fresh = sortByReviewPriority(store.vocab.filter((item) => !item.id || !recentStudyIds.includes(item.id)));
    return (fresh.length ? fresh : sortByReviewPriority(store.vocab)).slice(0, 20);
  }, [store.vocab, recentStudyIds]);
  const listenQueue = useMemo(() => sortByReviewPriority(store.vocab), [store.vocab]);
  const queue = mode === 'focus' ? focus : mode === 'listen' ? listenQueue : due;
  const randomCurrent = mode === 'random'
    ? store.vocab.find((item) => item.id === randomId) ?? null
    : null;
  const current = mode === 'random' ? randomCurrent : queue[index];
  const total = mode === 'random' ? (current ? 1 : 0) : queue.length;

  useEffect(() => {
    if (mode !== 'listen' || !current) return;
    let cancelled = false;
    const card = current;
    async function playCurrentCard() {
      setRevealed(true);
      try {
        await speak(card.word, 'en-US');
        if (cancelled) return;
        await speak(card.aiMeaningZh || card.meaningZh || '暂无释义', 'zh-CN');
        if (cancelled) return;
        const example = primaryExample(card);
        if (example?.text) {
          await speak(example.text, 'en-US');
        }
      } catch {
        // 单个浏览器朗读失败时，继续切到下一张，避免听音模式停死。
      }
      if (!cancelled) {
        setIndex((value) => (value + 1) % Math.max(1, queue.length));
      }
    }
    void playCurrentCard();
    return () => {
      cancelled = true;
      stop();
    };
  }, [mode, current?.id]);

  useEffect(() => {
    if (mode === 'listen' || !current) return;
    let cancelled = false;
    const card = current;
    async function playReviewCard() {
      try {
        await speak(card.word, 'en-US');
        if (cancelled) return;
        const example = primaryExample(card);
        if (example?.text) await speak(example.text, 'en-US');
      } catch {
        // Individual speech failures should not block review.
      }
    }
    void playReviewCard();
    return () => {
      cancelled = true;
      stop();
    };
  }, [mode, current?.id]);

  function changeMode(nextMode: ReviewMode) {
    setMode(nextMode);
    setIndex(0);
    setRevealed(false);
    stop();
    if (nextMode === 'random') {
      void drawRandom();
    }
  }

  async function drawRandom(baseStore = store, extraExcludedIds: number[] = []) {
    const candidates = baseStore.vocab.filter((item) => !item.id || (!recentStudyIds.includes(item.id) && !extraExcludedIds.includes(item.id)));
    const nextRandom = weightedRandomVocab(candidates.length ? candidates : baseStore.vocab);
    if (!nextRandom?.id) {
      setRandomId(null);
      return;
    }
    const next = cloneStore(baseStore);
    next.vocab = next.vocab.map((item) =>
      item.id === nextRandom.id
        ? {
          ...item,
          randomStudyCount: (item.randomStudyCount ?? 0) + 1,
          lastRandomAt: todayIso(),
          updatedAt: todayIso()
        }
        : item
    );
    await onCommit(next);
    setRandomId(nextRandom.id);
    rememberStudied(nextRandom.id);
    setRevealed(false);
  }

  function rememberStudied(id?: number) {
    if (!id) return;
    setRecentStudyIds((ids) => [id, ...ids.filter((itemId) => itemId !== id)].slice(0, Math.max(3, Math.ceil(store.vocab.length / 2))));
  }

  function nextListenCard() {
    stop();
    setRevealed(false);
    setIndex((value) => (value + 1) % Math.max(1, listenQueue.length));
  }

  async function rate(rating: ReviewRating) {
    if (!current?.id) return;
    const nextState = nextReviewState(current, rating, store.settings.intervals);
    const next = cloneStore(store);
    next.vocab = next.vocab.map((item) =>
      item.id === current.id
        ? {
          ...item,
          ...nextState,
          updatedAt: todayIso()
        }
        : item
    );
    next.reviews.push({
      id: next.nextIds.review++,
      vocabId: current.id,
      reviewedAt: todayIso(),
      rating,
      previousStep: current.reviewStep,
      nextStep: nextState.reviewStep,
      nextReviewAt: nextState.nextReviewAt
    });
    await onCommit(next);
    rememberStudied(current.id);
    setRevealed(false);
    if (mode === 'random') {
      await drawRandom(next, [current.id]);
    } else if (mode === 'listen') {
      setIndex((value) => (value + 1) % Math.max(1, queue.length));
    } else {
      setIndex((value) => Math.min(value, Math.max(0, queue.length - 2)));
    }
  }

  return (
    <section className="screen review-screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Review</p>
          <h2>今日复习</h2>
        </div>
        <span className="pill">{due.length} 到期</span>
      </header>

      <div className="segmented review-mode-tabs">
        <button className={mode === 'due' ? 'active' : ''} onClick={() => changeMode('due')}>到期</button>
        <button className={mode === 'focus' ? 'active' : ''} onClick={() => changeMode('focus')}>补学</button>
        <button className={mode === 'random' ? 'active' : ''} onClick={() => changeMode('random')}>随机</button>
        <button className={mode === 'listen' ? 'active' : ''} onClick={() => changeMode('listen')}>听音</button>
      </div>

      {current ? (
        <article className="review-card">
          <div className="review-word">
            <span>{mode === 'random' ? '随机抽词' : mode === 'listen' ? `听音循环 ${index + 1} / ${total}` : `${index + 1} / ${total}`}</span>
            <div className="word-title">
              <h3>{current.word}</h3>
              <em>{partOfSpeechZh(current.aiPartOfSpeech || current.partOfSpeech)}</em>
              <small className="review-phonetic">{current.aiPhonetic || current.phonetic || '音标待补'}</small>
            </div>
            <button className="icon-btn" title="朗读单词" onClick={() => speak(current.word)}>▶</button>
          </div>
          <blockquote>{current.quoteText}</blockquote>
          <div className="review-actions">
            <button className="ghost" onClick={() => setRevealed((value) => !value)}>{revealed ? '隐藏释义' : '显示释义'}</button>
            <button onClick={() => speak(current.quoteText)}>朗读原句</button>
            {mode === 'random' ? <button onClick={() => void drawRandom()}>换一个</button> : null}
            {mode === 'listen' ? <button onClick={nextListenCard}>下一个</button> : null}
            {mode === 'listen' ? <button onClick={() => changeMode('due')}>停止听音</button> : null}
          </div>
          {revealed ? (
            <div className="answer">
              <WordBlocks item={current} />
            </div>
          ) : null}
          <div className="rating-row">
            {(Object.keys(RATING_LABEL) as ReviewRating[]).map((rating) => (
              <button key={rating} onClick={() => rate(rating)}>{RATING_LABEL[rating]}</button>
            ))}
          </div>
        </article>
      ) : (
        <div className="empty-state">
          <h3>{mode === 'random' ? '词库里还没有可随机学习的词' : '今天没有到期词卡'}</h3>
          <p>{mode === 'focus' || mode === 'listen' ? '会从薄弱、久未学习、逾期风险高的词里优先挑选。' : '新增摘录后，重点词会自动进入复习队列。'}</p>
        </div>
      )}
    </section>
  );
}

function Report({ quotes, vocab, reviews }: { quotes: Quote[]; vocab: VocabItem[]; reviews: ReviewLog[] }) {
  const [range, setRange] = useState<7 | 30>(7);
  const since = useMemo(() => {
    const date = new Date();
    date.setDate(date.getDate() - range);
    return date;
  }, [range]);
  const newQuotes = quotes.filter((quote) => new Date(quote.createdAt) >= since);
  const newVocab = vocab.filter((item) => new Date(item.createdAt) >= since);
  const recentReviews = reviews.filter((review) => new Date(review.reviewedAt) >= since);
  const weakWords = vocab.slice().sort((a, b) => a.mastery - b.mastery).slice(0, 6);
  const dueNow = vocab.filter((item) => isDue(item)).length;
  const completedRate = recentReviews.length + dueNow === 0 ? 100 : Math.round((recentReviews.length / (recentReviews.length + dueNow)) * 100);

  return (
    <section className="screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Report</p>
          <h2>学习报告</h2>
        </div>
        <div className="segmented">
          <button className={range === 7 ? 'active' : ''} onClick={() => setRange(7)}>周</button>
          <button className={range === 30 ? 'active' : ''} onClick={() => setRange(30)}>月</button>
        </div>
      </header>
      <div className="metric-grid">
        <Metric label="新增摘录" value={newQuotes.length} />
        <Metric label="新增重点词" value={newVocab.length} />
        <Metric label="完成复习" value={recentReviews.length} />
        <Metric label="复习完成率" value={`${completedRate}%`} />
      </div>
      <div className="report-columns">
        <section>
          <h3>薄弱词</h3>
          {weakWords.map((item) => (
            <p className="report-line" key={item.id}>
              <strong>{item.word}</strong>
              <span>掌握度 {item.mastery}/10 · 下次 {formatDate(item.nextReviewAt)}</span>
            </p>
          ))}
        </section>
        <section>
          <h3>最近来源</h3>
          {newQuotes.slice(0, 6).map((quote) => (
            <p className="report-line" key={quote.id}>
              <strong>{quote.source || '未填写来源'}</strong>
              <span>{quote.text.slice(0, 72)}{quote.text.length > 72 ? '...' : ''}</span>
            </p>
          ))}
        </section>
      </div>
    </section>
  );
}

function Settings({
  store,
  onChange,
  onCommit,
  onFinalize,
  onRefresh,
  onSyncNotice
}: {
  store: AppStore;
  onChange: (settings: AppSettings) => Promise<void>;
  onCommit: (store: AppStore) => Promise<AppStore>;
  onFinalize: (store: AppStore, ids?: number[]) => Promise<{ aiMessage: string; cloudMessage?: string }>;
  onRefresh: () => Promise<void>;
  onSyncNotice: (message: string) => void;
}) {
  const [status, setStatus] = useState('');
  const [syncStatus, setSyncStatus] = useState('');
  const [syncBusy, setSyncBusy] = useState<'test' | 'pull' | 'push' | 'overwrite' | ''>('');
  const [syncConfig, setSyncConfig] = useState<SyncConfig>(() => loadSyncConfig());

  function updateSyncConfig(patch: Partial<SyncConfig>) {
    const next = { ...syncConfig, ...patch };
    setSyncConfig(next);
    saveSyncConfig(next);
  }

  function rememberSync(result: Awaited<ReturnType<typeof pushStoreToGist>>) {
    const next = rememberSuccessfulSync(syncConfig, result);
    setSyncConfig(next);
    return next;
  }

  async function exportData() {
    downloadJson('golden-lines-' + new Date().toISOString().slice(0, 10) + '.json', store);
  }

  async function importData(file?: File) {
    if (!file) return;
    setStatus('Importing, completing AI annotations, then syncing to cloud...');
    const imported = await readJsonFile<AppStore>(file);
    const ids = (imported.vocab ?? []).map((item) => item.id).filter(Boolean) as number[];
    const result = await onFinalize(imported, ids);
    await onRefresh();
    setStatus('Import complete. ' + result.aiMessage + ' ' + (result.cloudMessage ?? ''));
  }

  async function testConnection() {
    setSyncBusy('test');
    setSyncStatus('Testing GitHub Gist connection...');
    try {
      setSyncStatus(await testGistConnection(syncConfig));
    } catch (error) {
      setSyncStatus(error instanceof Error ? error.message : 'Connection test failed.');
    } finally {
      setSyncBusy('');
    }
  }

  async function pullFromCloud() {
    setSyncBusy('pull');
    setSyncStatus('Pulling data from GitHub Gist...');
    try {
      const result = await pullStoreFromGist(syncConfig);
      rememberSync(result);
      await saveStore(result.store);
      await onRefresh();
      onSyncNotice('Pulled cloud data into this browser.');
      setSyncStatus('Cloud data loaded. ' + result.store.vocab.length + ' words are available locally.');
    } catch (error) {
      setSyncStatus(error instanceof Error ? error.message : 'Cloud pull failed.');
    } finally {
      setSyncBusy('');
    }
  }

  async function pushToCloud() {
    setSyncBusy('push');
    setSyncStatus('Pushing local data to GitHub Gist...');
    try {
      const result = await pushStoreToGist(syncConfig, store);
      const nextConfig = rememberSync(result);
      onSyncNotice('Pushed local data to Gist ' + nextConfig.gistId + '.');
      setSyncStatus('Cloud sync complete. Gist ID: ' + nextConfig.gistId);
    } catch (error) {
      setSyncStatus(error instanceof Error ? error.message : 'Cloud push failed.');
    } finally {
      setSyncBusy('');
    }
  }

  async function overwriteCloud() {
    setSyncBusy('overwrite');
    setSyncStatus('Overwriting GitHub Gist with local data...');
    try {
      const result = await overwriteGist(syncConfig, store);
      const nextConfig = rememberSync(result);
      onSyncNotice('Cloud data overwritten in Gist ' + nextConfig.gistId + '.');
      setSyncStatus('Cloud overwrite complete. Gist ID: ' + nextConfig.gistId);
    } catch (error) {
      setSyncStatus(error instanceof Error ? error.message : 'Cloud overwrite failed.');
    } finally {
      setSyncBusy('');
    }
  }

  async function updateAnnotationsWithApi() {
    setStatus('Updating AI annotations, then syncing to cloud...');
    const ids = store.vocab.map((item) => item.id).filter(Boolean) as number[];
    const result = await onFinalize(store, ids);
    setStatus(result.aiMessage + ' ' + (result.cloudMessage ?? ''));
    await onRefresh();
  }

  async function testSpeech() {
    setStatus('Testing speech...');
    try {
      await createTtsProvider(store.settings.ttsMode).speak('Speech is ready.', 'en-US');
      setStatus('Speech test complete.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Speech is not available in this browser.');
    }
  }

  return (
    <section className="screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Settings</p>
          <h2>Settings</h2>
        </div>
        <button onClick={onRefresh}>Reload local cache</button>
      </header>
      <div className="settings-list">
        <div className="codex-panel sync-panel">
          <div>
            <h3>GitHub Gist Sync</h3>
            <p>Data is saved in this browser first, then synced to a Gist JSON file. The token stays only in local browser storage.</p>
          </div>
          <label className="field">
            <span>GitHub Token</span>
            <input type="password" value={syncConfig.token} onChange={(event) => updateSyncConfig({ token: event.target.value })} placeholder="Token with gist permission" />
          </label>
          <label className="field">
            <span>Gist ID</span>
            <input value={syncConfig.gistId} onChange={(event) => updateSyncConfig({ gistId: event.target.value.trim() })} placeholder="Leave empty to create a private Gist on first push" />
          </label>
          <label className="field">
            <span>Remote file name</span>
            <input value={syncConfig.fileName} onChange={(event) => updateSyncConfig({ fileName: event.target.value })} placeholder="vocab-store.json" />
          </label>
          <label className="check-row">
            <input type="checkbox" checked={syncConfig.autoSync} onChange={(event) => updateSyncConfig({ autoSync: event.target.checked })} />
            <span>Auto push local changes after saving</span>
          </label>
          <div className="data-actions">
            <button disabled={Boolean(syncBusy)} onClick={testConnection}>{syncBusy === 'test' ? 'Testing...' : 'Test connection'}</button>
            <button disabled={Boolean(syncBusy)} onClick={pullFromCloud}>{syncBusy === 'pull' ? 'Pulling...' : 'Pull from cloud'}</button>
            <button disabled={Boolean(syncBusy)} className="primary" onClick={pushToCloud}>{syncBusy === 'push' ? 'Pushing...' : 'Push to cloud'}</button>
            <button disabled={Boolean(syncBusy)} onClick={overwriteCloud}>{syncBusy === 'overwrite' ? 'Overwriting...' : 'Overwrite cloud'}</button>
          </div>
          <p className="meta">Last sync: {syncConfig.lastSyncAt ? new Date(syncConfig.lastSyncAt).toLocaleString() : 'Never'}</p>
          {syncStatus ? <p className="status sync-panel-status">{syncStatus}</p> : null}
        </div>

        <label className="field">
          <span>Collins API Key</span>
          <input value={store.settings.collinsApiKey} onChange={(event) => onChange({ ...store.settings, collinsApiKey: event.target.value })} placeholder="Optional dictionary fallback" />
        </label>
        <label className="field">
          <span>AI API Key</span>
          <input type="password" value={store.settings.aiApiKey} onChange={(event) => onChange({ ...store.settings, aiApiKey: event.target.value })} placeholder="Only used by local/dev AI helpers" />
        </label>
        <label className="field">
          <span>AI API Base URL</span>
          <input value={store.settings.aiApiBaseUrl} onChange={(event) => onChange({ ...store.settings, aiApiBaseUrl: event.target.value })} placeholder="https://api.deepseek.com" />
        </label>
        <label className="field">
          <span>AI Model</span>
          <input value={store.settings.aiApiModel} onChange={(event) => onChange({ ...store.settings, aiApiModel: event.target.value })} placeholder="deepseek-v4-flash" />
        </label>
        <div className="codex-panel">
          <div>
            <h3>AI annotation helper</h3>
            <p>This uses the AI API settings above directly from the browser. If your provider blocks browser requests, use the desktop/local workflow instead.</p>
          </div>
          <button onClick={updateAnnotationsWithApi}>Update AI annotations</button>
        </div>
        <label className="field">
          <span>Speech mode</span>
          <select value={store.settings.ttsMode} onChange={(event) => onChange({ ...store.settings, ttsMode: event.target.value as AppSettings['ttsMode'] })}>
            <option value="browser">Browser speech</option>
            <option value="future-ai">Future AI voice</option>
          </select>
        </label>
        <div className="data-actions">
          <button onClick={testSpeech}>Test speech</button>
        </div>
        <label className="field">
          <span>Review intervals, days</span>
          <input value={store.settings.intervals.join(', ')} onChange={(event) => onChange({ ...store.settings, intervals: splitWords(event.target.value).map(Number).filter((value) => Number.isFinite(value) && value > 0) })} />
        </label>
        <div className="data-actions">
          <button onClick={exportData}>Export data</button>
          <label className="file-button">
            Import data
            <input type="file" accept="application/json" onChange={(event) => importData(event.target.files?.[0])} />
          </label>
        </div>
        {status ? <p className="status">{status}</p> : null}
      </div>
    </section>
  );
}

function WordBlocks({ item }: { item: VocabItem }) {
  const hasAi = Boolean(item.aiMeaningZh || item.aiPartOfSpeech || item.aiPhonetic || item.aiNote || item.aiOtherMeanings?.length);
  return (
    <div className="word-blocks">
      <InfoBlock title="含义注释" body={item.aiMeaningZh || item.meaningZh || '暂无释义'} emphasis />
      <InfoBlock title="其他意思" body={formatSenseList(item.aiOtherMeanings?.length ? item.aiOtherMeanings : item.otherMeanings)} />
      <InfoBlock title="同词根常用词" body={formatRootFamily(item.aiRootFamily)} />
      <InfoBlock title="学习笔记" body={item.aiNote || item.note || '暂无学习笔记'} />
      {hasAi && (item.meaningZh || item.note || item.partOfSpeech || item.phonetic) ? (
        <InfoBlock
          title="原始词典参考"
          body={[
            item.partOfSpeech ? `词性：${partOfSpeechZh(item.partOfSpeech)}` : '',
            item.phonetic ? `音标：${item.phonetic}` : '',
            item.meaningZh ? `释义：${item.meaningZh}` : '',
            item.note ? `笔记：${item.note}` : ''
          ].filter(Boolean).join('\n')}
          muted
        />
      ) : null}
    </div>
  );
}

function ExamplesBlock({ item, speak }: { item: VocabItem; speak: (text: string, lang?: string) => Promise<void> }) {
  const examples = item.examples?.length
    ? item.examples
    : [{ text: item.quoteText, translationZh: '', addedAt: item.createdAt, quoteId: item.quoteId }];
  return (
    <div className="examples-block">
      <span>例句</span>
      {examples.map((example, index) => (
        <div className="example-row" key={`${example.quoteId ?? item.id}-${index}`}>
          <p>{example.text}</p>
          <small>{example.translationZh || '中文翻译待补'}</small>
          <button className="small-btn" onClick={() => speak(example.text)}>朗读例句</button>
        </div>
      ))}
    </div>
  );
}

function primaryExample(item: VocabItem) {
  return item.examples?.[0] ?? { text: item.quoteText, translationZh: '', addedAt: item.createdAt, quoteId: item.quoteId };
}

function formatSenseList(items?: Array<string | VocabSense>) {
  if (!items?.length) return '暂无其他意思';
  return items.map((entry) => {
    if (typeof entry === 'string') return `词性待补：${entry}`;
    return `${partOfSpeechZh(entry.partOfSpeech)}：${entry.meaningZh}`;
  }).join('\n');
}

function formatRootFamily(items?: Array<string | RootFamilyEntry>) {
  if (!items?.length) return '暂无';
  return items.map((entry) => {
    if (typeof entry === 'string') return `${entry}｜词性待补｜含义待补`;
    return `${entry.word}｜${partOfSpeechZh(entry.partOfSpeech)}｜${entry.meaningZh || '含义待补'}`;
  }).join('\n');
}

function sortVocab(items: VocabItem[], mode: LibrarySortMode) {
  return items.slice().sort((a, b) => {
    if (mode === 'alphabet') return a.word.localeCompare(b.word);
    const diff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return mode === 'createdAsc' ? diff : -diff;
  });
}

function sortQuotes(items: Quote[], mode: LibrarySortMode) {
  return items.slice().sort((a, b) => {
    if (mode === 'alphabet') return a.text.localeCompare(b.text);
    const diff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return mode === 'createdAsc' ? diff : -diff;
  });
}

function parseSenseDraft(value: string): VocabSense[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [partOfSpeech, ...meaningParts] = line.split(/[：:]/);
      return {
        partOfSpeech: meaningParts.length ? partOfSpeech.trim() : '',
        meaningZh: (meaningParts.length ? meaningParts.join('：') : partOfSpeech).trim()
      };
    });
}

function parseRootFamilyDraft(value: string): RootFamilyEntry[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [word, partOfSpeech, meaningZh] = line.split(/[｜|]/).map((part) => part.trim());
      return { word, partOfSpeech, meaningZh };
    })
    .filter((entry) => entry.word);
}

function parseExamplesDraft(value: string, fallback: VocabItem['examples']) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function InfoBlock({ title, body, emphasis = false, muted = false }: { title: string; body: string; emphasis?: boolean; muted?: boolean }) {
  return (
    <div className={`annotation-block ${emphasis ? 'ai' : ''} ${muted ? 'muted-block' : ''}`}>
      <span>{title}</span>
      <p>{body}</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

async function enrichWord({ settings, word, quoteText, manualMeaning }: { settings: AppSettings; word: string; quoteText: string; manualMeaning?: string }) {
  try {
    return await lookupDictionary(word, settings.collinsApiKey, manualMeaning);
  } catch {
    return fallbackEntry(word, manualMeaning || '待 Codex 补全。');
  }
}

async function upsertVocabFromExample(
  store: AppStore,
  {
    word,
    quoteId,
    quoteText,
    source,
    translationZh,
    manualMeaning = '',
    now
  }: {
    word: string;
    quoteId: number;
    quoteText: string;
    source?: string;
    translationZh?: string;
    manualMeaning?: string;
    now: string;
  }
) {
  const normalizedWord = await resolveImportedWord(store.settings, word);
  if (!normalizedWord) throw new Error('No valid English word to import.');
  const existing = store.vocab.find((item) => item.word.toLowerCase() === normalizedWord.toLowerCase());
  const example = { quoteId, text: quoteText, translationZh, source, addedAt: now };
  const vocabId = existing?.id ?? store.nextIds.vocab++;
  if (existing) {
    existing.examples = [...(existing.examples ?? []), example];
    existing.quoteText = existing.quoteText || quoteText;
    existing.updatedAt = now;
    return vocabId;
  }
  const entry = await enrichWord({
    settings: store.settings,
    word: normalizedWord,
    quoteText,
    manualMeaning
  });
  store.vocab.push({
    id: vocabId,
    word: normalizedWord,
    quoteId,
    quoteText,
    examples: [example],
    meaningZh: entry.meaningZh,
    partOfSpeech: entry.partOfSpeech,
    phonetic: entry.phonetic,
    note: entry.note ?? '',
    mastery: 0,
    reviewStep: 0,
    nextReviewAt: now,
    createdAt: now,
    updatedAt: now
  });
  return vocabId;
}

async function generateWordExample(word: string) {
  const store = await loadStore();
  try {
    return await requestWordExample(store.settings, word);
  } catch {
    return {
      text: `I want to learn the word ${word}.`,
      translationZh: `我想学习 ${word} 这个词。`
    };
  }
}

async function updateAnnotationsWithApi(ids?: number[]) {
  return updateAnnotationsWithApiForStore(ids);
}

async function updateAnnotationsWithApiForStore(ids?: number[]) {
  try {
    const next = await loadStore();
    const result = await requestAiAnnotationsForStore(next, ids);
    applyAnnotationsToStore(next, result.annotations);
    await saveStore(next);
    return 'AI annotations updated for ' + result.updated + ' words.';
  } catch (error) {
    return error instanceof Error ? 'AI annotations did not finish: ' + error.message : 'AI annotations did not finish.';
  }
}

function cleanEnglishArticle(text: string) {
  return text
    .replace(/[\u4e00-\u9fff]+/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => /[A-Za-z]/.test(line))
    .join('\n\n');
}

function splitSentences(text: string) {
  return (text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [])
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function splitArticleParagraphs(text: string) {
  let sentenceIndex = 0;
  return text
    .split(/\n{2,}/)
    .map((paragraph) =>
      splitSentences(paragraph).map((sentence) => ({
        sentence,
        sentenceIndex: sentenceIndex++
      }))
    )
    .filter((paragraph) => paragraph.length > 0);
}

function sentenceForWord(articleText: string, word: string) {
  const sentences = articleText.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [articleText];
  const pattern = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i');
  return sentences.find((sentence) => pattern.test(sentence))?.trim() ?? word;
}

function normalizeImportedWord(value: string) {
  const irregular: Record<string, string> = {
    went: 'go',
    gone: 'go',
    goes: 'go',
    did: 'do',
    done: 'do',
    does: 'do',
    had: 'have',
    has: 'have',
    was: 'be',
    were: 'be',
    been: 'be',
    being: 'be',
    saw: 'see',
    seen: 'see',
    made: 'make',
    took: 'take',
    taken: 'take',
    gave: 'give',
    given: 'give',
    wrote: 'write',
    written: 'write',
    ran: 'run',
    bought: 'buy',
    brought: 'bring',
    thought: 'think',
    taught: 'teach',
    found: 'find',
    felt: 'feel',
    left: 'leave',
    kept: 'keep',
    children: 'child',
    people: 'person',
    men: 'man',
    women: 'woman'
  };
  const commonComparatives: Record<string, string> = {
    better: 'good',
    best: 'good',
    worse: 'bad',
    worst: 'bad',
    farther: 'far',
    farthest: 'far',
    further: 'far',
    furthest: 'far',
    faster: 'fast',
    fastest: 'fast',
    slower: 'slow',
    slowest: 'slow',
    older: 'old',
    oldest: 'old',
    newer: 'new',
    newest: 'new',
    higher: 'high',
    highest: 'high',
    lower: 'low',
    lowest: 'low',
    longer: 'long',
    longest: 'long',
    shorter: 'short',
    shortest: 'short',
    smaller: 'small',
    smallest: 'small',
    larger: 'large',
    largest: 'large',
    closer: 'close',
    closest: 'close',
    safer: 'safe',
    safest: 'safe',
    wider: 'wide',
    widest: 'wide'
  };
  const word = value
    .trim()
    .replace(/^[^A-Za-z'-]+|[^A-Za-z'-]+$/g, '')
    .toLowerCase();
  if (!word) return '';
  if (irregular[word]) return irregular[word];
  if (commonComparatives[word]) return commonComparatives[word];
  if (word.length > 5 && word.endsWith('iest')) return word.slice(0, -4) + 'y';
  if (word.length > 4 && word.endsWith('ier')) return word.slice(0, -3) + 'y';
  if (word.length > 6 && word.endsWith('est') && /([bcdfghjklmnpqrstvwxyz])\1est$/.test(word)) return normalizeAdjectiveStem(word.slice(0, -3));
  if (word.length > 5 && word.endsWith('er') && /([bcdfghjklmnpqrstvwxyz])\1er$/.test(word)) return normalizeAdjectiveStem(word.slice(0, -2));
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 4 && word.endsWith('ied')) return word.slice(0, -3) + 'y';
  if (word.length > 5 && word.endsWith('ing')) return normalizeVerbStem(word.slice(0, -3), 'ing');
  if (word.length > 4 && word.endsWith('ed')) return normalizeVerbStem(word.slice(0, -2), 'ed');
  if (word.length > 4 && word.endsWith('oes')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('es') && /(ches|shes|xes|zes|ses)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

async function resolveImportedWord(settings: AppSettings, value: string) {
  const local = normalizeImportedWord(value);
  if (!local) return '';
  try {
    const lemma = await requestWordLemma(settings, value);
    return normalizeImportedWord(lemma) || local;
  } catch {
    return local;
  }
}

function normalizeWordList(words: string[]) {
  return words
    .map(normalizeImportedWord)
    .filter(Boolean)
    .filter((word, index, all) => all.indexOf(word) === index);
}

function normalizeAdjectiveStem(stem: string) {
  if (/([bcdfghjklmnpqrstvwxyz])\1$/.test(stem)) return stem.slice(0, -1);
  if (/^(larg|nic|simpl|gentl|subtl|abl|wid|lat|clos|saf)$/.test(stem)) return stem + 'e';
  return stem;
}

function normalizeVerbStem(stem: string, suffix: 'ed' | 'ing') {
  if (/([bcdfghjklmnpqrstvwxyz])\1$/.test(stem)) return stem.slice(0, -1);
  if (suffix === 'ing' && stem.endsWith('y')) return stem;
  if (/^(mak|tak|giv|liv|mov|lov|lik|us|clos|shar|sav|writ|driv|creat|hop|typ)$/.test(stem)) return stem + 'e';
  if (suffix === 'ed' && /(at|it|ct|nt|rt|st|ay|ey|oy|ow|en|er|el)$/.test(stem)) return stem;
  return stem;
}

function vocabForArticle(store: AppStore, article: Article) {
  const quoteIds = new Set(
    store.quotes
      .filter((quote) => quote.source === article.title || article.text.includes(quote.text))
      .flatMap((quote) => quote.vocabIds)
  );
  return store.vocab.filter((item) => item.id && quoteIds.has(item.id));
}

function annotationsForSentence(sentence: string, annotations: ArticleAnnotation[]) {
  return annotations.filter((annotation) => {
    const target = annotation.text.trim();
    return target && new RegExp(escapeRegExp(target), 'i').test(sentence);
  });
}

function renderArticleHighlights(
  text: string,
  vocabItems: VocabItem[],
  annotations: ArticleAnnotation[],
  onSelectVocab?: (item: VocabItem) => void
) {
  const vocabWords = new Set(vocabItems.map((item) => item.word.toLowerCase()));
  const matches: Array<{ start: number; end: number; kind: 'vocab' | 'note'; text: string; item?: VocabItem }> = [];

  for (const match of text.matchAll(/[A-Za-z][A-Za-z'-]*/g)) {
    const surface = match[0];
    const normalized = normalizeImportedWord(surface);
    if (vocabWords.has(normalized)) {
      matches.push({
        start: match.index ?? 0,
        end: (match.index ?? 0) + surface.length,
        kind: 'vocab',
        text: surface,
        item: vocabItems.find((item) => item.word.toLowerCase() === normalized)
      });
    }
  }

  for (const annotation of annotations) {
    const target = annotation.text.trim();
    if (!target) continue;
    const pattern = new RegExp(escapeRegExp(target), 'gi');
    for (const match of text.matchAll(pattern)) {
      matches.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, kind: 'note', text: match[0] });
    }
  }

  const selected = matches
    .sort((a, b) => a.start - b.start || (a.kind === 'vocab' ? -1 : 1) || (b.end - b.start) - (a.end - a.start))
    .reduce<typeof matches>((acc, match) => {
      if (acc.some((item) => match.start < item.end && match.end > item.start)) return acc;
      acc.push(match);
      return acc;
    }, []);

  if (!selected.length) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  selected.forEach((match, index) => {
    if (cursor < match.start) parts.push(text.slice(cursor, match.start));
    parts.push(
      <mark
        className={match.kind === 'vocab' ? 'article-vocab-hit' : 'article-note-hit'}
        key={`${match.kind}-${match.start}-${index}`}
        onClick={match.kind === 'vocab' && match.item ? () => onSelectVocab?.(match.item!) : undefined}
        role={match.kind === 'vocab' ? 'button' : undefined}
        tabIndex={match.kind === 'vocab' ? 0 : undefined}
      >
        {text.slice(match.start, match.end)}
      </mark>
    );
    cursor = match.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeAnnotations(payload: unknown): CodexAnnotation[] {
  const value = payload as { annotations?: CodexAnnotation[] } | CodexAnnotation[];
  const annotations = Array.isArray(value) ? value : value.annotations ?? [];
  return annotations.filter((item) => item.word && item.meaningZh);
}

function applyAnnotationsToStore(store: AppStore, annotations: CodexAnnotation[]) {
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
        updatedAt: todayIso()
      }
      : item;
  });
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

function cloneStore(store: AppStore): AppStore {
  return JSON.parse(JSON.stringify(store)) as AppStore;
}

async function migrateLegacyIndexedDb(base: AppStore): Promise<AppStore> {
  try {
    const [quotes, vocab, reviews, audioCache, settings] = await Promise.all([
      legacyDb.quotes.toArray(),
      legacyDb.vocab.toArray(),
      legacyDb.reviews.toArray(),
      legacyDb.audioCache.toArray(),
      legacyDb.settings.toArray()
    ]);
    if (!quotes.length && !vocab.length) return base;
    const migrated = cloneStore(base);
    migrated.quotes = quotes;
    migrated.vocab = vocab;
    migrated.reviews = reviews;
    migrated.audioCache = audioCache;
    migrated.settings = { ...migrated.settings, ...(settings[0] ?? {}) };
    migrated.nextIds = {
      quote: Math.max(1, ...quotes.map((item) => item.id ?? 0)) + 1,
      article: base.nextIds.article,
      vocab: Math.max(1, ...vocab.map((item) => item.id ?? 0)) + 1,
      review: Math.max(1, ...reviews.map((item) => item.id ?? 0)) + 1,
      audio: Math.max(1, ...audioCache.map((item) => item.id ?? 0)) + 1
    };
    return migrated;
  } catch {
    return base;
  }
}

declare global {
  interface Window {
    __goldenLinesCodex?: {
      listVocab: () => Promise<VocabItem[]>;
      listPendingAiAnnotations: () => Promise<VocabItem[]>;
      applyAiAnnotations: (payload: CodexAnnotation[] | { annotations?: CodexAnnotation[] }) => Promise<{ updated: number }>;
      clearAiAnnotations: (ids?: number[]) => Promise<{ cleared: number }>;
    };
  }
}
