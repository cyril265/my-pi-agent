const annotateData = JSON.parse(document.getElementById("annotate-data").textContent || "{}");

const defaultTheme = {
  appearance: "dark",
  bg: "#0b1020",
  panel: "#111827",
  hover: "#1f2937",
  border: "#263244",
  text: "#e5e7eb",
  strong: "#f8fafc",
  muted: "#9ca3af",
  dim: "#64748b",
  accent: "#60a5fa",
  success: "#34d399",
  error: "#fb7185",
};
const theme = { ...defaultTheme, ...(annotateData.theme || {}) };

for (const [key, value] of Object.entries({
  bg: theme.bg,
  panel: theme.panel,
  hover: theme.hover,
  border: theme.border,
  text: theme.text,
  strong: theme.strong,
  muted: theme.muted,
  accent: theme.accent,
  success: theme.success,
  error: theme.error,
})) {
  document.documentElement.style.setProperty(`--color-review-${key}`, value);
}
document.documentElement.style.colorScheme = theme.appearance;

const state = {
  overallComment: "",
  comments: [],
  wrapLines: true,
};

let monacoApi = null;
let editor = null;
let model = null;
let decorations = [];
let viewZones = [];
let hoverDecoration = null;

const windowTitleEl = document.getElementById("window-title");
const sourceHintEl = document.getElementById("source-hint");
const summaryEl = document.getElementById("summary");
const editorContainerEl = document.getElementById("editor-container");
const overallCommentButton = document.getElementById("overall-comment-button");
const copyButton = document.getElementById("copy-button");
const toggleWrapButton = document.getElementById("toggle-wrap-button");
const cancelButton = document.getElementById("cancel-button");
const submitButton = document.getElementById("submit-button");

windowTitleEl.textContent = annotateData.title || "Annotate turn";
sourceHintEl.textContent = annotateData.sourceHint || "Annotate the latest assistant response.";

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[char]);
}

function hasSubmittableFeedback() {
  return state.overallComment.trim().length > 0 || state.comments.some((comment) => comment.body.trim().length > 0);
}

function selectedText() {
  if (!editor) return "";
  const selection = editor.getSelection();
  if (!selection || selection.isEmpty()) return "";
  return editor.getModel().getValueInRange(selection);
}

function textToCopy() {
  return selectedText() || annotateData.text || "";
}

async function copyText(text) {
  if (!text) return;

  if (window.glimpse?.send) {
    window.glimpse.send({ type: "copy-text", text });
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
    editor?.focus();
  }
}

function updateSummary() {
  const filledComments = state.comments.filter((comment) => comment.body.trim().length > 0).length;
  const drafts = state.comments.length - filledComments;
  summaryEl.textContent = `${filledComments} comment(s)${drafts > 0 ? ` • ${drafts} draft(s)` : ""}${state.overallComment ? " • overall note" : ""}`;
  toggleWrapButton.textContent = `Wrap lines: ${state.wrapLines ? "on" : "off"}`;
  submitButton.disabled = !hasSubmittableFeedback();
}

function layoutEditor() {
  if (!editor) return;
  const width = editorContainerEl.clientWidth;
  const height = editorContainerEl.clientHeight;
  if (width > 0 && height > 0) editor.layout({ width, height });
}

function clearViewZones() {
  if (!editor || viewZones.length === 0) return;
  editor.changeViewZones((accessor) => {
    for (const id of viewZones) accessor.removeZone(id);
  });
  viewZones = [];
}

function syncCommentBodiesFromDOM() {
  document.querySelectorAll("textarea[data-comment-id]").forEach((textarea) => {
    const comment = state.comments.find((item) => item.id === textarea.dataset.commentId);
    if (comment) comment.body = textarea.value;
  });
}

