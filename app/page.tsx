"use client";

import { type ClipboardEvent as ReactClipboardEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isSupportedImageType, MAX_IMAGE_BYTES } from "../lib/image-upload";

type LegacyStudyPlan = {
  title: string;
  objective: string;
  estimatedMinutes: number;
  steps: { title: string; detail: string; minutes: number }[];
};
type TaskSpec = {
  title: string;
  summary: string;
  priority: "low" | "medium" | "high";
  acceptanceCriteria: string[];
  implementationNotes: string[];
};
type TaskDraft = { id: string; status: "draft"; createdAt: string; taskSpec: TaskSpec };
type ChatMessage = { id: string; role: "user" | "assistant"; content: string; pendingLabel?: string; studyPlan?: LegacyStudyPlan; taskSpec?: TaskSpec; taskDraft?: TaskDraft };
type Conversation = { id: string; title: string; updatedAt: number; messages: ChatMessage[] };
type DraftListItem = { conversationId: string; messageId: string; draft: TaskDraft };
const STORAGE_KEY = "week-one-ai-chat-conversations";

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp);
}

function useObjectUrl(file: File | null) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }

    const nextUrl = URL.createObjectURL(file);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file]);

  return url;
}

function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}

function ConversationTitle({ title }: { title: string }) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const [canScroll, setCanScroll] = useState(false);

  useEffect(() => {
    const update = () => setCanScroll((trackRef.current?.scrollWidth ?? 0) > (viewportRef.current?.clientWidth ?? 0));
    update();
    const observer = new ResizeObserver(update);
    if (viewportRef.current) observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, [title]);

  return <span className={`conversation-title ${canScroll ? "is-overflowing" : ""}`} ref={viewportRef}><span className="conversation-title-track" ref={trackRef}><span>{title}</span>{canScroll && <span aria-hidden="true">{title}</span>}</span></span>;
}

function migrateStoredConversations(conversations: Conversation[]) {
  return conversations.map((conversation) => ({
    ...conversation,
    messages: conversation.messages.map((message) =>
      message.role === "assistant" && message.content.includes("This model is currently experiencing high demand")
        ? { ...message, content: "Sorry, Gemini is temporarily busy. Please try again in a moment." }
        : message
    )
  }));
}

function StudyPlanCard({ plan }: { plan: LegacyStudyPlan }) {
  return (
    <section className="study-plan" aria-label="Structured study plan">
      <div className="plan-heading"><span>STRUCTURED PLAN</span><strong>{plan.estimatedMinutes} min</strong></div>
      <h2>{plan.title}</h2>
      <p>{plan.objective}</p>
      <ol>
        {plan.steps.map((step, index) => <li key={`${step.title}-${index}`}><div><strong>{step.title}</strong><p>{step.detail}</p></div><span>{step.minutes}m</span></li>)}
      </ol>
    </section>
  );
}

