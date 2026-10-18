# AskMyMind

[AI-ревью pull request](docs/ai-pr-review.md) ищет контекст в документации и коде проекта и публикует замечания в PR после настройки ключа модели в GitHub Actions.

Desktop-only Obsidian plugin for local semantic search and RAG chat over a vault.

The **Day 27** build runs the complete chat pipeline on local **Qwen via Ollama**: streaming answers and query rewriting. No cloud model or API key is required. Earlier Day 22–25 sections below describe the historical DeepSeek experiments.

## Requirements

- Obsidian desktop
- Node.js 22.12 or newer for development
- Local Ollama with `qwen3.8:27b` (chat) and `qwen3-embedding:0.6b` (search) installed.

## Development

```bash
npm install
npm run dev
```

Copy the built `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/ai-advent-rag`, then enable **AskMyMind** in Community plugins. The plugin ID and directory name remain `ai-advent-rag` so existing settings, indexes and Invest Manager integration keep working.

## Usage — Day 27

1. Start Ollama on `http://127.0.0.1:11434`.
2. Open **Settings → AskMyMind**. The default chat model is the locally installed `qwen3.8:27b`; you can enter another installed chat model name.
3. Select **Проверить подключение** to test both model availability and an actual response. A cold model start can take a few minutes.
4. Choose folders and rebuild the local index if necessary. Embeddings use `qwen3-embedding:0.6b` independently of the chat model.
5. Open **AskMyMind** using the ribbon or command palette and send a question.
6. Regular questions use RAG: query rewriting and filtering run before streaming the answer with links to retrieved notes. The old direct and basic RAG switches have been removed. `/fmt` uses the selected page directly, as described below.

## Formatting with /fmt

Install `vault-skills/fmt/SKILL.md` at `<vault>/.agents/skills/fmt/SKILL.md`. Create a dialog with the desired page selected in its context chip and send `/fmt` or `/format`. Optional instructions follow the command, for example `/fmt сохрани все заголовки`.

The skill formats Markdown and corrects spelling, punctuation, grammar and syntax while preserving meaning, facts and protected Obsidian objects. The full page is read when the queued task starts. Formatting makes one local model call, without RAG, query rewriting or chat history, and does not require a search index. Results appear in the dialog; the source page is not overwritten. The skill is reloaded from the vault on every request.

Formatting defaults to temperature **0.1**, repeat penalty **1.0**, a **32,768-token** context and up to **8,192 output tokens**, with thinking disabled. Per-dialog parameters override these defaults. Pages over **12,000 characters** are rejected rather than silently truncated. A response that reaches the output token limit is treated as incomplete.

Run `node scripts/run-fmt-smoke.mjs` to test the installed local Qwen on synthetic notes. The script prints the temporary directory containing inputs, outputs and invariant checks; no real notes are edited.

Existing cloud settings migrate automatically to local Ollama. The plugin does not fall back to a cloud model if Ollama is unavailable. The connection check sends only a test question. Chat history remains in `rag-chat-state.json`; a two-finger click (secondary click) on a dialog icon deletes that dialog. Dialog defaults disable thinking and use temperature 0.1, repeat penalty 1.0, a 32,768-token context window and up to 8,192 output tokens.

The current chat has no task memory or context sufficiency gate. Even with no retrieved fragments, Qwen generates an answer. Responses are plain text; citations are no longer validated or repaired. The chat shows retrieval stages and streams the actual model response. Existing task memory is discarded when loading old chat state. Historical Day 24–25 sections below describe earlier builds.

## Parallel dialogs and task queue

The panel supports up to **10 dialogs**, each with an independent history and draft. The **+** icon in the bottom menu captures the currently active Markdown note. A context chip shows its path; **×** removes the pinned attachment. Removing it leaves normal vault-wide RAG search enabled, so retrieval can still find that note. A dialog without an active Markdown note starts without an attachment. Existing single-chat history migrates into **Предыдущий диалог** without deleting messages.

