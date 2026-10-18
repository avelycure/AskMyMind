import { describe, expect, it, vi } from 'vitest';
import { ChatController, type ChatControllerApi } from '../src/ui/chat-controller';
import { ModelTaskQueue } from '../src/llm/model-task-queue';
import { compactChatState, emptyChatState, type ChatState } from '../src/ui/chat-state';
import type { ActiveNoteContext, RagAnswer } from '../src/types';

const answer = (text: string): RagAnswer => ({ text, sources: [], citations: [], groundingStatus: 'not-applicable',
  usedRag: true, usedRetrievalEnhancements: true, modelCalled: true });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup(overrides: Partial<ChatControllerApi> = {}) {
  const queue = new ModelTaskQueue();
  let saved: ChatState = emptyChatState();
  const readNote = vi.fn(async (path: string) => ({ path, title: path, content: 'note text', mtime: 1 }));
  const api: ChatControllerApi = { activeNotePath: () => 'First.md', readNote,
    answer: vi.fn(async (question: string) => answer(question)), onError: vi.fn(), ...overrides };
  const store = { load: async () => saved, save: async (state: ChatState) => { saved = compactChatState(state); } };
  return { controller: new ChatController(store, queue, api), queue, api, readNote, saved: () => saved };
}

describe('independent queued dialogs', () => {
  it('persists reordered dialogs without changing selection, drafts or queued answers', async () => {
    const { controller, queue, saved } = setup();
    await controller.initialize();
    const first = controller.activeDialog!;
    const second = controller.createDialog();
    const third = controller.createDialog();
    controller.drafts.set(second.id, 'Draft');
    const gate = deferred();
    const blocking = queue.enqueue(() => gate.promise);
    const request = controller.send(first.id, 'Question');
    controller.moveDialog(first.id, third.id, true);
    expect(saved().dialogs.map((dialog) => dialog.id)).toEqual([second.id, third.id, first.id]);
    expect(controller.activeDialog?.id).toBe(third.id);
    expect(controller.drafts.get(second.id)).toBe('Draft');
    controller.moveDialog(first.id, second.id);
    expect(saved().dialogs.map((dialog) => dialog.id)).toEqual([first.id, second.id, third.id]);
    expect(() => controller.moveDialog(first.id, 'missing')).toThrow(/не найден/);
    gate.resolve();
    await blocking;
    await request;
    expect(first.entries.map((entry) => entry.content)).toEqual(['Question', 'Question']);
    expect(saved().dialogs.map((dialog) => dialog.id)).toEqual([first.id, second.id, third.id]);
  });
  it('cancels a running request on deletion and continues with the next dialog', async () => {
    let started = false;
    const { controller, saved } = setup({ answer: async (question, _history, _context, _progress, signal) => {
      if (question === 'first') await new Promise<void>((_resolve, reject) => {
        started = true;
        signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
      return answer(question);
    } });
    await controller.initialize();
    const first = controller.activeDialog!;
    const second = controller.createDialog();
    const running = controller.send(first.id, 'first');
    const waiting = controller.send(second.id, 'second');
    await vi.waitFor(() => expect(started).toBe(true));
    controller.deleteDialog(first.id);
    await Promise.all([running, waiting]);
    expect(saved().dialogs.map((dialog) => dialog.id)).toEqual([second.id]);
    expect(second.entries.at(-1)?.content).toBe('second');
    expect(controller.drafts.has(first.id)).toBe(false);
  });
  it('removes a queued request without sending it to the model', async () => {
    const { controller, queue, api } = setup();
    await controller.initialize();
    const gate = deferred();
    const blocking = queue.enqueue(() => gate.promise);
    const dialog = controller.activeDialog!;
    const request = controller.send(dialog.id, 'cancel me');
    controller.deleteDialog(dialog.id);
    await request;
    expect(queue.pendingCount).toBe(0);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspect a mock
    expect(api.answer).not.toHaveBeenCalled();
    gate.resolve();
    await blocking;
  });
  it('persists parameters per dialog and snapshots them when queuing the request', async () => {
    const received: number[] = [];
    const { controller, saved, queue } = setup({ answer: async (question, _history, _context, _progress, _signal, parameters) => {
      received.push(parameters!.temperature);
      return answer(question);
    } });
    await controller.initialize();
    const first = controller.activeDialog!;
    const second = controller.createDialog();
    const parameters = { temperature: 0.35, repeat_penalty: 1.1, num_predict: 4096, num_ctx: 32768 };
    controller.setModelParameters(first.id, parameters);
    expect(saved().dialogs[0]?.modelParameters).toEqual(parameters);
    expect(second.modelParameters?.temperature).toBe(0.1);
    const gate = deferred();
    const blocking = queue.enqueue(() => gate.promise);
    const pending = controller.send(first.id, 'before');
    controller.setModelParameters(first.id, { ...parameters, temperature: 0.7 });
    gate.resolve();
    await blocking;
    await pending;
    await controller.send(first.id, 'after');
    expect(received).toEqual([0.35, 0.7]);
  });
  it('captures selection at submission and prioritizes it over the pinned page while queued', async () => {
    const selected = { path: 'Other.md', title: 'Other', content: 'Original selected text', mtime: 1, isSelection: true, lineStart: 5 };
    const received: unknown[] = [];
    const { controller, queue, readNote } = setup({ activeSelection: () => selected, answer: async (question, _history, context) => {
      received.push(context);
      return answer(question);
    } });
    await controller.initialize();
    const gate = deferred();
    const blocking = queue.enqueue(() => gate.promise);
    const request = controller.send(controller.activeDialog!.id, '/fmt');
    selected.content = 'Changed selection';
    gate.resolve();
    await blocking;
    await request;
    expect(received).toEqual([{ ...selected, content: 'Original selected text' }]);
    expect(readNote).not.toHaveBeenCalled();
  });
  it('keeps the editor selection when focusing the chat clears it before /note is sent', async () => {
    let selected: ActiveNoteContext | undefined = {
      path: 'Source.md', title: 'Source', content: 'Выделенный термин', mtime: 1,
      isSelection: true, selectionStart: 0, selectionEnd: 17, sourceContent: 'Выделенный термин',
    };
    const received: unknown[] = [];
    const onSelectionCaptured = vi.fn();
    const onSelectionReleased = vi.fn();
    const { controller, readNote } = setup({ activeSelection: () => selected,
      onSelectionCaptured, onSelectionReleased, answer: async (_question, _history, context) => {
      received.push(context);
      return answer('Готово');
    } });
    await controller.initialize();
    controller.captureSelection(); // pointerdown on the chat, before editor blur
    expect(controller.selectionPreview?.content).toBe('Выделенный термин');
    expect(onSelectionCaptured).toHaveBeenCalledOnce();
    selected = undefined;
    await controller.send(controller.activeDialog!.id, '/note');
    expect(controller.selectionPreview).toBeUndefined();
    expect(onSelectionReleased).toHaveBeenCalledOnce();
    expect(received).toEqual([{
      path: 'Source.md', title: 'Source', content: 'Выделенный термин', mtime: 1,
      isSelection: true, selectionStart: 0, selectionEnd: 17, sourceContent: 'Выделенный термин',
    }]);
    expect(readNote).not.toHaveBeenCalled();
    await controller.send(controller.activeDialog!.id, '/note');
    expect(readNote).toHaveBeenCalledWith('First.md');
  });
  it('rejects oversized selection before queuing or changing history', async () => {
    const { controller, queue } = setup({ activeSelection: () => ({ path: 'Note.md', title: 'Note', content: 'x'.repeat(12001), mtime: 1, isSelection: true }) });
    await controller.initialize();
    await expect(controller.send(controller.activeDialog!.id, '/fmt')).rejects.toThrow(/не обрезать/);
    expect(controller.activeDialog!.entries).toEqual([]);
    expect(queue.pendingCount).toBe(0);
  });
  it('caps dialogs at ten and captures the active note separately for each new dialog', async () => {
    let path: string | null = 'First.md';
    const { controller } = setup({ activeNotePath: () => path });
    await controller.initialize();
    expect(controller.activeDialog?.contextPath).toBe('First.md');
    path = 'Second.md';
    const second = controller.createDialog();
    expect(second.contextPath).toBe('Second.md');
    path = null;
    while (controller.state.dialogs.length < 10) controller.createDialog();
    expect(controller.activeDialog?.contextPath).toBeNull();
    expect(() => controller.createDialog()).toThrow(/10/);
    controller.deleteDialog(second.id);
    expect(() => controller.createDialog()).not.toThrow();
  });
  it('routes ten queued answers and streamed output to their original dialogs after switching tabs', async () => {
    const gate = deferred();
    let count = 0;
    const { controller, saved } = setup({ answer: async (question, history, context, progress) => {
      expect(history).toEqual([]);
      expect(context?.path).toBe('First.md');
      progress({ kind: 'text', text: question });
      if (count++ === 0) await gate.promise;
      return answer(`answer ${question}`);
    } });
    await controller.initialize();
    while (controller.state.dialogs.length < 10) controller.createDialog();
    const ids = controller.state.dialogs.map((dialog) => dialog.id);
    const jobs = ids.map((id, index) => controller.send(id, `question ${index}`));
    await vi.waitFor(() => expect(controller.runtime(ids[0]!).text).toBe('question 0'));
    expect(controller.runtime(ids[9]!).phase).toBe('queued');
    expect(controller.runtime(ids[9]!).position).toBe(9);
    expect(controller.runtime(ids[9]!).status).toBe('В очереди: 9');
    controller.selectDialog(ids[5]!);
    expect(controller.runtime(ids[5]!).text).toBe('');
    gate.resolve();
    await Promise.all(jobs);
    controller.state.dialogs.forEach((dialog, index) => {
      expect(dialog.entries.map((entry) => entry.content)).toEqual([`question ${index}`, `answer question ${index}`]);
      expect(controller.runtime(dialog.id).phase).toBe('idle');
    });
    expect(saved().dialogs.every((dialog) => dialog.entries.length === 2)).toBe(true);
    expect(controller.state.activeDialogId).toBe(ids[5]);
  });
  it('removes pinned context before a queued task starts', async () => {
    const { controller, queue, api, readNote } = setup();
    await controller.initialize();
    const gate = deferred();
    const blocking = queue.enqueue(() => gate.promise);
    const dialog = controller.activeDialog!;
    const request = controller.send(dialog.id, 'Question');
    expect(controller.runtime(dialog.id).phase).toBe('queued');
    controller.removeContext(dialog.id);
    gate.resolve();
    await blocking;
    await request;
    expect(readNote).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- inspect a mock without invoking the method
    expect(api.answer).toHaveBeenCalledWith('Question', [], undefined, expect.any(Function), expect.any(AbortSignal), expect.any(Object));
  });
  it('isolates histories and restores the failed message for retry while the queue continues', async () => {
    const { controller } = setup({ answer: async (question, history) => {
      if (question === 'fail') throw new Error('offline');
      expect(history).toEqual([]);
      return answer('ok');
    } });
    await controller.initialize();
    const first = controller.activeDialog!;
    const second = controller.createDialog();
    await Promise.all([controller.send(first.id, 'fail'), controller.send(second.id, 'success')]);
    expect(first.entries).toHaveLength(0);
    expect(controller.drafts.get(first.id)).toBe('fail');
    expect(controller.runtime(first.id).error).toBe('offline');
    expect(second.entries).toHaveLength(2);
  });
  it('loads existing dialogs on startup but captures the active page only when the first dialog opens', async () => {
    let path = 'Startup.md';
    const { controller } = setup({ activeNotePath: () => path });
    await controller.initialize(false);
    expect(controller.state.dialogs).toHaveLength(0);
    path = 'Opened.md';
    await controller.initialize();
    expect(controller.activeDialog?.contextPath).toBe('Opened.md');
  });

  it('updates pinned note paths when a parent folder is renamed', async () => {
    const { controller } = setup({ activeNotePath: () => 'Projects/Sub/Note.md' });
    await controller.initialize();
    controller.renameNote('Projects', 'Archive');
    expect(controller.activeDialog?.contextPath).toBe('Archive/Sub/Note.md');
  });
  it('does not save a late answer after disposal over the next plugin instance', async () => {
    const gate = deferred();
    const { controller, saved } = setup({ answer: async () => { await gate.promise; return answer('late'); } });
    await controller.initialize();
    const id = controller.activeDialog!.id;
    const request = controller.send(id, 'pending');
    await vi.waitFor(() => expect(controller.runtime(id).phase).toBe('running'));
    controller.dispose();
    const before = JSON.stringify(saved());
    gate.resolve();
    await request;
    expect(JSON.stringify(saved())).toBe(before);
    expect(saved().dialogs[0]?.entries).toHaveLength(1);
  });

  it('rejects duplicate sends in the same dialog and retains note pinning after reload', async () => {
    const gate = deferred();
    const { controller, api, saved } = setup({ answer: async () => { await gate.promise; return answer('ok'); } });
    await controller.initialize();
    const dialog = controller.activeDialog!;
    const request = controller.send(dialog.id, 'hello');
    await expect(controller.send(dialog.id, 'again')).rejects.toThrow(/уже есть запрос/);
    gate.resolve();
    await request;
    const restored = new ChatController({ load: async () => saved(), save: async () => {} }, new ModelTaskQueue(), api);
    await restored.initialize();
    expect(restored.activeDialog?.contextPath).toBe('First.md');
    expect(restored.activeDialog?.entries).toHaveLength(2);
  });
});