function TaskSpecCard({ spec, draft, isCreatingDraft, onChange, onCreateDraft }: { spec: TaskSpec; draft?: TaskDraft; isCreatingDraft: boolean; onChange: (next: TaskSpec) => void; onCreateDraft: () => void }) {
  return (
    <section className="task-spec" aria-label="Editable structured task specification">
      <div className="spec-heading"><span>STRUCTURED TASK SPEC</span><select value={spec.priority} disabled={Boolean(draft)} onChange={(event) => onChange({ ...spec, priority: event.target.value as TaskSpec["priority"] })} aria-label="Task priority"><option value="low">Low priority</option><option value="medium">Medium priority</option><option value="high">High priority</option></select></div>
      <input className="spec-title" value={spec.title} disabled={Boolean(draft)} onChange={(event) => onChange({ ...spec, title: event.target.value })} aria-label="Task title" />
      <textarea className="spec-summary" value={spec.summary} disabled={Boolean(draft)} onChange={(event) => onChange({ ...spec, summary: event.target.value })} aria-label="Task summary" rows={2} />
      <div className="spec-section"><h3>Acceptance criteria</h3><ul>{spec.acceptanceCriteria.map((criterion, index) => <li key={index}><input value={criterion} disabled={Boolean(draft)} onChange={(event) => { const acceptanceCriteria = [...spec.acceptanceCriteria]; acceptanceCriteria[index] = event.target.value; onChange({ ...spec, acceptanceCriteria }); }} aria-label={`Acceptance criterion ${index + 1}`} /></li>)}</ul></div>
      <div className="spec-section"><h3>Implementation notes</h3><ul>{spec.implementationNotes.map((note, index) => <li key={index}><input value={note} disabled={Boolean(draft)} onChange={(event) => { const implementationNotes = [...spec.implementationNotes]; implementationNotes[index] = event.target.value; onChange({ ...spec, implementationNotes }); }} aria-label={`Implementation note ${index + 1}`} /></li>)}</ul></div>
      {draft ? <div className="draft-receipt"><strong>Draft created</strong><span>#{draft.id.slice(0, 8)} · saved only in this browser</span></div> : <div className="draft-action"><p>Review the editable spec. Creating a draft is the approval step; nothing is published.</p><button type="button" onClick={onCreateDraft} disabled={isCreatingDraft}>{isCreatingDraft ? "Creating draft…" : "Create draft task"}</button></div>}
    </section>
  );
}

export default function Home() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [isSpecMode, setIsSpecMode] = useState(false);
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [menuConversationId, setMenuConversationId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [creatingDraftMessageId, setCreatingDraftMessageId] = useState<string | null>(null);
  const [copiedDraftId, setCopiedDraftId] = useState<string | null>(null);
  const [hasHydrated, setHasHydrated] = useState(false);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const imagePreviewUrl = useObjectUrl(selectedImage);
  const activeConversation = useMemo(() => conversations.find((c) => c.id === activeConversationId) ?? null, [activeConversationId, conversations]);
  const messages = activeConversation?.messages ?? [];
  const messageCount = messages.length;
  const drafts = useMemo(() => conversations.flatMap((conversation) => conversation.messages.flatMap((message): DraftListItem[] => message.taskDraft ? [{ conversationId: conversation.id, messageId: message.id, draft: message.taskDraft }] : [])), [conversations]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) { const parsed = JSON.parse(saved) as Conversation[]; if (Array.isArray(parsed)) setConversations(migrateStoredConversations(parsed)); }
    } catch { /* Ignore malformed local storage. */ } finally { setHasHydrated(true); }
  }, []);

  useEffect(() => { if (hasHydrated) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations)); }, [conversations, hasHydrated]);
  useEffect(() => { threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messageCount, isLoading]);

  function startNewChat() {
    if (isLoading) return;
    setActiveConversationId(null);
    setMenuConversationId(null);
    setInput("");
    clearSelectedImage();
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  function clearSelectedImage() {
    setSelectedImage(null);
    setAttachmentError(null);
    if (imageInputRef.current) imageInputRef.current.value = "";
  }

  function selectImage(file?: File) {
    setAttachmentError(null);
    if (!file) return clearSelectedImage();
    if (!isSupportedImageType(file.type)) {
      clearSelectedImage();
      return setAttachmentError("Use a PNG, JPEG, or WebP screenshot.");
    }
    if (file.size > MAX_IMAGE_BYTES) {
      clearSelectedImage();
      return setAttachmentError("Keep the screenshot under 5 MB.");
    }
    setSelectedImage(file);
    setIsSpecMode(true);
  }

  function pasteImage(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const image = Array.from(event.clipboardData.files).find((file) => file.type.startsWith("image/"))
      ?? Array.from(event.clipboardData.items).find((item) => item.kind === "file" && item.type.startsWith("image/"))?.getAsFile()
      ?? undefined;
    if (!image) return;
    event.preventDefault();
    selectImage(image);
  }

  function toggleSpecMode() {
    if (isSpecMode) clearSelectedImage();
    setIsSpecMode((current) => !current);
  }

  function updateMessages(conversationId: string, update: (messages: ChatMessage[]) => ChatMessage[]) {
    setConversations((current) =>
      current
        .map((conversation) =>
          conversation.id === conversationId
            ? { ...conversation, messages: update(conversation.messages), updatedAt: Date.now() }
            : conversation
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
    );
  }

  function deleteConversation(conversationId: string) {
    if (isLoading) return;
    setConversations((current) => current.filter((conversation) => conversation.id !== conversationId));
    setMenuConversationId(null);
    if (conversationId === activeConversationId) startNewChat();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSpecMode) return createTaskSpec();
    const text = input.trim();
    if (!text || isLoading) return;

    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content: text };
    const assistantMessage: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: "" };
    const existingMessages = activeConversation?.messages ?? [];
    const messagesForRequest = [...existingMessages, userMessage];
    const conversationId = activeConversation?.id ?? crypto.randomUUID();

    if (activeConversation) {
      updateMessages(conversationId, () => [...messagesForRequest, assistantMessage]);
    } else {
      const newConversation: Conversation = { id: conversationId, title: text.length > 42 ? `${text.slice(0, 42)}…` : text, updatedAt: Date.now(), messages: [...messagesForRequest, assistantMessage] };
      setConversations((current) => [newConversation, ...current]);
      setActiveConversationId(conversationId);
    }
    setInput("");
    setIsLoading(true);

    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: messagesForRequest.map(({ role, content }) => ({ role, content })) }) });
      if (!response.ok || !response.body) throw new Error((await response.text()) || "The AI request could not be started.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        updateMessages(conversationId, (current) => current.map((message) => message.id === assistantMessage.id ? { ...message, content: message.content + chunk } : message));
      }
    } catch (caughtError) {
      const error = caughtError instanceof Error ? caughtError.message : "Something went wrong.";
      updateMessages(conversationId, (current) => current.map((message) => message.id === assistantMessage.id ? { ...message, content: `Sorry, ${error}` } : message));
    } finally { setIsLoading(false); }
  }

  function updateTaskSpec(conversationId: string, messageId: string, taskSpec: TaskSpec) {
    updateMessages(conversationId, (current) => current.map((message) => message.id === messageId ? { ...message, taskSpec } : message));
  }

  async function createTaskDraft(conversationId: string, messageId: string, taskSpec: TaskSpec) {
    if (isLoading || creatingDraftMessageId) return;
    setCreatingDraftMessageId(messageId);
    try {
      const response = await fetch("/api/task-draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskSpec }) });
      const payload = await response.json() as { draft?: TaskDraft; error?: string };
      if (!response.ok || !payload.draft) throw new Error(payload.error || "The draft task could not be created.");
      updateMessages(conversationId, (current) => current.map((message) => message.id === messageId ? { ...message, taskDraft: payload.draft } : message));
    } catch (caughtError) {
      window.alert(caughtError instanceof Error ? caughtError.message : "The draft task could not be created.");
    } finally {
      setCreatingDraftMessageId(null);
    }
  }

  function openDraft(draft: DraftListItem) {
    setActiveConversationId(draft.conversationId);
    setMenuConversationId(null);
    window.setTimeout(() => {
      const target = document.getElementById(`message-${draft.messageId}`);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      target?.focus({ preventScroll: true });
    }, 0);
  }

  async function copyDraft(draft: TaskDraft) {
    const spec = draft.taskSpec;
    const text = [`# ${spec.title}`, "", spec.summary, "", `Priority: ${spec.priority}`, "", "## Acceptance criteria", ...spec.acceptanceCriteria.map((criterion) => `- ${criterion}`), "", "## Implementation notes", ...spec.implementationNotes.map((note) => `- ${note}`)].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopiedDraftId(draft.id);
      window.setTimeout(() => setCopiedDraftId((current) => current === draft.id ? null : current), 2_000);
    } catch {
      window.alert("The draft could not be copied. Check browser clipboard permissions and try again.");
    }
  }

  function deleteDraft(draft: DraftListItem) {
    if (!window.confirm(`Delete the draft “${draft.draft.taskSpec.title}”? The editable spec will remain.`)) return;
    updateMessages(draft.conversationId, (current) => current.map((message) => {
      if (message.id !== draft.messageId) return message;
      const { taskDraft, ...rest } = message;
      return taskDraft ? rest : message;
    }));
  }

  async function createTaskSpec() {
    const request = input.trim();
    const image = selectedImage;
    if ((!request && !image) || isLoading) return;

    const userMessageContent = image ? [`Screenshot: ${image.name}`, request].filter(Boolean).join("\n\n") : request;
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content: userMessageContent };
    const assistantMessage: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: "", pendingLabel: image ? "Analyzing screenshot" : "Creating task spec" };
    const existingMessages = activeConversation?.messages ?? [];
    const conversationId = activeConversation?.id ?? crypto.randomUUID();

    if (activeConversation) {
      updateMessages(conversationId, () => [...existingMessages, userMessage, assistantMessage]);
    } else {
      const title = request || `Analyze ${image!.name}`;
      setConversations((current) => [{ id: conversationId, title: title.length > 42 ? `${title.slice(0, 42)}…` : title, updatedAt: Date.now(), messages: [...existingMessages, userMessage, assistantMessage] }, ...current]);
      setActiveConversationId(conversationId);
    }
    setInput("");
    clearSelectedImage();
    setIsLoading(true);

    try {
      const response = image
        ? await fetch("/api/task-spec", { method: "POST", body: (() => { const formData = new FormData(); formData.set("request", request); formData.set("image", image); return formData; })() })
        : await fetch("/api/task-spec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request }) });
      const payload = await response.json() as { taskSpec?: TaskSpec; error?: string };
      if (!response.ok || !payload.taskSpec) throw new Error(payload.error || "The task specification could not be created.");
      updateMessages(conversationId, (current) => current.map((message) => message.id === assistantMessage.id ? { ...message, pendingLabel: undefined, taskSpec: payload.taskSpec } : message));
    } catch (caughtError) {
      const error = caughtError instanceof Error ? caughtError.message : "Something went wrong.";
      setInput(request);
      if (image) setSelectedImage(image);
      window.setTimeout(() => inputRef.current?.focus(), 0);
      updateMessages(conversationId, (current) => current.map((message) => message.id === assistantMessage.id ? { ...message, pendingLabel: undefined, content: `Sorry, ${error}` } : message));
    } finally { setIsLoading(false); }
  }

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Conversation history">
        <div className="sidebar-top">
          <div className="brand"><span className="brand-mark">✦</span> Gemini Lab</div>
          <button className="new-chat-button" type="button" onClick={startNewChat} disabled={isLoading}><span>＋</span> New chat</button>
        </div>
        <nav className="conversation-list" aria-label="Saved conversations">
          <p className="sidebar-label">Recent</p>
          {conversations.length === 0 ? <p className="empty-history">Your chats will appear here.</p> : conversations.map((conversation) => (
            <div className={`conversation-row ${conversation.id === activeConversationId ? "active" : ""}`} key={conversation.id}>
              <button className="conversation-button" type="button" onClick={() => { setActiveConversationId(conversation.id); setMenuConversationId(null); }} disabled={isLoading}><ConversationTitle title={conversation.title} /><small>{formatDate(conversation.updatedAt)}</small></button>
              <div className="conversation-actions"><button className="conversation-more" type="button" onClick={() => setMenuConversationId((current) => current === conversation.id ? null : conversation.id)} aria-label={`More options for ${conversation.title}`} aria-expanded={menuConversationId === conversation.id} disabled={isLoading}>⋯</button>{menuConversationId === conversation.id && <div className="conversation-menu"><button type="button" onClick={() => deleteConversation(conversation.id)}>Delete chat</button></div>}</div>
            </div>
          ))}
        </nav>
        <section className="drafts-panel" aria-labelledby="drafts-heading">
          <div className="drafts-panel-heading"><p id="drafts-heading">Draft tasks</p><span>{drafts.length}</span></div>
          {drafts.length === 0 ? <p className="empty-drafts">Approved task drafts will appear here.</p> : <ul className="draft-list">{drafts.map((draft) => <li key={draft.draft.id}><div className="draft-summary" title={draft.draft.taskSpec.title}><span>{draft.draft.taskSpec.title}</span><small>{draft.draft.taskSpec.priority} priority</small></div><div className="draft-controls"><button type="button" onClick={() => openDraft(draft)} aria-label={`Open ${draft.draft.taskSpec.title}`}>Open</button><button type="button" onClick={() => copyDraft(draft.draft)} aria-label={`Copy ${draft.draft.taskSpec.title}`}>{copiedDraftId === draft.draft.id ? "Copied" : "Copy"}</button><button className="draft-delete" type="button" onClick={() => deleteDraft(draft)} aria-label={`Delete ${draft.draft.taskSpec.title}`}>Delete</button></div></li>)}</ul>}
        </section>
        <p className="sidebar-note">Stored only in this browser</p>
      </aside>

      <section className="chat-panel">
        <header className="topbar">
          <div className="chat-heading"><details className="learning-status"><summary>WEEK 4 · VISION INPUT <span className="status-chevron" aria-hidden="true" /></summary><div className="learning-log"><p><strong>Week 1</strong><span>Streaming chat, history, deployment</span></p><p><strong>Week 2</strong><span>JSON schema, Zod validation, editable specs</span></p><p><strong>Week 3</strong><span>Tool calling, approval, local draft workflow</span></p><p className="current"><strong>Week 4</strong><span>Screenshot intake, vision analysis, upload states</span></p></div></details><h1>{activeConversation?.title ?? "New conversation"}</h1></div>
          <span className="model-pill"><span className="status-dot" /> Gemini 3.5 Flash Lite</span>
        </header>
        <section className="thread" aria-live="polite" aria-label="Chat messages">
          {messages.length === 0 ? (
            <div className="welcome"><span className="welcome-mark">✦</span><h2>How can I help you learn today?</h2><p>Chat with Gemini, create editable task specs, or attach a product screenshot to turn visible feedback into a reviewed draft workflow.</p><button type="button" className="prompt-chip" onClick={() => setInput("Explain streaming AI responses in a Next.js app using four short sections.")}>Explain streaming responses</button></div>
          ) : messages.map((message) => (
            <article className={`message ${message.role}`} id={`message-${message.id}`} tabIndex={message.taskDraft ? -1 : undefined} key={message.id}><div className="avatar">{message.role === "user" ? "T" : "✦"}</div><div className="message-body"><p className="message-role">{message.role === "user" ? "You" : "Gemini"}</p>{message.taskSpec ? <TaskSpecCard spec={message.taskSpec} draft={message.taskDraft} isCreatingDraft={creatingDraftMessageId === message.id} onChange={(taskSpec) => updateTaskSpec(activeConversation!.id, message.id, taskSpec)} onCreateDraft={() => createTaskDraft(activeConversation!.id, message.id, message.taskSpec!)} /> : message.studyPlan ? <StudyPlanCard plan={message.studyPlan} /> : message.content ? <MarkdownMessage content={message.content} /> : <p>{isLoading ? <span className="typing">{message.pendingLabel ?? "Thinking"}<span>…</span></span> : "No response received."}</p>}</div></article>
          ))}
          <div ref={threadEndRef} />
        </section>
        <form className="composer" onSubmit={handleSubmit}>
          {selectedImage && imagePreviewUrl && <div className="attachment-preview" aria-live="polite"><Image className="attachment-thumbnail" src={imagePreviewUrl} alt={`Preview of ${selectedImage.name}`} width={48} height={48} unoptimized /><span><strong>{selectedImage.name}</strong><small>{(selectedImage.size / 1024 / 1024).toFixed(1)} MB · ready to analyze</small></span><button type="button" onClick={clearSelectedImage} aria-label={`Remove ${selectedImage.name}`}>×</button></div>}
          {attachmentError && <p className="attachment-error" role="alert">{attachmentError}</p>}
          <label className="sr-only" htmlFor="prompt">Message</label>
          <textarea ref={inputRef} id="prompt" value={input} onChange={(event) => setInput(event.target.value)} onPaste={pasteImage} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={selectedImage ? "Add optional context for this screenshot…" : isSpecMode ? "Describe a feature to turn into a task spec…" : "Message Gemini…"} rows={1} disabled={isLoading} />
          <div className="composer-actions"><input ref={imageInputRef} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => selectImage(event.target.files?.[0])} disabled={isLoading} /><button className="attach-button" type="button" onClick={() => imageInputRef.current?.click()} disabled={isLoading} aria-label="Attach product screenshot" title="Attach product screenshot">＋</button><button className={`plan-button ${isSpecMode ? "active" : ""}`} type="button" onClick={toggleSpecMode} disabled={isLoading} aria-pressed={isSpecMode} title="Toggle editable task specification mode">Spec</button><button className="send-button" type="submit" disabled={isLoading || (!input.trim() && !selectedImage)} aria-label={isSpecMode ? "Create task specification" : "Send message"}>↑</button></div>
        </form>
        <p className="disclaimer">Gemini can make mistakes. Do not enter sensitive information while using the free API tier.</p>
      </section>
    </main>
  );
}
