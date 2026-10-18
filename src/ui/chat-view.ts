import { ItemView, Notice, setIcon, WorkspaceLeaf } from 'obsidian';
import { citationParts, sourceLinkText } from '../retrieval/citations';
import type { GroundedCitation, RetrievalDiagnostics, SearchResult } from '../types';
import { MAX_DIALOGS } from './chat-state';
import type { ChatController } from './chat-controller';
import { MODEL_PARAMETER_SLIDERS, sanitizeModelParameters } from '../llm/model-parameters';
import { analyticsRows } from './dialog-analytics';
import { lastAssistantAnswer } from './insert-answer';

export const CHAT_VIEW_TYPE = 'ai-advent-rag-chat';
export interface ChatPluginApi {
  chatController: ChatController;
  openSource(source: SearchResult): Promise<void>;
  insertAnswer(text: string): void;
}

export class ChatView extends ItemView {
  private unsubscribe?: () => void;
  private queryEl?: HTMLTextAreaElement;
  private activityEl?: HTMLElement;
  private liveBody?: HTMLElement;
  private messagesEl?: HTMLElement;
  private contextRemoveButton?: HTMLButtonElement;
  private tabs = new Map<string, HTMLButtonElement>();
  private draggedDialogId?: string;
  private closeModelMenu?: () => void;
  private analyticsOpen = new Set<string>();
  private holdTimers = new Set<number>();

  constructor(leaf: WorkspaceLeaf, private readonly pluginApi: ChatPluginApi) { super(leaf); }
  getViewType(): string { return CHAT_VIEW_TYPE; }
  getDisplayText(): string { return 'AskMyMind'; }
  getIcon(): string { return 'sparkles'; }

  async onOpen(): Promise<void> {
    try {
      await this.pluginApi.chatController.initialize();
      this.unsubscribe = this.pluginApi.chatController.subscribe((kind) => {
        if (kind === 'change') this.render();
        else this.refreshProgress();
      });
      this.render();
    } catch (error) {
      this.contentEl.empty();
      this.contentEl.createDiv({ cls: 'ai-advent-rag-error', text: error instanceof Error ? error.message : String(error) });
    }
  }
  async onClose(): Promise<void> { this.unsubscribe?.(); this.clearModelMenu(); }
  refreshMode(): void { if (this.unsubscribe) this.render(); }

  private action(run: () => void): void {
    try { run(); } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
  }
  private iconButton(container: HTMLElement, icon: string, label: string): HTMLButtonElement {
    const button = container.createEl('button', {
      cls: 'ai-advent-rag-icon-button', attr: { 'aria-label': label, title: label },
    });
    setIcon(button, icon);
    return button;
  }

  private clearModelMenu(): void {
    this.closeModelMenu?.();
    for (const timer of this.holdTimers) this.contentEl.ownerDocument.defaultView?.clearTimeout(timer);
    this.holdTimers.clear();
  }

