import { normalizeStore, type AppStore } from './localStore';

export interface SyncConfig {
  token: string;
  gistId: string;
  fileName: string;
  autoSync: boolean;
  lastSyncAt?: string;
  lastRemoteUpdatedAt?: string;
}

export interface RemoteStoreResult {
  store: AppStore;
  remoteUpdatedAt?: string;
  gistId: string;
}

const CONFIG_KEY = 'golden-lines-gist-sync-config';
const DEFAULT_FILE_NAME = 'vocab-store.json';
const GIST_API = 'https://api.github.com/gists';

export function defaultSyncConfig(): SyncConfig {
  return {
    token: '',
    gistId: '',
    fileName: DEFAULT_FILE_NAME,
    autoSync: false
  };
}

export function loadSyncConfig(): SyncConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return { ...defaultSyncConfig(), ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return defaultSyncConfig();
  }
}

export function saveSyncConfig(config: SyncConfig) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...defaultSyncConfig(), ...config }));
}

export async function testGistConnection(config: SyncConfig) {
  validateConfig(config, { allowMissingGist: true });
  if (!config.gistId.trim()) {
    return 'Token is usable. A new private Gist will be created on first push.';
  }
  const gist = await requestGist(config, 'GET');
  const fileName = resolveFileName(config);
  if (!gist.files?.[fileName]) {
    return `Connected to Gist ${gist.id}, but ${fileName} does not exist yet.`;
  }
  return `Connected to Gist ${gist.id}. Remote file ${fileName} is available.`;
}

export async function pullStoreFromGist(config: SyncConfig): Promise<RemoteStoreResult> {
  validateConfig(config);
  const gist = await requestGist(config, 'GET');
  const fileName = resolveFileName(config);
  const file = gist.files?.[fileName];
  if (!file?.content) {
    throw new Error(`Remote Gist does not contain ${fileName}. Push local data first.`);
  }
  return {
    store: normalizeStore(JSON.parse(file.content)),
    remoteUpdatedAt: gist.updated_at,
    gistId: gist.id
  };
}

export async function pushStoreToGist(config: SyncConfig, store: AppStore): Promise<RemoteStoreResult> {
  validateConfig(config, { allowMissingGist: true });
  const fileName = resolveFileName(config);
  const normalized = normalizeStore(store);

  if (!config.gistId.trim()) {
    const created = await requestGist(config, 'POST', {
      description: 'Golden Lines mobile sync store',
      public: false,
      files: {
        [fileName]: {
          content: JSON.stringify(normalized, null, 2)
        }
      }
    });
    return { store: normalized, remoteUpdatedAt: created.updated_at, gistId: created.id };
  }

  let remoteUpdatedAt: string | undefined;
  const gist = await requestGist(config, 'GET');
  remoteUpdatedAt = gist.updated_at;
  const remoteFile = gist.files?.[fileName];
  if (remoteFile?.content) {
    const remote = normalizeStore(JSON.parse(remoteFile.content));
    if (isNewer(remote.updatedAt, normalized.updatedAt) && remote.updatedAt !== config.lastRemoteUpdatedAt) {
      throw new Error('Remote data is newer than local data. Pull from cloud first or use the overwrite button.');
    }
  }

  const updated = await requestGist(config, 'PATCH', {
    files: {
      [fileName]: {
        content: JSON.stringify(normalized, null, 2)
      }
    }
  });
  return { store: normalized, remoteUpdatedAt: updated.updated_at ?? remoteUpdatedAt, gistId: updated.id };
}

export async function overwriteGist(config: SyncConfig, store: AppStore): Promise<RemoteStoreResult> {
  validateConfig(config, { allowMissingGist: true });
  const fileName = resolveFileName(config);
  const normalized = normalizeStore(store);
  if (!config.gistId.trim()) return pushStoreToGist(config, normalized);
  const updated = await requestGist(config, 'PATCH', {
    files: {
      [fileName]: {
        content: JSON.stringify(normalized, null, 2)
      }
    }
  });
  return { store: normalized, remoteUpdatedAt: updated.updated_at, gistId: updated.id };
}

export function rememberSuccessfulSync(config: SyncConfig, result: RemoteStoreResult): SyncConfig {
  const next = {
    ...config,
    gistId: result.gistId,
    lastSyncAt: new Date().toISOString(),
    lastRemoteUpdatedAt: result.store.updatedAt
  };
  saveSyncConfig(next);
  return next;
}

function resolveFileName(config: SyncConfig) {
  return config.fileName.trim() || DEFAULT_FILE_NAME;
}

function validateConfig(config: SyncConfig, options: { allowMissingGist?: boolean } = {}) {
  if (!config.token.trim()) throw new Error('Please enter a GitHub token first.');
  if (!options.allowMissingGist && !config.gistId.trim()) throw new Error('Please enter a Gist ID, or push once to create one.');
}

async function requestGist(config: SyncConfig, method: 'GET' | 'POST' | 'PATCH', body?: unknown) {
  const gistId = config.gistId.trim();
  const response = await fetch(method === 'POST' ? GIST_API : `${GIST_API}/${gistId}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${config.token.trim()}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub Gist request failed (${response.status}): ${formatGitHubError(detail)}`);
  }
  return response.json() as Promise<any>;
}

function isNewer(left?: string, right?: string) {
  if (!left || !right) return false;
  return new Date(left).getTime() > new Date(right).getTime();
}

function formatGitHubError(detail: string) {
  try {
    const parsed = JSON.parse(detail) as { message?: string };
    return parsed.message ?? detail;
  } catch {
    return detail.slice(0, 180);
  }
}
