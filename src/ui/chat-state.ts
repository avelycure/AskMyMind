import { randomUUID } from 'node:crypto';
import { sanitizeModelParameters, type ModelParameters } from '../llm/model-parameters';
import type {
  ChatTurn,
  DialogAnalytics,
  GroundedCitation,
  GroundingStatus,
  RetrievalDiagnostics,
  SearchResult,
} from '../types';

export const CHAT_STATE_VERSION = 2;
export const MAX_PERSISTED_CHAT_ENTRIES = 80;
export const MAX_DIALOGS = 10;

export type ChatMode = 'direct' | 'rag-basic' | 'rag-enhanced';

export interface ChatEntry extends ChatTurn {
  fileEdited?: boolean;
  analytics?: DialogAnalytics;
  sources?: SearchResult[];
  citations?: GroundedCitation[];
  groundingStatus?: GroundingStatus;
  usedRag?: boolean;
  usedRetrievalEnhancements?: boolean;
  modelCalled?: boolean;
  retrieval?: RetrievalDiagnostics;
}

export interface ChatDialog {
  modelParameters?: ModelParameters;
  id: string;
  title: string;
  contextPath: string | null;
  entries: ChatEntry[];
  createdAt: number;
}

export interface ChatState {
  version: number;
  dialogs: ChatDialog[];
  activeDialogId: string | null;
  updatedAt: number;
}

export function newChatDialog(contextPath: string | null, title = 'Новый диалог'): ChatDialog {
  return { id: randomUUID(), title, contextPath, entries: [], createdAt: Date.now(), modelParameters: sanitizeModelParameters(undefined) };
}

export function emptyChatState(): ChatState {
  return { version: CHAT_STATE_VERSION, dialogs: [], activeDialogId: null, updatedAt: Date.now() };
}

export function chatMode(useRag: boolean, useRetrievalEnhancements: boolean): ChatMode {
  if (!useRag) return 'direct';
  return useRetrievalEnhancements ? 'rag-enhanced' : 'rag-basic';
}

export function sanitizeChatState(value: unknown): ChatState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyChatState();
  const record = value as Record<string, unknown>;
  const dialogs: ChatDialog[] = [];
  if (Array.isArray(record.dialogs)) {
    const ids = new Set<string>();
    for (const item of record.dialogs) {
      if (dialogs.length >= MAX_DIALOGS) break;
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const dialog = item as Record<string, unknown>;
      const id = boundedString(dialog.id, 100);
      if (!id || ids.has(id)) continue;
      ids.add(id);
      dialogs.push({
        id, title: boundedString(dialog.title, 100) ?? 'Диалог',
        modelParameters: sanitizeModelParameters(dialog.modelParameters),
        contextPath: validContextPath(dialog.contextPath),
        entries: sanitizeEntries(dialog.entries), createdAt: finiteNumber(dialog.createdAt) ?? Date.now(),
      });
    }
  } else if (Array.isArray(record.entries) && record.entries.length > 0) {
    dialogs.push({ ...newChatDialog(null, 'Предыдущий диалог'), entries: sanitizeEntries(record.entries) });
  }
  return {
    version: CHAT_STATE_VERSION, dialogs,
    activeDialogId: dialogs.some((dialog) => dialog.id === record.activeDialogId)
      ? record.activeDialogId as string : dialogs[0]?.id ?? null,
    updatedAt: finiteNumber(record.updatedAt) ?? Date.now(),
  };
}

export function compactChatState(state: ChatState): ChatState {
  return sanitizeChatState({
    ...state, updatedAt: Date.now(),
    dialogs: state.dialogs.slice(0, MAX_DIALOGS).map((dialog) => ({
      ...dialog, entries: dialog.entries.slice(-MAX_PERSISTED_CHAT_ENTRIES).map(compactEntry),
    })),
  });
}

function validContextPath(value: unknown): string | null {
  const path = boundedString(value, 2_000);
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => part === '..' || part === '.')) return null;
  return path.endsWith('.md') ? path : null;
}

function compactEntry(entry: ChatEntry): ChatEntry {
  return {
    fileEdited: entry.fileEdited,
    analytics: entry.analytics,
    role: entry.role,
    content: entry.content,
    usedRag: entry.usedRag,
    usedRetrievalEnhancements: entry.usedRetrievalEnhancements,
    modelCalled: entry.modelCalled,
    groundingStatus: entry.groundingStatus,
    sources: entry.sources?.map(compactSource),
    citations: entry.citations?.map((citation) => ({ ...citation })),
    retrieval: entry.retrieval ? { ...entry.retrieval } : undefined,
  };
}

function compactSource(source: SearchResult): SearchResult {
  return {
    sourceId: source.sourceId,
    score: source.score,
    contextTruncated: source.contextTruncated,
    isActiveNote: source.isActiveNote,
    isSelection: source.isSelection,
    chunk: {
      ordinal: source.chunk.ordinal,
      text: '',
      contentHash: source.chunk.contentHash,
      metadata: { ...source.chunk.metadata },
      vector: [],
    },
  };
}

