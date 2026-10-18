import { MAX_ACTIVE_NOTE_CHARACTERS, type ActiveNoteContext, type ChatProgress, type ChatTurn, type RagAnswer } from '../types';
import { ModelTaskQueue } from '../llm/model-task-queue';
import { sanitizeModelParameters, type ModelParameters } from '../llm/model-parameters';
import { emptyChatState, MAX_PERSISTED_CHAT_ENTRIES, MAX_DIALOGS, newChatDialog, type ChatDialog, type ChatState } from './chat-state';

export interface ChatStore {
  load(): Promise<ChatState>;
  save(state: ChatState): Promise<void>;
}
export interface ChatControllerApi {
  activeSelection?(): ActiveNoteContext | undefined;
  onSelectionCaptured?(selection: ActiveNoteContext): void;
  onSelectionReleased?(): void;
  activeNotePath(): string | null;
  readNote(path: string): Promise<ActiveNoteContext>;
  answer(question: string, history: readonly ChatTurn[], context: ActiveNoteContext | undefined,
    onProgress: (progress: ChatProgress) => void, signal?: AbortSignal, parameters?: ModelParameters): Promise<RagAnswer>;
  onError(message: string): void;
}
export interface DialogRuntime {
  phase: 'idle' | 'queued' | 'running';
  position: number;
  text: string;
  status: string;
  error?: string;
}
const idle = (): DialogRuntime => ({ phase: 'idle', position: 0, text: '', status: '' });

/** Shared by every panel; asynchronous completions always update their original dialog. */
export class ChatController {
  state = emptyChatState();
  readonly drafts = new Map<string, string>();
  private runtimes = new Map<string, DialogRuntime>();
  private listeners = new Set<(kind: 'change' | 'progress') => void>();
  private initialization?: Promise<void>;
  private disposed = false;
  private cancellations = new Map<string, AbortController>();
  private pendingSelection?: ActiveNoteContext;

  dispose(): void {
    this.disposed = true;
    this.pendingSelection = undefined;
    this.api.onSelectionReleased?.();
    for (const cancellation of this.cancellations.values()) cancellation.abort();
    this.listeners.clear();
  }

  constructor(private readonly store: ChatStore, private readonly queue: ModelTaskQueue,
    private readonly api: ChatControllerApi) {
    queue.subscribe(() => this.emit('progress'));
  }

  initialize(createIfEmpty = true): Promise<void> {
    this.initialization ??= (async () => {
      this.state = await this.store.load();
      for (const dialog of this.state.dialogs) {
        if (dialog.entries.at(-1)?.role === 'user') {
          this.runtimes.set(dialog.id, { ...idle(), status: 'Предыдущий запрос прерван. Отправьте сообщение снова.' });
        }
      }
    })();
    return this.initialization.then(() => {
      if (createIfEmpty && this.state.dialogs.length === 0 && !this.disposed) this.createDialog();
    });
  }