  private openModelMenu(anchor: HTMLButtonElement, id: string): void {
    this.closeModelMenu?.();
    const controller = this.pluginApi.chatController;
    const dialog = controller.state.dialogs.find((item) => item.id === id);
    if (!dialog) return;
    const doc = anchor.ownerDocument;
    const win = doc.defaultView;
    if (!win) return;
    const panel = doc.body.createDiv({ cls: 'ai-advent-rag-model-menu', attr: { role: 'dialog', 'aria-label': `Параметры модели: ${dialog.title}` } });
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(280, win.innerWidth - 16);
    panel.setCssProps({
      '--model-menu-width': `${width}px`,
      '--model-menu-left': `${Math.max(8, Math.min(rect.left, win.innerWidth - width - 8))}px`,
      '--model-menu-bottom': `${Math.max(8, win.innerHeight - rect.top + 8)}px`,
      '--model-menu-height': `${Math.max(80, rect.top - 16)}px`,
    });
    panel.createDiv({ cls: 'ai-advent-rag-model-menu-title', text: dialog.title });
    panel.createDiv({ cls: 'ai-advent-rag-model-menu-hint', text: 'Параметры следующих запросов' });
    const controls = new Map<string, { input: HTMLInputElement; output: HTMLElement }>();
    let parameters = sanitizeModelParameters(dialog.modelParameters);
    const refresh = (): void => {
      for (const slider of MODEL_PARAMETER_SLIDERS) {
        const control = controls.get(slider.key)!;
        control.input.value = String(parameters[slider.key]);
        control.output.setText(slider.step < 1 ? parameters[slider.key].toFixed(2) : parameters[slider.key].toLocaleString('ru-RU'));
      }
    };
    for (const slider of MODEL_PARAMETER_SLIDERS) {
      const row = panel.createDiv({ cls: 'ai-advent-rag-model-parameter' });
      const label = row.createEl('label');
      label.createSpan({ text: slider.label });
      const output = label.createEl('output');
      const input = label.createEl('input', { attr: { type: 'range', min: String(slider.min), max: String(slider.max), step: String(slider.step), 'aria-label': slider.label } });
      row.createDiv({ cls: 'ai-advent-rag-model-menu-hint', text: slider.hint });
      controls.set(slider.key, { input, output });
      input.addEventListener('input', () => {
        parameters = sanitizeModelParameters({ ...parameters, [slider.key]: Number(input.value) });
        refresh();
      });
      input.addEventListener('change', () => this.action(() => controller.setModelParameters(id, parameters)));
    }
    refresh();
    const reset = panel.createEl('button', { cls: 'ai-advent-rag-model-reset', text: 'Сбросить' });
    reset.addEventListener('click', () => this.action(() => {
      parameters = sanitizeModelParameters(undefined);
      controller.setModelParameters(id, parameters);
      refresh();
    }));
    const events = new win.AbortController();
    anchor.setAttribute('aria-expanded', 'true');
    this.closeModelMenu = () => {
      events.abort();
      panel.remove();
      anchor.setAttribute('aria-expanded', 'false');
      this.closeModelMenu = undefined;
    };
    doc.addEventListener('pointerdown', (event) => {
      if (!panel.contains(event.target as Node) && !anchor.contains(event.target as Node)) this.closeModelMenu?.();
    }, { capture: true, signal: events.signal });
    doc.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { this.closeModelMenu?.(); anchor.focus(); }
    }, { signal: events.signal });
    win.addEventListener('resize', () => this.closeModelMenu?.(), { signal: events.signal });
    controls.get('temperature')?.input.focus();
  }

  private attachDialogActions(tab: HTMLButtonElement, id: string): void {
    let timer: number | undefined;
    let held = false;
    let origin = { x: 0, y: 0 };
    const cancelHold = (): void => {
      if (timer !== undefined) { tab.ownerDocument.defaultView?.clearTimeout(timer); this.holdTimers.delete(timer); timer = undefined; }
    };
    tab.setAttribute('aria-haspopup', 'dialog');
    tab.setAttribute('aria-expanded', 'false');
    tab.addEventListener('pointerdown', (event) => {
      cancelHold();
      held = false;
      if (event.button !== 0) return;
      origin = { x: event.clientX, y: event.clientY };
      timer = tab.ownerDocument.defaultView?.setTimeout(() => {
        cancelHold();
        held = true;
        this.openModelMenu(tab, id);
      }, 550);
      if (timer !== undefined) this.holdTimers.add(timer);
    });
    tab.addEventListener('pointermove', (event) => {
      if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 8) cancelHold();
    });
    for (const event of ['pointerup', 'pointercancel', 'pointerleave']) tab.addEventListener(event, cancelHold);
    tab.addEventListener('dragstart', (event) => { cancelHold(); if (held) event.preventDefault(); });
    tab.addEventListener('click', (event) => {
      if (held && event.detail !== 0) { event.preventDefault(); return; }
      this.action(() => this.pluginApi.chatController.selectDialog(id));
    });
    tab.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.altKey) { event.preventDefault(); this.openModelMenu(tab, id); }
    });
    tab.addEventListener('contextmenu', (event) => {
      cancelHold();
      event.preventDefault();
      event.stopPropagation();
      if (!held) this.action(() => this.pluginApi.chatController.deleteDialog(id));
    });
  }

  private refreshTabs(): void {
    const controller = this.pluginApi.chatController;
    for (const dialog of controller.state.dialogs) {
      const tab = this.tabs.get(dialog.id);
      const busy = controller.runtime(dialog.id).phase !== 'idle';
      tab?.toggleClass('is-busy', busy);
      tab?.setAttribute('aria-label', `${dialog.title}${busy ? ' · запрос выполняется или ожидает выполнения' : ''}`);
    }
  }

  private render(): void {
    this.clearModelMenu();
    const controller = this.pluginApi.chatController;
    const dialog = controller.activeDialog;
    const restoreFocus = this.queryEl === document.activeElement;
    const selection = this.queryEl?.selectionStart ?? 0;
    const container = this.contentEl;
    container.empty();
    container.addClass('ai-advent-rag-view');
    this.tabs.clear();
    this.activityEl = undefined;
    this.liveBody = undefined;
    this.contextRemoveButton = undefined;
    if (!dialog) return;
    const runtime = controller.runtime(dialog.id);
    const busy = runtime.phase !== 'idle';
    const messages = container.createDiv({ cls: 'ai-advent-rag-messages', attr: { role: 'list', 'aria-busy': busy ? 'true' : 'false' } });
    this.messagesEl = messages;
    this.renderEntries(messages);
    if (busy) {
      const pending = messages.createDiv({ cls: 'ai-advent-rag-message is-assistant is-pending', attr: { role: 'listitem' } });
      this.activityEl = pending.createDiv({ cls: 'ai-advent-rag-message-label', text: runtime.status, attr: { role: 'status', 'aria-live': 'polite' } });
      this.liveBody = pending.createDiv({ cls: 'ai-advent-rag-message-body', text: runtime.text });
    }
    if (runtime.error) messages.createDiv({ cls: 'ai-advent-rag-error', text: runtime.error, attr: { role: 'alert' } });
    const navigation = container.createEl('nav', { cls: 'ai-advent-rag-dialog-menu', attr: { 'aria-label': 'Диалоги' } });
    const tabs = navigation.createDiv({ cls: 'ai-advent-rag-dialog-tabs' });
    controller.state.dialogs.forEach((item, index) => {
      const tab = this.iconButton(tabs, 'file-text', item.title);
      tab.addClass('ai-advent-rag-dialog-tab');
      tab.toggleClass('is-active', item.id === dialog.id);
      tab.setAttribute('aria-pressed', item.id === dialog.id ? 'true' : 'false');
      tab.createSpan({ cls: 'ai-advent-rag-dialog-number', text: String(index + 1), attr: { 'aria-hidden': 'true' } });
      tab.setAttribute('title', `${item.title} · удерживайте для настроек · перетащите для перемещения · клик двумя пальцами — удалить`);
      this.attachDialogActions(tab, item.id);
      tab.draggable = true;
      tab.addEventListener('dragstart', (event) => {
        if (event.defaultPrevented) return;
        this.draggedDialogId = item.id;
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', item.id);
        }
        tab.addClass('is-dragging');
      });
      tab.addEventListener('dragover', (event) => {
        if (!this.draggedDialogId || this.draggedDialogId === item.id) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        const after = event.clientX > tab.getBoundingClientRect().left + tab.offsetWidth / 2;
        tab.toggleClass('is-drop-before', !after);
        tab.toggleClass('is-drop-after', after);
      });
      tab.addEventListener('dragleave', () => {
        tab.removeClass('is-drop-before', 'is-drop-after');
      });
      tab.addEventListener('drop', (event) => {
        const sourceId = this.draggedDialogId;
        if (!sourceId) return;
        event.preventDefault();
        const after = event.clientX > tab.getBoundingClientRect().left + tab.offsetWidth / 2;
        this.draggedDialogId = undefined;
        this.action(() => controller.moveDialog(sourceId, item.id, after));
        for (const button of this.tabs.values()) button.removeClass('is-dragging', 'is-drop-before', 'is-drop-after');
      });
      tab.addEventListener('dragend', () => {
        this.draggedDialogId = undefined;
        for (const button of this.tabs.values()) button.removeClass('is-dragging', 'is-drop-before', 'is-drop-after');
      });
      this.tabs.set(item.id, tab);
    });
    const add = this.iconButton(tabs, 'plus', 'Новый диалог');
    add.disabled = controller.state.dialogs.length >= MAX_DIALOGS;
    add.addEventListener('click', () => this.action(() => {
      controller.createDialog();
      this.queryEl?.focus();
    }));
    const answer = lastAssistantAnswer(dialog.entries);
    const insert = this.iconButton(navigation, 'clipboard-paste', 'Вставить последний ответ в заметку');
    insert.addClass('ai-advent-rag-insert-answer');
    insert.disabled = busy || answer === undefined;
    insert.addEventListener('pointerdown', (event) => { event.preventDefault(); });
    insert.addEventListener('click', () => this.action(() => {
      if (answer !== undefined) this.pluginApi.insertAnswer(answer);
    }));
    const composer = container.createDiv({ cls: 'ai-advent-rag-composer' });
    if (dialog.contextPath) {
      const chips = composer.createDiv({ cls: 'ai-advent-rag-context-chips' });
      const context = chips.createDiv({ cls: 'ai-advent-rag-note-context' });
      const noteIcon = context.createDiv({ cls: 'ai-advent-rag-context-icon', attr: { 'aria-hidden': 'true' } });
      setIcon(noteIcon, 'file-text');
      context.createSpan({
        text: dialog.contextPath.split('/').at(-1)!.replace(/\.md$/u, ''),
        attr: { title: `Страница в контексте запроса: ${dialog.contextPath}` },
      });
      this.contextRemoveButton = this.iconButton(context, 'x', 'Убрать страницу из контекста');
      this.contextRemoveButton.disabled = runtime.phase === 'running';
      this.contextRemoveButton.addEventListener('click', () => this.action(() => controller.removeContext(dialog.id)));
    }
    const inputId = `ai-advent-rag-question-${dialog.id}`;
    const query = composer.createEl('textarea', { cls: 'ai-advent-rag-question',
      attr: { id: inputId, 'aria-label': 'Сообщение', rows: '2', maxlength: '4000' } });
    this.queryEl = query;
    query.value = controller.drafts.get(dialog.id) ?? '';
    query.disabled = busy;
    query.addEventListener('input', () => { controller.drafts.set(dialog.id, query.value); });
    const submit = (): void => {
      const value = query.value.trim();
      if (!value) return;
      void controller.send(dialog.id, value).catch((error: unknown) => {
        new Notice(error instanceof Error ? error.message : String(error));
      });
    };
    query.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submit();
      }
    });
    const analytics = this.iconButton(composer, 'chart-no-axes-combined', 'Аналитика диалога');
    analytics.addClass('ai-advent-rag-analytics-toggle');
    const panel = container.createDiv({ cls: 'ai-advent-rag-analytics' });
    panel.id = `ai-advent-analytics-${dialog.id}`;
    analytics.setAttribute('aria-controls', panel.id);
    const updateAnalytics = (): void => {
      const open = this.analyticsOpen.has(dialog.id);
      analytics.setAttribute('aria-expanded', String(open));
      panel.hidden = !open;
      panel.empty();
      if (!open) return;
      panel.createDiv({ cls: 'ai-advent-rag-analytics-title', text: 'Аналитика диалога' });
      const rows = analyticsRows(dialog.entries);
      if (!rows.length) panel.createDiv({ text: 'Данные появятся после следующего ответа модели.' });
      for (const [label, value] of rows) {
        const row = panel.createDiv({ cls: 'ai-advent-rag-analytics-row' });
        row.createSpan({ text: label }); row.createSpan({ text: value });
      }
      if (rows.length) panel.createDiv({ cls: 'ai-advent-rag-analytics-note', text: 'Время первого токена — от отправки финального запроса в Qwen. Память — снимок модели, не пик; GPU входит в её объём. CPU и энергопотребление не измеряются. Итоги учитывают сохранённые ответы с аналитикой, включая служебные вызовы RAG.' });
    };
    analytics.addEventListener('pointerdown', (event) => event.preventDefault());
    analytics.addEventListener('click', () => {
      if (this.analyticsOpen.has(dialog.id)) this.analyticsOpen.delete(dialog.id);
      else this.analyticsOpen.add(dialog.id);
      updateAnalytics();
    });
    updateAnalytics();
    this.refreshTabs();
    messages.scrollTop = messages.scrollHeight;
    if (restoreFocus && !busy) { query.focus(); query.setSelectionRange(selection, selection); }
  }

  private refreshProgress(): void {
    const controller = this.pluginApi.chatController;
    this.refreshTabs();
    const dialog = controller.activeDialog;
    if (!dialog) return;
    const runtime = controller.runtime(dialog.id);
    this.contextRemoveButton && (this.contextRemoveButton.disabled = runtime.phase === 'running');
    this.activityEl?.setText(runtime.status);
    this.liveBody?.setText(runtime.text);
    if (this.messagesEl && runtime.phase === 'running') this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private renderEntries(container: HTMLElement): void {
    container.empty();
    if ((this.pluginApi.chatController.activeDialog?.entries.length ?? 0) === 0) {
      const card = container.createDiv({
        cls: 'ai-advent-rag-empty',
        attr: { role: 'listitem' },
      });
      const icon = card.createDiv({ cls: 'ai-advent-rag-empty-icon', attr: { 'aria-hidden': 'true' } });
      setIcon(icon, 'message-square');
      const content = card.createDiv({ cls: 'ai-advent-rag-empty-content' });
      content.createEl('h4', { text: 'Сообщений пока нет' });
      content.createEl('p', { text: 'Задайте вопрос — Qwen найдёт подходящие фрагменты заметок.' });
      return;
    }

    for (const entry of this.pluginApi.chatController.activeDialog?.entries ?? []) {
      const message = container.createDiv({
        cls: `ai-advent-rag-message is-${entry.role}`,
        attr: { role: 'listitem' },
      });
      const header = message.createDiv({ cls: 'ai-advent-rag-message-header' });
      header.createDiv({
        cls: 'ai-advent-rag-message-label',
        text: entry.role === 'user'
          ? 'Вы'
          : entry.modelCalled === false
            ? entry.usedRetrievalEnhancements
              ? 'RAG · локальный отказ после переформулирования'
              : 'RAG · локальный ответ'
            : entry.usedRag
              ? entry.usedRetrievalEnhancements
                ? 'Qwen (локально) · RAG с фильтрацией'
                : 'Qwen (локально) · базовый RAG'
              : 'Qwen (локально) · без RAG',
      });
      const copy = this.iconButton(header, 'copy', entry.role === 'user' ? 'Скопировать сообщение' : 'Скопировать ответ');
      copy.addClass('ai-advent-rag-copy-message');
      copy.addEventListener('click', () => {
        void (async () => {
          copy.disabled = true;
          try {
            const clipboard = copy.ownerDocument.defaultView?.navigator.clipboard;
            if (!clipboard) throw new Error('Буфер обмена недоступен.');
            await clipboard.writeText(entry.content);
            setIcon(copy, 'check');
            copy.setAttribute('title', 'Скопировано');
            copy.setAttribute('aria-label', 'Скопировано');
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error));
          } finally {
            copy.disabled = false;
          }
        })();
      });
      const body = message.createDiv({ cls: 'ai-advent-rag-message-body' });
      if (entry.role === 'assistant') {
        this.renderAnswer(body, entry.content, entry.sources ?? []);
        if (entry.usedRag && ((entry.sources?.length ?? 0) > 0 || entry.retrieval)) {
          const sources = message.createEl('details', { cls: 'ai-advent-rag-source-details' });
          sources.createEl('summary', { text: `Источники · ${entry.sources?.length ?? 0}` });
          if (entry.groundingStatus === 'grounded') {
            this.renderGroundedCitations(sources, entry.citations ?? [], entry.sources ?? []);
          }
          if (entry.retrieval) this.renderRetrievalDiagnostics(sources, entry.retrieval);
          this.renderSentSources(sources, entry.sources ?? [], entry.usedRetrievalEnhancements);
        }
      } else {
        body.setText(entry.content);
      }
    }
    container.scrollTop = container.scrollHeight;
  }

  private renderAnswer(container: HTMLElement, answer: string, sources: readonly SearchResult[]): void {
    for (const part of citationParts(answer, sources)) {
      if (!part.source) {
        container.createSpan({ text: part.text });
        continue;
      }
      const link = container.createEl('a', {
        href: '#',
        text: part.text,
        attr: { 'aria-label': `Открыть ${sourceLinkText(part.source)}` },
      });
      link.addEventListener('click', (event) => {
        event.preventDefault();
        void this.openSource(part.source!);
      });
    }
  }

  private renderRetrievalDiagnostics(
    container: HTMLElement,
    diagnostics: RetrievalDiagnostics,
  ): void {
    if (!(!diagnostics.queryRewritten && diagnostics.rewriteFailed) && !diagnostics.groundingRepairAttempted) return;
    const details = container.createDiv({ cls: 'ai-advent-rag-retrieval-details' });
    if (!diagnostics.queryRewritten && diagnostics.rewriteFailed) {
      details.createDiv({ text: 'Переформулирование не удалось — использован исходный вопрос.' });
    }
    if (diagnostics.groundingRepairAttempted) {
      details.createDiv({
        text: diagnostics.groundingValidationFailed
          ? 'Ответ модели дважды не прошёл локальную проверку цитат и был заменён безопасным отказом.'
          : 'Первый ответ модели не прошёл проверку цитат; исправленная версия подтверждена локально.',
      });
    }
  }

  private renderGroundedCitations(
    container: HTMLElement,
    citations: readonly GroundedCitation[],
    sources: readonly SearchResult[],
  ): void {
    const section = container.createDiv({ cls: 'ai-advent-rag-grounded-citations' });
    section.createDiv({
      cls: 'ai-advent-rag-grounded-citations-title',
      text: 'Источники и проверенные цитаты',
    });
    const list = section.createEl('ol');
    for (const citation of citations) {
      const item = list.createEl('li');
      const trustedSource = sources.find((source) => source.sourceId === citation.sourceId);
      if (trustedSource) {
        const link = item.createEl('a', {
          href: '#',
          text: `${citation.sourceId}: ${sourceLinkText(trustedSource)}`,
        });
        link.addEventListener('click', (event) => {
          event.preventDefault();
          void this.openSource(trustedSource);
        });
      } else {
        item.createSpan({ text: `${citation.sourceId}: ${citation.source}` });
      }
      item.createDiv({
        cls: 'ai-advent-rag-citation-metadata',
        text: `Раздел: ${citation.section ?? 'без раздела'} · chunk_id: ${citation.chunkId}`,
      });
      item.createEl('blockquote', { text: citation.quote });
    }
  }

  private renderSentSources(
    container: HTMLElement,
    sources: readonly SearchResult[],
    _usedRetrievalEnhancements = false,
  ): void {
    const section = container.createDiv({ cls: 'ai-advent-rag-sent-sources' });
    section.createDiv({
      cls: 'ai-advent-rag-sent-sources-title',
      text: 'Фрагменты, отправленные в Qwen (локально)',
    });
    if (sources.length === 0) {
      section.createDiv({
        text: 'Фрагменты не найдены. Модель получила вопрос и историю диалога.',
      });
      return;
    }
    const list = section.createEl('ul');
    for (const source of sources) {
      const item = list.createEl('li');
      const link = item.createEl('a', {
        href: '#',
        text: `${source.sourceId}: ${sourceLinkText(source)}`,
      });
      link.addEventListener('click', (event) => {
        event.preventDefault();
        void this.openSource(source);
      });
      item.createSpan({
        cls: 'ai-advent-rag-score',
        text: source.isSelection
          ? ` · выделенный текст · С ${source.chunk.metadata.line_start}–${source.chunk.metadata.line_end}`
          : source.isActiveNote
          ? ` · закреплённая заметка${source.contextTruncated ? ' · первые 12 000 символов' : ''}`
          : ` · sim ${source.score.toFixed(3)} · С ${source.chunk.metadata.line_start}–${source.chunk.metadata.line_end}${source.contextTruncated ? ' · текст обрезан до лимита' : ''}`,
      });
    }
  }

  private async openSource(source: SearchResult): Promise<void> {
    try {
      await this.pluginApi.openSource(source);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

}