function sanitizeEntries(value: unknown): ChatEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: ChatEntry[] = [];
  for (const item of value.slice(-MAX_PERSISTED_CHAT_ENTRIES)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const role = record.role === 'user' || record.role === 'assistant' ? record.role : null;
    const content = boundedString(record.content, 50_000);
    if (!role || !content) continue;
    entries.push({
      role,
      fileEdited: booleanOrUndefined(record.fileEdited),
      analytics: sanitizeAnalytics(record.analytics),
      content,
      usedRag: booleanOrUndefined(record.usedRag),
      usedRetrievalEnhancements: booleanOrUndefined(record.usedRetrievalEnhancements),
      modelCalled: booleanOrUndefined(record.modelCalled),
      groundingStatus: groundingStatus(record.groundingStatus),
      sources: sanitizeSources(record.sources),
      citations: sanitizeCitations(record.citations),
      retrieval: sanitizeDiagnostics(record.retrieval),
    });
  }
  return entries;
}

function sanitizeSources(value: unknown): SearchResult[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sources: SearchResult[] = [];
  for (const item of value.slice(0, 20)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const chunk = record.chunk;
    if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) continue;
    const chunkRecord = chunk as Record<string, unknown>;
    const metadata = chunkRecord.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue;
    const metadataRecord = metadata as Record<string, unknown>;
    const sourceId = boundedString(record.sourceId, 50);
    const source = boundedString(metadataRecord.source, 2_000);
    const title = boundedString(metadataRecord.title, 1_000);
    const chunkId = boundedString(metadataRecord.chunk_id, 500);
    const score = finiteNumber(record.score);
    if (!sourceId || !source || !title || !chunkId || score === null) continue;
    sources.push({
      sourceId,
      score,
      contextTruncated: booleanOrUndefined(record.contextTruncated),
      isActiveNote: booleanOrUndefined(record.isActiveNote),
      isSelection: booleanOrUndefined(record.isSelection),
      chunk: {
        ordinal: finiteNumber(chunkRecord.ordinal) ?? 0,
        text: '',
        contentHash: boundedString(chunkRecord.contentHash, 500) ?? '',
        metadata: {
          source,
          title,
          section: metadataRecord.section === null
            ? null
            : boundedString(metadataRecord.section, 2_000),
          chunk_id: chunkId,
          line_start: finiteNumber(metadataRecord.line_start) ?? 1,
          line_end: finiteNumber(metadataRecord.line_end) ?? 1,
          file_mtime: finiteNumber(metadataRecord.file_mtime) ?? 0,
        },
        vector: [],
      },
    });
  }
  return sources;
}

function sanitizeCitations(value: unknown): GroundedCitation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const citations: GroundedCitation[] = [];
  for (const item of value.slice(0, 20)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const sourceId = boundedString(record.sourceId, 50);
    const source = boundedString(record.source, 2_000);
    const chunkId = boundedString(record.chunkId, 500);
    const quote = boundedString(record.quote, 2_000);
    if (!sourceId || !source || !chunkId || !quote) continue;
    citations.push({
      sourceId,
      source,
      section: record.section === null ? null : boundedString(record.section, 2_000),
      chunkId,
      quote,
    });
  }
  return citations;
}

function sanitizeDiagnostics(value: unknown): RetrievalDiagnostics | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const originalQuery = boundedString(record.originalQuery, 4_000);
  const searchQuery = boundedString(record.searchQuery, 4_000);
  if (!originalQuery || !searchQuery) return undefined;
  return {
    originalQuery,
    searchQuery,
    queryRewritten: record.queryRewritten === true,
    rewriteFailed: record.rewriteFailed === true,
    candidateCount: finiteNumber(record.candidateCount) ?? 0,
    resultCount: finiteNumber(record.resultCount) ?? 0,
    candidateTopK: finiteNumber(record.candidateTopK) ?? 0,
    finalTopK: finiteNumber(record.finalTopK) ?? 0,
    similarityThreshold: record.similarityThreshold === null
      ? null
      : finiteNumber(record.similarityThreshold),
    groundingRepairAttempted: booleanOrUndefined(record.groundingRepairAttempted),
    groundingValidationFailed: booleanOrUndefined(record.groundingValidationFailed),
  };
}

function groundingStatus(value: unknown): GroundingStatus | undefined {
  return value === 'not-applicable' || value === 'grounded' || value === 'not-enough-context'
    ? value
    : undefined;
}

function boundedString(value: unknown, maxCharacters: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.slice(0, maxCharacters);
  return text || null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function sanitizeAnalytics(value: unknown): DialogAnalytics | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.calls)) return undefined;
  const positive = (n: unknown): number | undefined => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
  const elapsedMs = positive(record.elapsedMs), queueMs = positive(record.queueMs);
  if (elapsedMs === undefined || queueMs === undefined) return undefined;
  const calls: DialogAnalytics['calls'] = [];
  for (const raw of record.calls.slice(0, 20) as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (!item || typeof item !== 'object' || typeof item.model !== 'string') continue;
    const call: DialogAnalytics['calls'][number] = { model: item.model.slice(0, 200) };
    for (const key of ['inputTokens', 'outputTokens', 'totalMs', 'loadMs', 'promptMs', 'generationMs', 'firstTokenMs', 'memoryBytes', 'vramBytes'] as const) call[key] = positive(item[key]);
    calls.push(call);
  }
  return { calls, elapsedMs, queueMs };
}