function renderCommentDOM(comment) {
  const container = document.createElement("div");
  container.className = "view-zone-container";
  container.innerHTML = `
    <div class="mb-2 flex items-center justify-between gap-3">
      <div class="text-xs font-semibold text-review-text">Line ${comment.line} • ${escapeHtml(annotateData.sourceLabel || "latest response")}</div>
      <button data-action="delete" class="cursor-pointer rounded-md border border-transparent bg-transparent px-2 py-1 text-xs font-medium text-review-muted hover:bg-review-error/10 hover:text-review-error">Delete</button>
    </div>
    <textarea data-comment-id="${escapeHtml(comment.id)}" rows="2" class="min-h-[44px] w-full resize-y rounded-md border border-review-border bg-review-bg px-3 py-1.5 text-sm text-review-text outline-none focus:border-review-accent focus:ring-1 focus:ring-review-accent" placeholder="Leave a comment"></textarea>
  `;
  const textarea = container.querySelector("textarea");
  textarea.value = comment.body || "";
  textarea.addEventListener("input", () => {
    comment.body = textarea.value;
    updateSummary();
  });
  container.addEventListener("mousedown", (event) => event.stopPropagation());
  container.addEventListener("click", (event) => event.stopPropagation());
  container.querySelector("[data-action='delete']").addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    state.comments = state.comments.filter((item) => item.id !== comment.id);
    syncCommentsUI();
  });
  if (!comment.body) setTimeout(() => textarea.focus(), 50);
  return container;
}

function syncCommentsUI() {
  syncCommentBodiesFromDOM();
  clearViewZones();
  if (!editor || !monacoApi) return;

  const sorted = [...state.comments].sort((a, b) => a.line - b.line);
  decorations = editor.deltaDecorations(decorations, sorted.map((comment) => ({
    range: new monacoApi.Range(comment.line, 1, comment.line, 1),
    options: {
      isWholeLine: true,
      className: "annotate-comment-line",
      glyphMarginClassName: "annotate-comment-glyph",
      glyphMarginHoverMessage: { value: "Annotation comment" },
    },
  })));

  editor.changeViewZones((accessor) => {
    for (const comment of sorted) {
      const domNode = renderCommentDOM(comment);
      const lineCount = Math.max(6, Math.ceil((comment.body || "").length / 80) + 3);
      viewZones.push(accessor.addZone({
        afterLineNumber: comment.line,
        heightInLines: lineCount,
        domNode,
        suppressMouseDown: false,
      }));
    }
  });
  updateSummary();
  requestAnimationFrame(layoutEditor);
}

function focusComment(commentId) {
  setTimeout(() => {
    document.querySelector(`textarea[data-comment-id="${CSS.escape(commentId)}"]`)?.focus();
  }, 50);
}

function addComment(line) {
  syncCommentBodiesFromDOM();
  const existing = state.comments.find((comment) => comment.line === line);
  if (existing) {
    syncCommentsUI();
    focusComment(existing.id);
    return;
  }

  const comment = {
    id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
    line,
    body: "",
  };
  state.comments.push(comment);
  syncCommentsUI();
  focusComment(comment.id);
}

