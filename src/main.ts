import { FileSystemAdapter, MarkdownView, Notice, Plugin, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import { join } from 'node:path';
import { OllamaEmbeddingClient } from './embeddings/ollama-embedding-client';
import { IndexController } from './indexing/index-controller';
import {
  createIndexRepository,
  storageFormatLabel,
} from './indexing/index-repository-factory';
import { ensureIndexDirectory, indexDirectoryPath } from './indexing/index-paths';
import { discoverFolders, scopeSignature } from './indexing/folder-scope';
import { LocalStreamingTransport } from './infrastructure/local-streaming-transport';
import { ModelTaskQueue } from './llm/model-task-queue';
import type { ModelParameters } from './llm/model-parameters';
import { ChatController } from './ui/chat-controller';
import { ConfigurableLlmClient } from './llm/llm-client';
import { RagService } from './rag/rag-service';
import { FORMAT_SKILL_PATH, formatNote, isFormatCommand } from './rag/format-service';
import { formattedDocument } from './rag/format-edit';
import bundledFormatSkill from '../vault-skills/fmt/SKILL.md';
import { NOTE_SKILL_PATH, generateNoteDraft, isNoteCommand } from './rag/note-service';
import { definitionDocument, describedDocument, hasDescription, linkedSelectionDocument, safeNoteTitle } from './rag/note-edit';
import bundledNoteSkill from '../vault-skills/note/SKILL.md';
import { validateIndexSnapshot } from './rag/validate-index-snapshot';
import { RetrievalService } from './retrieval/retrieval-service';
import { DEFAULT_SETTINGS, sanitizeSettings } from './settings/defaults';
import { AiAdventRagSettingsTab } from './settings/settings-tab';
import { CHAT_VIEW_TYPE, ChatView } from './ui/chat-view';
import { insertAnswer } from './ui/insert-answer';
import { selectionContext } from './ui/selection-context';
import { ChatStateRepository } from './ui/chat-state-repository';
import type {
  ActiveNoteContext,
  ChunkingComparison,
  ChatTurn,
  IndexProgress,
  PluginSettings,
  RagAnswer,
  RetrievalResponse,
  SearchResult,
  StructureChunkingUnit,
  ChatProgress,
} from './types';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

export default class AiAdventRagPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  private indexController!: IndexController;
  private retrievalService!: RetrievalService;
  private ragService!: RagService;
  private llmClient!: ConfigurableLlmClient;
  private chatStateRepository!: ChatStateRepository;
  private changeRevision = 0;
  private readonly modelTransport = new LocalStreamingTransport();
  private readonly modelQueue = new ModelTaskQueue();
  private lastActiveNotePath: string | null = null;
  private rebuildQueued = false;
  private highlightedSelectionView?: MarkdownView;
  chatController!: ChatController;

  async onload(): Promise<void> {
    this.settings = sanitizeSettings(await this.loadData());
    const pluginDirectory = this.pluginDirectoryPath();
    await ensureIndexDirectory(pluginDirectory);
    this.chatStateRepository = new ChatStateRepository(pluginDirectory);
    const transport = this.modelTransport;
    const embeddings = new OllamaEmbeddingClient(transport);
    this.llmClient = new ConfigurableLlmClient(transport);
    this.retrievalService = new RetrievalService(embeddings);
    this.ragService = new RagService(embeddings, this.llmClient);
    this.indexController = new IndexController(
      this.app,
      embeddings,
      createIndexRepository(this.indexDirectoryPath(), this.settings.activeIndexStorageFormat),
    );

    try {
      await this.indexController.load();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
      this.settings.indexNeedsRebuild = true;
    }

    this.lastActiveNotePath = this.app.workspace.getActiveFile()?.path ?? null;
    this.registerEvent(this.app.workspace.on('file-open', (file) => {
      if (file?.extension === 'md') this.lastActiveNotePath = file.path;
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (this.lastActiveNotePath === oldPath) this.lastActiveNotePath = file.path;
      else if (this.lastActiveNotePath?.startsWith(`${oldPath}/`)) this.lastActiveNotePath = file.path + this.lastActiveNotePath.slice(oldPath.length);
      this.chatController.renameNote(oldPath, file.path);
    }));
    this.chatController = new ChatController(this.chatStateRepository, this.modelQueue, {
      activeNotePath: () => {
        const active = this.app.workspace.getActiveFile();
        return active?.extension === 'md' ? active.path : this.lastActiveNotePath;
      },
      readNote: (path) => this.readNoteContext(path),
      activeSelection: () => this.readActiveSelection(),
      onSelectionCaptured: (selection) => this.showSelectionHighlight(selection),
      onSelectionReleased: () => this.clearSelectionHighlight(),
      answer: (question, history, context, onProgress, signal, parameters) => this.answerQuestion(question, history, onProgress, context, signal, parameters),
      onError: (message) => { new Notice(message); },
    });
    try { await this.chatController.initialize(false); }
    catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));
    this.addRibbonIcon('sparkles', 'Открыть AskMyMind', () => {
      void this.activateChatView();
    });
    this.addCommand({
      id: 'open-question-panel',
      name: 'Открыть чат',
      callback: () => void this.activateChatView(),
    });
    this.addCommand({
      id: 'rebuild-index',
      name: 'Rebuild local semantic index',
      callback: () => void this.rebuildIndexWithNotices(),
    });
    this.addSettingTab(new AiAdventRagSettingsTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.registerVaultChangeTracking();
      void this.runScheduledRebuildIfDue(true);
    });
    this.registerInterval(
      window.setInterval(() => void this.runScheduledRebuildIfDue(), CHECK_INTERVAL_MS),
    );
  }

  async saveSettings(): Promise<void> {
    this.settings = sanitizeSettings(this.settings);
    await this.saveData(this.settings);
  }

  indexSummary(): string {
    const snapshot = this.indexController?.getSnapshot();
    if (!snapshot) return 'Индекс ещё не создан.';
    const date = new Date(snapshot.builtAt).toLocaleString();
    const stale = this.settings.indexNeedsRebuild
      ? ' Настройки или заметки изменились — требуется перестроение.'
      : '';
    const activeFormat = storageFormatLabel(this.settings.activeIndexStorageFormat);
    const pendingFormat = this.settings.indexStorageFormat !== this.settings.activeIndexStorageFormat
      ? ` Выбран формат ${storageFormatLabel(this.settings.indexStorageFormat)}; он вступит в силу после успешного перестроения.`
      : '';
    const strategy = snapshot.chunkingStrategy === 'fixed-size'
      ? `фиксированный размер ${snapshot.fixedChunkSize} символов`
      : `по структуре: ${structureChunkingUnitLabel(snapshot.structureChunkingUnit)}`;
    return `${snapshot.chunks.length} фрагментов, формат: ${activeFormat}, разбиение: ${strategy}. Индекс создан ${date}.${pendingFormat}${stale}`;
  }

  chunkingComparison(): ChunkingComparison | null {
    return this.indexController?.getSnapshot()?.chunkingComparison ?? null;
  }

  isIndexRebuilding(): boolean {
    return this.rebuildQueued || this.indexController.isRebuilding();
  }

  availableFolders(): string[] {
    return discoverFolders(this.app.vault.getMarkdownFiles().map((file) => file.path));
  }

  markIndexDirty(): void {
    this.changeRevision += 1;
    this.settings.indexNeedsRebuild = true;
  }

  onunload(): void {
    this.chatController?.dispose();
    this.modelTransport.dispose();
    this.modelQueue.dispose();
  }

  async rebuildIndexWithNotices(): Promise<void> {
    if (this.rebuildQueued) return;
    this.rebuildQueued = true;
    try { await this.modelQueue.enqueue(() => this.performRebuildIndex()); }
    finally { this.rebuildQueued = false; }
  }

  private async performRebuildIndex(): Promise<void> {
    const revisionAtStart = this.changeRevision;
    const settingsAtStart: PluginSettings = {
      ...this.settings,
      selectedFolders: [...this.settings.selectedFolders],
    };
    let lastPercent = -1;
    const progress = (value: IndexProgress): void => {
      const percent = value.total === 0 ? 100 : Math.floor((value.completed / value.total) * 100);
      if (percent >= lastPercent + 20) {
        lastPercent = percent;
        const label = value.phase === 'reading'
          ? 'Чтение заметок'
          : value.phase === 'embedding'
            ? 'Создание векторов'
            : 'Сохранение индекса';
        new Notice(`${label}: ${percent}%`);
      }
    };

    try {
      const targetRepository = createIndexRepository(
        this.indexDirectoryPath(),
        settingsAtStart.indexStorageFormat,
      );
      const snapshot = await this.indexController.rebuild(settingsAtStart, progress, targetRepository);
      this.settings.activeIndexStorageFormat = settingsAtStart.indexStorageFormat;
      this.settings.lastIndexedAt = snapshot.builtAt;
      this.settings.indexNeedsRebuild =
        revisionAtStart !== this.changeRevision ||
        snapshot.scopeSignature !== this.currentScopeSignature() ||
        snapshot.chunkingStrategy !== this.settings.chunkingStrategy ||
        snapshot.structureChunkingUnit !== this.settings.structureChunkingUnit ||
        snapshot.fixedChunkSize !== this.settings.fixedChunkSize;
      await this.saveSettings();
      this.refreshChatViews();
      new Notice(`Индекс перестроен: ${snapshot.chunks.length} фрагментов.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Не удалось перестроить индекс: ${message}`);
      throw error;
    }
  }

  async search(query: string): Promise<RetrievalResponse> {
    return this.modelQueue.enqueue(() => this.performSearch(query));
  }

  private async performSearch(query: string): Promise<RetrievalResponse> {
    const snapshot = this.validatedSnapshot();
    return this.retrievalService.search(
      query,
      snapshot,
      {
        candidateTopK: this.settings.retrievalCandidateTopK,
        finalTopK: this.settings.retrievalFinalTopK,
        minimumScore: this.settings.similarityThreshold,
        expandRelevantSources: true,
      },
      (queryVector, topK) => this.indexController.searchVector(queryVector, topK),
    );
  }

  async answerQuestion(
    question: string,
    history: readonly ChatTurn[],
    onProgress?: (progress: ChatProgress) => void,
    activeNote?: ActiveNoteContext,
    signal?: AbortSignal,
    parameters?: ModelParameters,
  ): Promise<RagAnswer> {
    const calls: import('./types').ModelMetrics[] = [];
    const started = performance.now();
    const config = { ...this.localLlmConfig(), signal, options: parameters,
      onMetrics: (metrics: import('./types').ModelMetrics) => { calls.push(metrics); } };
    const finish = (answer: RagAnswer): RagAnswer => ({ ...answer,
      analytics: { calls, elapsedMs: performance.now() - started, queueMs: 0 } });
    if (isNoteCommand(question)) {
      if (!activeNote) throw new Error('Для /note выберите диалог с закреплённой заметкой или выделите текст.');
      const hadDescription = !activeNote.isSelection && hasDescription(activeNote.content);
      const skill = await this.app.vault.adapter.exists(NOTE_SKILL_PATH)
        ? await this.app.vault.adapter.read(NOTE_SKILL_PATH)
        : bundledNoteSkill;
      const draft = await generateNoteDraft(question, activeNote, skill, this.llmClient, config, onProgress);
      if (draft.mode === 'definition') {
        const path = await this.createDefinitionNote(activeNote, draft.title!, draft.text, signal);
        return finish({ text: `Готово: создана заметка «${path}» с определением; выделение связано с ней.`,
          sources: [], citations: [], groundingStatus: 'not-applicable', usedRag: false,
          usedRetrievalEnhancements: false, modelCalled: true, fileEdited: true });
      }
      const changed = await this.applyNoteDescription(activeNote, draft.text, signal);
      return finish({ text: changed ? `Готово: описание ${hadDescription ? 'обновлено' : 'добавлено'} в заметке «${activeNote.path}».` :
        `Описание заметки «${activeNote.path}» уже совпадает с результатом. Изменения не нужны.`,
      sources: [], citations: [], groundingStatus: 'not-applicable', usedRag: false,
      usedRetrievalEnhancements: false, modelCalled: true, fileEdited: true });
    }
    if (isFormatCommand(question)) {
      const skill = await this.app.vault.adapter.exists(FORMAT_SKILL_PATH)
        ? await this.app.vault.adapter.read(FORMAT_SKILL_PATH)
        : bundledFormatSkill;
      const formatted = await formatNote(question, activeNote, skill, this.llmClient, config, onProgress);
      if (!activeNote) throw new Error('Для /fmt выберите заметку.');
      const changed = await this.applyFormattedNote(activeNote, formatted.text, signal);
      return finish({ ...formatted, text: changed
        ? `Готово: ${activeNote.isSelection ? 'выделенный фрагмент' : 'заметка'} «${activeNote.path}» ${activeNote.isSelection ? 'обновлён' : 'обновлена'}.`
        : `Заметка «${activeNote.path}» уже в нужном формате — изменений нет.`, fileEdited: true });
    }
    const snapshot = this.validatedSnapshot();
    return finish(await this.ragService.answer(
      question,
      snapshot,
      config,
      {
        candidateTopK: this.settings.retrievalCandidateTopK,
        finalTopK: this.settings.retrievalFinalTopK,
        similarityThreshold: this.settings.similarityThreshold,
      },
      history,
      snapshot
        ? (queryVector, topK) => this.indexController.searchVector(queryVector, topK)
        : undefined,
      onProgress,
      activeNote,
    ));
  }

  refreshChatViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) {
      if (leaf.view instanceof ChatView) leaf.view.refreshMode();
    }
  }

  async testLocalConnection(): Promise<void> {
    await this.modelQueue.enqueue(() => this.llmClient.testConnection(this.localLlmConfig()));
  }

  async openSource(source: SearchResult): Promise<void> {
    const file = this.app.vault.getFileByPath(source.chunk.metadata.source);
    if (!file) {
      throw new Error(`Source note no longer exists: ${source.chunk.metadata.source}`);
    }
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    if (leaf.view instanceof MarkdownView) {
      const position = { line: Math.max(0, source.chunk.metadata.line_start - 1), ch: 0 };
      leaf.view.editor.setCursor(position);
      leaf.view.editor.scrollIntoView({ from: position, to: position }, true);
    }
  }

  insertAnswer(text: string): void {
    const active = this.app.workspace.activeEditor;
    if (active?.file?.extension === 'md' && active.editor) {
      insertAnswer(active.editor, text);
      return;
    }
    const view = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit)?.view;
    insertAnswer(view instanceof MarkdownView && view.getMode() === 'source' ? view.editor : undefined, text);
  }

  private readActiveSelection(): ActiveNoteContext | undefined {
    const active = this.app.workspace.activeEditor;
    if (active?.file?.extension === 'md' && active.editor) {
      return selectionContext(active.editor, { path: active.file.path, title: active.file.basename, mtime: active.file.stat.mtime });
    }
    const view = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit)?.view;
    if (!(view instanceof MarkdownView) || view.getMode() !== 'source' || !view.file) return undefined;
    return selectionContext(view.editor, { path: view.file.path, title: view.file.basename, mtime: view.file.stat.mtime });
  }

  private showSelectionHighlight(selection: ActiveNoteContext): void {
    this.clearSelectionHighlight();
    const view = this.app.workspace.getLeavesOfType('markdown')
      .map((leaf) => leaf.view).find((item) => item instanceof MarkdownView && item.file?.path === selection.path);
    if (!(view instanceof MarkdownView)) return;
    view.containerEl.addClass('ai-advent-rag-selection-pending');
    this.highlightedSelectionView = view;
  }

  private clearSelectionHighlight(): void {
    this.highlightedSelectionView?.containerEl.removeClass('ai-advent-rag-selection-pending');
    this.highlightedSelectionView = undefined;
  }

  private async readNoteContext(path: string): Promise<ActiveNoteContext> {
    const file = this.app.vault.getFileByPath(path);
    if (!file || file.extension !== 'md') throw new Error('Закреплённая заметка не найдена. Уберите её из контекста через крестик.');
    const openView = this.app.workspace.getLeavesOfType('markdown')
      .map((leaf) => leaf.view).find((view) => view instanceof MarkdownView && view.file?.path === path);
    const content = openView instanceof MarkdownView ? openView.editor.getValue() : await this.app.vault.read(file);
    return { path: file.path, title: file.basename, content, mtime: file.stat.mtime };
  }

  private async applyFormattedNote(context: ActiveNoteContext, formatted: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const file = this.app.vault.getFileByPath(context.path);
    if (!file || file.extension !== 'md') throw new Error('Исходная заметка больше не существует. Изменения не сохранены.');
    const openView = this.app.workspace.getLeavesOfType('markdown')
      .map((leaf) => leaf.view).find((view) => view instanceof MarkdownView && view.file?.path === context.path);
    if (openView instanceof MarkdownView) {
      const editor = openView.editor;
      const current = editor.getValue();
      const replacement = formattedDocument(context, current, formatted);
      if (replacement === current) return false;
      signal?.throwIfAborted();
      if (context.isSelection) {
        editor.replaceRange(formatted, editor.offsetToPos(context.selectionStart!), editor.offsetToPos(context.selectionEnd!));
      } else {
        editor.replaceRange(formatted, { line: 0, ch: 0 }, editor.offsetToPos(current.length));
      }
      return true;
    }
    let changed = false;
    await this.app.vault.process(file, (current) => {
      signal?.throwIfAborted();
      const replacement = formattedDocument(context, current, formatted);
      changed = replacement !== current;
      return replacement;
    });
    return changed;
  }

  private async applyNoteDescription(context: ActiveNoteContext, description: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const file = this.app.vault.getFileByPath(context.path);
    if (!file || file.extension !== 'md') throw new Error('Исходная заметка больше не существует. Описание не сохранено.');
    const openView = this.app.workspace.getLeavesOfType('markdown')
      .map((leaf) => leaf.view).find((view) => view instanceof MarkdownView && view.file?.path === context.path);
    if (openView instanceof MarkdownView) {
      const editor = openView.editor;
      const current = editor.getValue();
      const replacement = describedDocument(context, current, description);
      if (replacement === current) return false;
      signal?.throwIfAborted();
      editor.replaceRange(replacement, { line: 0, ch: 0 }, editor.offsetToPos(current.length));
      return true;
    }
    let changed = false;
    await this.app.vault.process(file, (current) => {
      signal?.throwIfAborted();
      const replacement = describedDocument(context, current, description);
      changed = replacement !== current;
      return replacement;
    });
    return changed;
  }

  private async createDefinitionNote(context: ActiveNoteContext, rawTitle: string, definition: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const source = this.app.vault.getFileByPath(context.path);
    if (!source || source.extension !== 'md') throw new Error('Исходная заметка больше не существует. Новая заметка не создана.');
    const title = safeNoteTitle(rawTitle);
    // A wikilink without a folder must stay unambiguous even if a nested note has the same title.
    const usedTitles = new Set(this.app.vault.getMarkdownFiles().map((file) => file.basename));
    let fileTitle = title;
    let path = `${fileTitle}.md`;
    for (let suffix = 2; usedTitles.has(fileTitle) || this.app.vault.getAbstractFileByPath(path); suffix++) {
      fileTitle = `${title} (${suffix})`;
      path = `${fileTitle}.md`;
    }
    const body = definitionDocument(fileTitle, definition);
    const openView = this.app.workspace.getLeavesOfType('markdown')
      .map((leaf) => leaf.view).find((view) => view instanceof MarkdownView && view.file?.path === context.path);
    const current = openView instanceof MarkdownView ? openView.editor.getValue() : await this.app.vault.read(source);
    const linked = linkedSelectionDocument(context, current, path);
    signal?.throwIfAborted();
    const created = await this.app.vault.create(path, body);
    try {
      signal?.throwIfAborted();
      if (openView instanceof MarkdownView) {
        const editor = openView.editor;
        if (editor.getValue() !== current) throw new Error('Исходная заметка изменилась. Повторите /note, чтобы не потерять правки.');
        const start = context.selectionStart!;
        const end = context.selectionEnd!;
        const replacement = linked.slice(start, linked.length - (current.length - end));
        editor.replaceRange(replacement, editor.offsetToPos(start), editor.offsetToPos(end));
      } else {
        await this.app.vault.process(source, (latest) => {
          signal?.throwIfAborted();
          linkedSelectionDocument(context, latest, path);
          return linked;
        });
      }
      return path;
    } catch (error) {
      // Roll back only the file this command just created; never delete an earlier note.
      if (await this.app.vault.read(created) === body) await this.app.fileManager.trashFile(created);
      throw error;
    }
  }

  private async activateChatView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) throw new Error('Could not open the AskMyMind panel.');
    if (!existing) await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private indexDirectoryPath(): string {
    return indexDirectoryPath(this.pluginDirectoryPath());
  }

  private pluginDirectoryPath(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error('AskMyMind requires the Obsidian desktop file-system adapter.');
    }
    return join(adapter.getBasePath(), this.app.vault.configDir, 'plugins', this.manifest.id);
  }

  private currentScopeSignature(): string {
    return scopeSignature({
      mode: this.settings.folderMode,
      folders: this.settings.selectedFolders,
    });
  }

  private localLlmConfig() {
    return {
      provider: 'ollama' as const,
      baseUrl: this.settings.llmBaseUrl,
      model: this.settings.llmModel,
    };
  }

  private validatedSnapshot() {
    const snapshot = this.indexController.getSnapshot();
    return validateIndexSnapshot(snapshot, this.settings, this.currentScopeSignature());
  }

  private registerVaultChangeTracking(): void {
    const markDirty = (file: unknown): void => {
      if (!(file instanceof TFolder) && (!(file instanceof TFile) || file.extension !== 'md')) return;
      this.markIndexDirty();
      void this.saveSettings();
    };
    this.registerEvent(this.app.vault.on('create', markDirty));
    this.registerEvent(this.app.vault.on('modify', markDirty));
    this.registerEvent(this.app.vault.on('delete', markDirty));
    this.registerEvent(this.app.vault.on('rename', markDirty));
  }

  private async runScheduledRebuildIfDue(catchUp = false): Promise<void> {
    if (this.rebuildQueued) return;
    this.rebuildQueued = true;
    try { await this.modelQueue.enqueue(() => this.performScheduledRebuild(catchUp)); }
    finally { this.rebuildQueued = false; }
  }

  private async performScheduledRebuild(catchUp = false): Promise<void> {
    if (this.indexController.isRebuilding()) return;
    if (this.settings.lastIndexedAt === null) return;
    const lastIndexedAt = this.settings.lastIndexedAt;
    if (Date.now() - lastIndexedAt < WEEK_MS) return;
    const hour = new Date().getHours();
    if (!catchUp && (hour < 2 || hour >= 5)) return;
    const revisionAtStart = this.changeRevision;
    const settingsAtStart: PluginSettings = {
      ...this.settings,
      selectedFolders: [...this.settings.selectedFolders],
    };
    try {
      new Notice('AskMyMind обновляет еженедельный локальный индекс.');
      const targetRepository = createIndexRepository(
        this.indexDirectoryPath(),
        settingsAtStart.indexStorageFormat,
      );
      const snapshot = await this.indexController.update(settingsAtStart, undefined, targetRepository);
      this.settings.activeIndexStorageFormat = settingsAtStart.indexStorageFormat;
      this.settings.lastIndexedAt = snapshot.builtAt;
      this.settings.indexNeedsRebuild =
        revisionAtStart !== this.changeRevision ||
        snapshot.scopeSignature !== this.currentScopeSignature() ||
        snapshot.chunkingStrategy !== this.settings.chunkingStrategy ||
        snapshot.structureChunkingUnit !== this.settings.structureChunkingUnit ||
        snapshot.fixedChunkSize !== this.settings.fixedChunkSize;
      await this.saveSettings();
      this.refreshChatViews();
      new Notice(`Еженедельное обновление индекса завершено: ${snapshot.chunks.length} фрагментов.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Не удалось обновить еженедельный индекс: ${message}`);
    }
  }
}

function structureChunkingUnitLabel(unit: StructureChunkingUnit): string {
  switch (unit) {
    case 'paragraph':
      return 'абзацы';
    case 'section':
      return 'разделы Markdown';
    case 'file':
      return 'файлы';
  }
}

declare module 'obsidian' {
  interface Workspace {
    getRightLeaf(split: boolean): WorkspaceLeaf | null;
  }
}