  subscribe(listener: (kind: 'change' | 'progress') => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  runtime(id: string): DialogRuntime { return this.runtimes.get(id) ?? idle(); }
  get activeDialog(): ChatDialog | undefined { return this.state.dialogs.find((d) => d.id === this.state.activeDialogId); }
  get queueSummary(): string {
    return `Модель: ${this.queue.isRunning ? 'занята' : 'свободна'} · в очереди: ${this.queue.pendingCount}`;
  }
  get selectionPreview(): ActiveNoteContext | undefined { return this.pendingSelection; }

  /** Save the editor selection before focusing the chat clears it. */
  captureSelection(): void {
    const selected = this.api.activeSelection?.();
    if (!selected) return;
    this.pendingSelection = { ...selected };
    this.api.onSelectionCaptured?.(this.pendingSelection);
    this.emit('progress');
  }

  createDialog(): ChatDialog {
    if (this.state.dialogs.length >= MAX_DIALOGS) throw new Error('Можно открыть не более 10 диалогов. Удалите один из существующих.');
    const path = this.api.activeNotePath();
    const title = path ? path.split('/').at(-1)!.replace(/\.md$/u, '') : `Диалог ${this.state.dialogs.length + 1}`;
    const dialog = newChatDialog(path, title);
    this.state.dialogs.push(dialog);
    this.state.activeDialogId = dialog.id;
    this.changed();
    return dialog;
  }
  selectDialog(id: string): void {
    this.requireDialog(id);
    this.state.activeDialogId = id;
    this.changed();
  }
  setModelParameters(id: string, parameters: ModelParameters): void {
    this.requireDialog(id).modelParameters = sanitizeModelParameters(parameters);
    this.changed('progress');
  }
  moveDialog(id: string, targetId: string, after = false): void {
    const dialog = this.requireDialog(id);
    this.requireDialog(targetId);
    if (id === targetId) return;
    const reordered = this.state.dialogs.filter((item) => item.id !== id);
    const targetIndex = reordered.findIndex((item) => item.id === targetId);
    reordered.splice(targetIndex + (after ? 1 : 0), 0, dialog);
    if (reordered.every((item, index) => item === this.state.dialogs[index])) return;
    this.state.dialogs = reordered;
    this.changed();
  }
  removeContext(id: string): void {
    if (this.runtime(id).phase === 'running') throw new Error('Дождитесь ответа, чтобы убрать заметку из контекста.');
    this.requireDialog(id).contextPath = null;
    this.changed();
  }
  clearDialog(id: string): void {
    this.requireIdle(id);
    this.requireDialog(id).entries = [];
    this.runtimes.delete(id);
    this.changed();
  }
  deleteDialog(id: string): void {
    this.requireDialog(id);
    this.cancellations.get(id)?.abort();
    this.cancellations.delete(id);
    this.state.dialogs = this.state.dialogs.filter((dialog) => dialog.id !== id);
    this.runtimes.delete(id);
    this.drafts.delete(id);
    if (this.state.activeDialogId === id) this.state.activeDialogId = this.state.dialogs[0]?.id ?? null;
    if (this.state.dialogs.length === 0) this.createDialog();
    else this.changed();
  }
  renameNote(oldPath: string, newPath: string): void {
    let changed = false;
    for (const dialog of this.state.dialogs) {
      if (dialog.contextPath === oldPath) { dialog.contextPath = newPath; changed = true; }
      else if (dialog.contextPath?.startsWith(`${oldPath}/`)) {
        dialog.contextPath = newPath + dialog.contextPath.slice(oldPath.length); changed = true;
      }
    }
    if (changed) this.changed();
  }

  async send(id: string, question: string): Promise<void> {
    if (this.disposed) throw new Error('Плагин закрыт.');
    const value = question.trim();
    if (!value || value.length > 4000) throw new Error('Введите сообщение длиной от 1 до 4 000 символов.');
    this.requireIdle(id);
    const dialog = this.requireDialog(id);
    const cancellation = new AbortController();
    const selected = this.api.activeSelection?.() ?? this.pendingSelection;
    const selection = selected ? { ...selected } : undefined;
    if (selection && selection.content.length > MAX_ACTIVE_NOTE_CHARACTERS) {
      throw new Error('Выделенный текст длиннее 12 000 символов. Выделите меньший фрагмент, чтобы не обрезать его.');
    }
    this.pendingSelection = undefined;
    this.emit('progress');
    const parameters = sanitizeModelParameters(dialog.modelParameters);
    this.cancellations.set(id, cancellation);
    const history = dialog.entries.map(({ role, content }) => ({ role, content }));
    const userEntry = { role: 'user' as const, content: value, usedRag: true, usedRetrievalEnhancements: true };
    dialog.entries.push(userEntry);
    this.drafts.set(id, '');
    const queuedAt = performance.now();
    let queueMs = 0;
    const runtime: DialogRuntime = { phase: 'queued', position: 0, text: '', status: 'В очереди…' };
    this.runtimes.set(id, runtime);
    this.changed();
    try {
      const answer = await this.queue.enqueue(async () => {
        queueMs = performance.now() - queuedAt;
        // Read the originally attached note at task start, including changes made while waiting.
        const context = selection ?? (dialog.contextPath ? await this.api.readNote(dialog.contextPath) : undefined);
        cancellation.signal.throwIfAborted();
        return this.api.answer(value, history, context, (progress) => {
          if (cancellation.signal.aborted) return;
          if (progress.kind === 'stage') runtime.status = progress.text;
          else { runtime.text += progress.text; runtime.status = 'Qwen отвечает…'; }
          this.emit('progress');
        }, cancellation.signal, parameters);
      }, (position) => {
        runtime.position = position;
        runtime.phase = position === 0 ? 'running' : 'queued';
        runtime.status = position === 0 ? 'Подключаюсь к локальной Qwen…' : `В очереди: ${position}`;
        this.emit('progress');
      }, cancellation.signal);
      if (this.disposed || cancellation.signal.aborted) return;
      dialog.entries.push({ role: 'assistant', content: answer.text,
        fileEdited: answer.fileEdited,
        analytics: answer.analytics ? { ...answer.analytics, queueMs } : undefined, sources: answer.sources,
        citations: answer.citations, groundingStatus: answer.groundingStatus, usedRag: answer.usedRag,
        usedRetrievalEnhancements: answer.usedRetrievalEnhancements, modelCalled: answer.modelCalled, retrieval: answer.retrieval });
      runtime.status = 'Ответ получен.';
    } catch (error) {
      if (this.disposed || cancellation.signal.aborted) return;
      runtime.error = error instanceof Error ? error.message : String(error);
      runtime.status = 'Не удалось получить ответ.';
      const index = dialog.entries.indexOf(userEntry);
      if (index >= 0) dialog.entries.splice(index, 1);
      this.drafts.set(id, value);
    } finally {
      this.api.onSelectionReleased?.();
      runtime.phase = 'idle';
      runtime.text = '';
      this.cancellations.delete(id);
      if (!this.disposed && !cancellation.signal.aborted) {
        dialog.entries = dialog.entries.slice(-MAX_PERSISTED_CHAT_ENTRIES);
        this.changed();
      }
    }
  }

  private requireDialog(id: string): ChatDialog {
    const dialog = this.state.dialogs.find((d) => d.id === id);
    if (!dialog) throw new Error('Диалог не найден.');
    return dialog;
  }
  private requireIdle(id: string): void {
    if (this.runtime(id).phase !== 'idle') throw new Error('В этом диалоге уже есть запрос. Дождитесь ответа.');
  }
  private changed(kind: 'change' | 'progress' = 'change'): void {
    if (this.disposed) return;
    void this.store.save(this.state).catch((error: unknown) => this.api.onError(
      `Не удалось сохранить диалоги: ${error instanceof Error ? error.message : String(error)}`));
    this.emit(kind);
  }
  private emit(kind: 'change' | 'progress'): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener(kind);
  }
}