function showTextModal(options) {
  const backdrop = document.createElement("div");
  backdrop.className = "review-modal-backdrop";
  backdrop.innerHTML = `
    <div class="review-modal-card">
      <div class="mb-2 text-base font-semibold text-review-strong">${escapeHtml(options.title)}</div>
      <div class="mb-4 text-sm text-review-muted">${escapeHtml(options.description)}</div>
      <textarea id="annotate-modal-text" class="min-h-48 w-full resize-y rounded-md border border-review-border bg-review-bg px-3 py-2 text-sm text-review-text outline-none focus:border-review-accent focus:ring-1 focus:ring-review-accent">${escapeHtml(options.initialValue || "")}</textarea>
      <div class="mt-4 flex justify-end gap-2">
        <button id="annotate-modal-cancel" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-4 py-2 text-sm font-medium text-review-text hover:opacity-90">Cancel</button>
        <button id="annotate-modal-save" class="cursor-pointer rounded-md border border-review-border bg-review-success px-4 py-2 text-sm font-medium text-white hover:opacity-90">${escapeHtml(options.saveLabel || "Save")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const textarea = backdrop.querySelector("#annotate-modal-text");
  const close = () => backdrop.remove();
  backdrop.querySelector("#annotate-modal-cancel").addEventListener("click", close);
  backdrop.querySelector("#annotate-modal-save").addEventListener("click", () => {
    options.onSave(textarea.value.trim());
    close();
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  textarea.focus();
}

function failRenderer(message) {
  document.body.innerHTML = `<div class="p-6 text-sm text-review-error">${escapeHtml(message)}</div>`;
  window.glimpse?.send({ type: "renderer-error", message });
}

function initializeMonaco() {
  try {
    if (!window.require) throw new Error("Monaco loader unavailable.");
    window.require.config({ paths: { vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs" } });
    window.require(["vs/editor/editor.main"], () => {
      try {
        monacoApi = window.monaco;
        monacoApi.editor.defineTheme("annotate-glimpse", {
          base: theme.appearance === "light" ? "vs" : "vs-dark",
          inherit: true,
          rules: [],
          colors: {
            "editor.background": theme.bg,
            "editor.foreground": theme.text,
            "editorLineNumber.foreground": theme.dim,
            "editorLineNumber.activeForeground": theme.accent,
            "editor.selectionBackground": `${theme.accent}33`,
          },
        });
        monacoApi.editor.setTheme("annotate-glimpse");
        model = monacoApi.editor.createModel(annotateData.text || "", "markdown");
        editor = monacoApi.editor.create(editorContainerEl, {
          model,
          readOnly: true,
          minimap: { enabled: false },
          automaticLayout: true,
          glyphMargin: true,
          lineNumbers: "on",
          lineDecorationsWidth: 16,
          scrollBeyondLastLine: false,
          wordWrap: state.wrapLines ? "on" : "off",
          wrappingIndent: "same",
          renderWhitespace: "selection",
        });
        editor.onMouseMove((event) => {
          if (!event.target?.position || event.target.type !== monacoApi.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
            hoverDecoration = editor.deltaDecorations(hoverDecoration || [], []);
            return;
          }
          hoverDecoration = editor.deltaDecorations(hoverDecoration || [], [{
            range: new monacoApi.Range(event.target.position.lineNumber, 1, event.target.position.lineNumber, 1),
            options: { glyphMarginClassName: "annotate-glyph-plus" },
          }]);
        });
        editor.onMouseDown((event) => {
          if (!event.target?.position) return;
          if (event.target.type === monacoApi.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || event.target.type === monacoApi.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
            addComment(event.target.position.lineNumber);
          }
        });
        editor.onKeyDown((event) => {
          if ((event.ctrlKey || event.metaKey) && event.code === "KeyC") {
            const text = selectedText();
            if (!text) return;
            event.preventDefault();
            event.stopPropagation();
            void copyText(text);
          }
        });
        updateSummary();
      } catch (error) {
        failRenderer(error?.message || String(error));
      }
    });
  } catch (error) {
    failRenderer(error?.message || String(error));
  }
}

submitButton.addEventListener("click", () => {
  syncCommentBodiesFromDOM();
  if (!hasSubmittableFeedback()) return;

  window.glimpse.send({
    type: "submit",
    overallComment: state.overallComment.trim(),
    comments: state.comments
      .map((comment) => ({ ...comment, body: comment.body.trim() }))
      .filter((comment) => comment.body.length > 0),
  });
  window.glimpse.close();
});

cancelButton.addEventListener("click", () => {
  window.glimpse.send({ type: "cancel" });
  window.glimpse.close();
});

copyButton.addEventListener("click", () => {
  void copyText(textToCopy());
});

document.addEventListener("copy", (event) => {
  const text = selectedText();
  if (!text || !event.clipboardData) return;
  event.clipboardData.setData("text/plain", text);
  event.preventDefault();
});

overallCommentButton.addEventListener("click", () => {
  showTextModal({
    title: "Overall annotation note",
    description: "This note is prepended to the generated prompt above the line comments.",
    initialValue: state.overallComment,
    saveLabel: "Save note",
    onSave: (value) => {
      state.overallComment = value;
      updateSummary();
    },
  });
});

toggleWrapButton.addEventListener("click", () => {
  state.wrapLines = !state.wrapLines;
  if (editor) editor.updateOptions({ wordWrap: state.wrapLines ? "on" : "off" });
  updateSummary();
  requestAnimationFrame(layoutEditor);
});

window.addEventListener("resize", layoutEditor);
initializeMonaco();
