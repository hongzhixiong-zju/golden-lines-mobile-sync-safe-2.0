export function todayIso() {
  return new Date().toISOString();
}

export function formatDate(value?: string) {
  if (!value) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric'
  }).format(new Date(value));
}

export function splitWords(raw: string) {
  return raw
    .split(/[,，\n]/)
    .map((word) => word.trim())
    .filter(Boolean)
    .filter((word, index, all) => all.findIndex((candidate) => candidate.toLowerCase() === word.toLowerCase()) === index);
}

export function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export async function readJsonFile<T>(file: File): Promise<T> {
  return JSON.parse(await file.text()) as T;
}