Pinned notes keep their original identity as the user switches pages. At execution time, the plugin reads the current note text, including the open editor buffer. Up to the first **12,000 characters** are passed to query rewriting and reserved as the first source for the answer; larger notes display a truncation label. Only the attachment path is persisted, not a duplicate of its text. Rename events update the attachment path. If a note disappears, the request reports an error and asks the user to remove the attachment.

One shared FIFO queue executes a complete pipeline at a time: note reading, rewriting, embeddings, retrieval, and streaming generation. Dialogs with a waiting or running request are highlighted in the bottom icon menu. Queue position and global model occupancy are not shown. Switching tabs or closing the panel does not interrupt a running request. A dialog permits one outstanding message; other dialogs remain available. Connection tests, standalone searches, and index rebuilds also use this queue. A failed task restores its message for retry and releases the next task.

Dialog histories, selection, and attachment paths survive restart in version 2 of `rag-chat-state.json`. Waiting/running jobs and drafts are transient; an unanswered message after restart is marked as interrupted and can be sent again. Enter sends a message; Shift+Enter inserts a newline. There is no send, clear, or delete button. A two-finger click (secondary click) on an icon deletes that specific dialog. A busy dialog cannot be deleted; removing a queued note attachment is allowed until the task starts.

Hold a dialog icon for about half a second to open a panel above it with sliders for temperature, repetition penalty, output length and context size. Settings are saved per dialog and apply to regular questions and `/fmt`. Each submitted request captures its parameters immediately; changing sliders does not alter queued or running requests. Click outside the panel or press Escape to close it. Alt+Enter on a focused dialog icon also opens the panel. Reset restores the formatting defaults. The output limit is capped at half the context window to leave room for input.

The clipboard icon at the far right of the dialog navigation row inserts the active dialog’s latest completed model answer into the current note at the editor cursor (replacing the selection, if present). It is disabled while a request is pending or there is no answer. If no editable note is open, the plugin shows a notice. Insertion uses the normal editor operation and can be undone. Each completed user or model message has a copy icon that appears on hover or keyboard focus and copies its original text, preserving Markdown. A check mark confirms successful copying.

If the currently open editable note has selected text, sending a message captures that exact fragment as the primary context with the instruction to apply the action only to it. The snapshot is taken before queuing, even if the pinned page is different or absent. Without a selection, the pinned page behavior remains unchanged. `/fmt` formats only the selected fragment and preserves its headings. Selections over 12,000 characters are rejected instead of truncated. Selection sources keep their original note line numbers.

## Day 27 verification

```bash
npm test
npm run build
npm run lint
```

Run the local end-to-end check (synthetic notes, no vault content):

```bash
node scripts/run-day27-smoke.mjs
```

## Day 21 — document indexing

The indexing pipeline is:

```text
Markdown notes → chunking → local Qwen embeddings → selected local index
Search query → local Qwen embedding → cosine similarity → matching fragments
```

The storage format is selected in the plugin settings. Changing it does not replace the working index immediately: the new backend becomes active only after a successful rebuild. The available files are:

| Format | Local files | Notes |
| --- | --- | --- |
| Binary | `rag-indexes/rag-index.bin` | Compact default with JSON metadata and contiguous `Float32` vectors |
| JSON | `rag-indexes/rag-index.json` | Human-readable and easy to inspect, but larger |
| SQLite | `rag-indexes/rag-index.sqlite` | Structured tables for metadata, chunks, and vector BLOBs |
| FAISS | `rag-indexes/rag-index.faiss` and `rag-indexes/rag-index.faiss.json` | Real `IndexFlatIP` vector search plus a sidecar containing note text and metadata |

Every backend records:

- `source` — vault-relative note path;
- `title` — note filename;
- `section` — Markdown heading path when available;
- `chunk_id` — deterministic identifier;
- line range, file modification time, content hash, and ordinal.

The selected local storage also contains the full, unencrypted text of every indexed chunk so the search UI can display it. Anyone who can read the plugin directory can therefore recover indexed note fragments. Previous formats are intentionally retained as rollback copies after a successful switch. Index files live in the plugin's `rag-indexes` directory. To remove current and stale derived data, disable the plugin and delete the `rag-indexes` directory; rebuilding creates the selected format again from the notes.

FAISS is a native dependency and must be compatible with the operating system, CPU architecture, and the Node runtime embedded in Obsidian. If it cannot be loaded, the plugin keeps the previously active index and shows a Russian error asking the user to select another format. SQLite is produced by the portable `sql.js` engine and does not require a system SQLite installation.

Two chunking strategies are available. Fixed-size chunking defaults to 3,200 characters and is configurable from 256 to 20,000 characters. Its overlap is calculated automatically as 12.5% of the selected size, capped at 400 characters. Structure-aware chunking preserves the selected semantic unit without applying the fixed-size limit:

| Strategy | Behavior | Typical trade-off |
| --- | --- | --- |
| Fixed size | Splits the complete file into uniform overlapping windows | Predictable chunk sizes, but a window can cross section boundaries |
| Markdown paragraphs | Creates one chunk per blank-line-delimited text block while preserving heading metadata | Precise matches, but less surrounding context |
| Markdown sections | Creates one chunk per heading section | Strong topical context, but long sections produce large chunks |
| Complete files | Creates one chunk per note | Maximum context, but large notes can reduce retrieval precision or exceed embedding-model input limits |

Every rebuild evaluates both strategies locally on the same corpus, while embeddings are generated only for the selected strategy. Settings show document count, source characters, estimated page count, chunk count, average size, p95 size, and section-metadata coverage for both strategies. Using 1,800 characters as one approximate page makes it immediately visible whether the challenge target of 20–30 pages is met.

To reproduce the comparison:

1. Put at least 20–30 pages of Markdown text, README content, articles, or code converted to text into the selected vault folders. A reproducible 27-page corpus can be exported from this repository:

   ```bash
   npm run prepare:day21-corpus -- "/path/to/vault/AI Advent — Day 21"
   ```

2. Rebuild with **Фиксированный размер** and record the comparison plus the top five results for these queries:

   - `How does fixed-size chunking work?`
   - `How is the binary vector index saved?`
   - `What happens when the embedding model fingerprint changes?`

3. Rebuild with **По структуре Markdown** and repeat exactly the same queries.
4. Compare fragment boundaries, section labels, chunk counts, and retrieval ranking.

No LLM participates in this experiment. The only model call is to the local Ollama embedding endpoint.

## Day 22 — first RAG request

The two request paths are:

```text
Without RAG: question + recent chat history → DeepSeek → answer
With RAG:    question → local Qwen search → bounded source context + question + history → DeepSeek → answer + local source links
```

The DeepSeek client is pinned to the official `https://api.deepseek.com` endpoint and uses the Chat Completions API. The default model is `deepseek-flash` with thinking disabled for predictable cost and latency, while the model field remains editable. The question is limited to 4,000 characters, recent model context to 12 turns / 16,000 characters, and source context to 50,000 characters. The panel prevents duplicate concurrent sends. Since Day 25, up to 80 messages and the task memory are persisted locally.

The reproducible set of ten expected questions and sources lives in [`eval/day22-control-questions.json`](eval/day22-control-questions.json). The scoring rubric and result table live in [`docs/day-22-quality-comparison.md`](docs/day-22-quality-comparison.md). The evaluation uses the same DeepSeek model for both modes.

## Day 23 — query rewrite, filtering, and reranking

The improved retrieval path is:

```text
question + recent mode-specific history
  → DeepSeek query rewrite
  → local Qwen search for candidate top-K
  → configurable similarity threshold
  → source-aware heuristic reranking and sibling-section expansion
  → final top-K
  → DeepSeek answer with the selected note fragments
```

The baseline mode embeds the original question, applies no relevance threshold or query rewrite, and sends at most the configured final top-K. The improved mode first uses DeepSeek to resolve contextual references such as “it” or “that recipe”. After the configurable similarity minimum, query-token matches in source metadata are preferred as anchors; a strong semantic score is used as a fallback when metadata has no lexical match. Anchored sources within `0.05` of the best anchor are retained; content-rich sections receive a small heuristic bonus, while heading-only and frontmatter chunks receive a penalty. This preserves useful sibling sections when a title chunk scores higher than the actual answer text.

Default retrieval settings are 20 candidates, a `0.35` similarity threshold, and at most 5 final chunks. The chat shows the rewritten query, candidate and result counts, final similarity values, and every fragment sent to DeepSeek. Baseline and improved histories are isolated so switching modes does not contaminate the comparison.

The contextual evaluation set is [`eval/day23-control-questions.json`](eval/day23-control-questions.json), the complete API output is written to `eval/day23-results.json`, and the scored comparison is documented in `docs/day-23-quality-comparison.md`. Reproduce it with:

```bash
npm run eval:day23 -- "/path/to/vault" --confirm-send-notes
```

## Day 24 — citations, sources, and anti-hallucination checks

The grounded answer path is:

```text
retrieved chunks
  → DeepSeek structured JSON answer
  → local schema validation
  → exact source / section / chunk_id validation
  → verbatim quote validation against chunk text
  → rendered answer + trusted source links + quotes
```

For an answered response, the model must return `status=answered`, an answer containing `[S…]` references, and a non-empty source list. Every source entry includes the exact `source`, `section`, `chunk_id`, and a contiguous quote from the corresponding chunk. Unknown IDs, changed metadata, missing citations, or fabricated quotes are rejected locally. The model gets one constrained repair request; if that also fails, the unverified answer is never displayed.

When improved retrieval leaves no chunks at or above the configured similarity threshold, the answer-generation request is skipped. The plugin responds: “Не знаю … Пожалуйста, уточните вопрос.” Model-level `not_enough_context` responses must use the same wording contract and contain no fabricated evidence.

The ten answerable control questions and one separate weak-context control live in `eval/day24-control-questions.json`. Complete structured output and validation results are written to `eval/day24-results.json`; the human-readable table is in `docs/day-24-grounding-evaluation.md`. Reproduce the run with:

```bash
npm run eval:day24 -- "/path/to/vault" --confirm-send-notes
```

## Day 25 — persistent mini-chat and task memory

The production-like chat path is:

```text
new user message + recent mode-specific history + previous task memory
  → DeepSeek task-memory update (goal, clarified facts, constraints, terms)
  → DeepSeek query rewrite with the updated memory
  → local Qwen retrieval, filtering, and reranking
  → DeepSeek grounded answer with history, memory, and retrieved chunks
  → local source, metadata, and verbatim-quote validation
  → local persistence of the compact chat state
```

The three chat modes—without RAG, basic RAG, and improved RAG—keep separate histories and task memories, so switching a comparison mode does not leak context into another one. The persisted file is `rag-chat-state.json` in the plugin directory. It contains message text, compact source metadata, citations, diagnostics, and task memory, but never stores vector values or duplicate chunk text. Writes are atomic and the file is created with owner-only permissions where the operating system supports them.

Two reproducible ten-message conversations live in `eval/day25-long-scenarios.json`: a weekend cooking plan and an October BJJ training plan. Each turn checks that a validated source and exact quote are returned; the final checks verify that the goal, constraints, and defined term remain in task memory. Complete output is written to `eval/day25-results.json` and summarized in `docs/day-25-long-chat-evaluation.md`. Reproduce the run with:

```bash
npm run eval:day25 -- "/path/to/vault" --confirm-send-notes
```

## Checks

```bash
npm test
npm run build
npm run lint
```

## Privacy

- All active embedding and chat requests go to local Ollama on `127.0.0.1`; no API key is needed.
- Questions, history, and retrieved note fragments are processed on this computer.
- The local index contains full unencrypted text of indexed chunks.
- Up to 10 dialogs with 80 messages each are saved locally in `rag-chat-state.json`.
- A secondary click on a dialog icon deletes that dialog and its history.
- The plugin does not include telemetry or cloud fallback.
