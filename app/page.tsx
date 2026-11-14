"use client";

import { type ClipboardEvent as ReactClipboardEvent, FormEvent, type KeyboardEvent as ReactKeyboardEvent, type Ref, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { isSupportedImageType, MAX_IMAGE_BYTES } from "../lib/image-upload";
import KnowledgePanel from "./knowledge-panel";
import ThemeToggle from "./theme-toggle";

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
type ChatMessage = { id: string; role: "user" | "assistant"; content: string; imageName?: string; pendingLabel?: string; studyPlan?: LegacyStudyPlan; taskSpec?: TaskSpec; taskDraft?: TaskDraft };
type Conversation = { id: string; title: string; updatedAt: number; messages: ChatMessage[] };
type DraftListItem = { conversationId: string; messageId: string; draft: TaskDraft };
const STORAGE_KEY = "week-one-ai-chat-conversations";

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp);
}

async function responseError(response: Response, fallback: string) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const payload = await response.json().catch(() => null) as { error?: unknown } | null;
    if (typeof payload?.error === "string") return payload.error;
  } else {
    const message = await response.text().catch(() => "");
    if (message) return message;
  }
  return fallback;
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

const markdownComponents: Components = {
  a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
  pre: ({ children }) => <pre tabIndex={0} role="region" aria-label="Code example">{children}</pre>
};

function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={markdownComponents}
      >
        {content}
      </Markdown>
    </div>
  );
}

function UserImageMessage({ name, previewUrl, content }: { name: string; previewUrl?: string; content: string }) {
  return (
    <div className="user-image-message">
      {previewUrl ? <div className="user-image-preview"><Image src={previewUrl} alt={`Submitted image ${name}`} fill sizes="(max-width: 700px) 80vw, 420px" unoptimized /></div> : <div className="user-image-fallback"><span aria-hidden="true">▧</span><span>Image: {name}. Reattach it to discuss it after reloading.</span></div>}
      {content && <MarkdownMessage content={content} />}
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
        ? { ...message, content: "Sorry, Streamwise is temporarily busy. Please try again in a moment." }
        : message
    )
  }));
}

function StudyPlanCard({ plan }: { plan: LegacyStudyPlan }) {
  return (
    <section className="study-plan" aria-label="Structured study plan">
      <div className="plan-heading"><span>Structured plan</span><strong>{plan.estimatedMinutes} min</strong></div>
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
      <div className="spec-heading"><h2>Structured task spec</h2>{draft ? <span className="spec-priority">{spec.priority} priority</span> : <select value={spec.priority} onChange={(event) => onChange({ ...spec, priority: event.target.value as TaskSpec["priority"] })} aria-label="Task priority"><option value="low">Low priority</option><option value="medium">Medium priority</option><option value="high">High priority</option></select>}</div>
      {draft ? <h2 className="spec-title">{spec.title}</h2> : <input className="spec-title" value={spec.title} onChange={(event) => onChange({ ...spec, title: event.target.value })} aria-label="Task title" />}
      {draft ? <p className="spec-summary">{spec.summary}</p> : <textarea className="spec-summary" value={spec.summary} onChange={(event) => onChange({ ...spec, summary: event.target.value })} aria-label="Task summary" rows={2} />}
      <div className="spec-section"><h3>Acceptance criteria</h3><ul>{spec.acceptanceCriteria.map((criterion, index) => <li key={index}>{draft ? <span className="spec-static-field">{criterion}</span> : <textarea value={criterion} onChange={(event) => { const acceptanceCriteria = [...spec.acceptanceCriteria]; acceptanceCriteria[index] = event.target.value; onChange({ ...spec, acceptanceCriteria }); }} aria-label={`Acceptance criterion ${index + 1}`} rows={1} />}</li>)}</ul></div>
      <div className="spec-section"><h3>Implementation notes</h3><ul>{spec.implementationNotes.map((note, index) => <li key={index}>{draft ? <span className="spec-static-field">{note}</span> : <textarea value={note} onChange={(event) => { const implementationNotes = [...spec.implementationNotes]; implementationNotes[index] = event.target.value; onChange({ ...spec, implementationNotes }); }} aria-label={`Implementation note ${index + 1}`} rows={1} />}</li>)}</ul></div>
      {draft ? <div className="draft-receipt"><strong>Draft created</strong><span>#{draft.id.slice(0, 8)} · saved only in this browser</span></div> : <div className="draft-action"><p>Review the editable spec. Creating a draft is the approval step; nothing is published.</p><button type="button" onClick={onCreateDraft} disabled={isCreatingDraft}>{isCreatingDraft ? "Creating draft…" : "Create draft task"}</button></div>}
    </section>
  );
}

type ApplicationMode = "chat" | "spec" | "knowledge";

function SidebarHeader({ isLoading, isMenuOpen, onNewChat, onToggleMenu, menuButtonRef }: {
  isLoading: boolean;
  isMenuOpen: boolean;
  onNewChat: () => void;
  onToggleMenu: () => void;
  menuButtonRef: Ref<HTMLButtonElement>;
}) {
  return (
    <div className="sidebar-top">
      <div className="brand"><span className="brand-glyph" aria-hidden="true" /> Streamwise</div>
      <button className="new-chat-button" type="button" onClick={onNewChat} disabled={isLoading}><span>＋</span> New chat</button>
      <button ref={menuButtonRef} className="mobile-menu-button" type="button" aria-expanded={isMenuOpen} aria-controls="saved-work-navigation" onClick={onToggleMenu}>{isMenuOpen ? "Close" : "Menu"}</button>
    </div>
  );
}

export default function Home() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<ApplicationMode>("chat");
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [messageImageUrls, setMessageImageUrls] = useState<Record<string, string>>({});
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [menuConversationId, setMenuConversationId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [creatingDraftMessageId, setCreatingDraftMessageId] = useState<string | null>(null);
  const [copiedDraftId, setCopiedDraftId] = useState<string | null>(null);
  const [hasHydrated, setHasHydrated] = useState(false);
  const [hasStorageError, setHasStorageError] = useState(false);
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [isMobileNavClosing, setIsMobileNavClosing] = useState(false);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileDrawerButtonRef = useRef<HTMLButtonElement>(null);
  const messageImageUrlsRef = useRef(messageImageUrls);
  const messageImagesRef = useRef<Record<string, File>>({});
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

  useEffect(() => {
    if (!hasHydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
      setHasStorageError(false);
    } catch {
      setHasStorageError(true);
    }
  }, [conversations, hasHydrated]);
  useEffect(() => {
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";
    threadEndRef.current?.scrollIntoView({ behavior, block: "end" });
  }, [messageCount, isLoading]);
  useEffect(() => { messageImageUrlsRef.current = messageImageUrls; }, [messageImageUrls]);
  useEffect(() => () => { Object.values(messageImageUrlsRef.current).forEach((url) => URL.revokeObjectURL(url)); }, []);
  useEffect(() => {
    if (isMobileNavOpen) mobileDrawerButtonRef.current?.focus();
  }, [isMobileNavOpen]);

  function startNewChat() {
    if (isLoading) return;
    finishMobileNavigation();
    if (mode === "knowledge") setMode("chat");
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
      return setAttachmentError("Use a PNG, JPEG, or WebP image.");
    }
    if (file.size === 0 || file.size > MAX_IMAGE_BYTES) {
      clearSelectedImage();
      return setAttachmentError("Choose a nonempty image under 5 MB.");
    }
    setSelectedImage(file);
  }

  function pasteImage(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const image = Array.from(event.clipboardData.files).find((file) => file.type.startsWith("image/"))
      ?? Array.from(event.clipboardData.items).find((item) => item.kind === "file" && item.type.startsWith("image/"))?.getAsFile()
      ?? undefined;
    if (!image) return;
    event.preventDefault();
    selectImage(image);
  }

  function selectMode(nextMode: ApplicationMode) {
    if (isLoading) return;
    if (nextMode === "knowledge" && selectedImage) {
      const shouldDiscard = window.confirm("Switch modes and remove the attached screenshot?");
      if (!shouldDiscard) return;
      clearSelectedImage();
    }
    setMode(nextMode);
  }

  function closeMobileNavigation() {
    finishMobileNavigation();
    requestAnimationFrame(() => mobileMenuButtonRef.current?.focus());
  }

  function toggleMobileNavigation() {
    if (isMobileNavOpen) {
      closeMobileNavigation();
      return;
    }
    setIsMobileNavClosing(false);
    setIsMobileNavOpen(true);
  }

  function finishMobileNavigation() {
    setIsMobileNavOpen(false);
    if (!window.matchMedia("(max-width: 900px)").matches || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setIsMobileNavClosing(false);
      return;
    }
    setIsMobileNavClosing(true);
    window.setTimeout(() => setIsMobileNavClosing(false), 240);
  }

  function handleMobileNavigationKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (!isMobileNavOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeMobileNavigation();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    ) ?? []).filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
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

  function removeMessageImageUrls(messageIds: string[]) {
    setMessageImageUrls((current) => {
      const next = { ...current };
      messageIds.forEach((messageId) => {
        delete messageImagesRef.current[messageId];
        if (!next[messageId]) return;
        URL.revokeObjectURL(next[messageId]);
        delete next[messageId];
      });
      return next;
    });
  }

  function deleteConversation(conversationId: string) {
    if (isLoading) return;
    const conversation = conversations.find((item) => item.id === conversationId);
    if (conversation) removeMessageImageUrls(conversation.messages.map((message) => message.id));
    setConversations((current) => current.filter((conversation) => conversation.id !== conversationId));
    setMenuConversationId(null);
    if (conversationId === activeConversationId) startNewChat();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === "spec") return createTaskSpec();
    const text = input.trim();
    const image = selectedImage;
    if ((!text && !image) || isLoading) return;

    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content: text, imageName: image?.name };
    const assistantMessage: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: "" };
    const existingMessages = activeConversation?.messages ?? [];
    const messagesForRequest = [...existingMessages, userMessage];
    const conversationId = activeConversation?.id ?? crypto.randomUUID();

    if (activeConversation) {
      updateMessages(conversationId, () => [...messagesForRequest, assistantMessage]);
    } else {
      const title = text || `Discuss ${image!.name}`;
      const newConversation: Conversation = { id: conversationId, title: title.length > 42 ? `${title.slice(0, 42)}…` : title, updatedAt: Date.now(), messages: [...messagesForRequest, assistantMessage] };
      setConversations((current) => [newConversation, ...current]);
      setActiveConversationId(conversationId);
    }
    if (image) {
      messageImagesRef.current[userMessage.id] = image;
      setMessageImageUrls((current) => ({ ...current, [userMessage.id]: URL.createObjectURL(image) }));
    }
    setInput("");
    clearSelectedImage();
    setIsLoading(true);

    try {
      const formData = new FormData();
      const requestMessages = messagesForRequest.slice(-20).map(({ id, role, content, imageName }) => {
        const attachment = role === "user" ? messageImagesRef.current[id] : undefined;
        if (attachment) formData.set(`image-${id}`, attachment);
        return {
          role,
          content: imageName && !attachment ? `${content}\n[Image ${imageName} is unavailable. Ask the user to reattach it if needed.]` : content,
          ...(attachment ? { image: `image-${id}` } : {})
        };
      });
      formData.set("messages", JSON.stringify(requestMessages));
      const response = await fetch("/api/chat", { method: "POST", body: formData });
      if (!response.ok || !response.body) throw new Error(await responseError(response, "The AI request could not be started."));
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
      setInput(text);
      if (image) setSelectedImage(image);
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
    finishMobileNavigation();
    setMode("spec");
    setActiveConversationId(draft.conversationId);
    setMenuConversationId(null);
    window.setTimeout(() => {
      const target = document.getElementById(`message-${draft.messageId}`);
      const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";
      target?.scrollIntoView({ behavior, block: "center" });
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

    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content: request, imageName: image?.name };
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
    if (image) {
      messageImagesRef.current[userMessage.id] = image;
      setMessageImageUrls((current) => ({ ...current, [userMessage.id]: URL.createObjectURL(image) }));
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
      <div className="mobile-header" inert={isMobileNavOpen}>
        <SidebarHeader isLoading={isLoading} isMenuOpen={false} onNewChat={startNewChat} onToggleMenu={toggleMobileNavigation} menuButtonRef={mobileMenuButtonRef} />
      </div>
      <div ref={sidebarRef} className={`sidebar ${isMobileNavOpen || isMobileNavClosing ? "mobile-open" : ""} ${isMobileNavClosing ? "mobile-closing" : ""}`} aria-label="Conversation history" role={isMobileNavOpen ? "dialog" : "complementary"} aria-modal={isMobileNavOpen ? true : undefined} inert={isMobileNavClosing} onKeyDown={handleMobileNavigationKeyDown}>
        <SidebarHeader isLoading={isLoading} isMenuOpen={isMobileNavOpen} onNewChat={startNewChat} onToggleMenu={toggleMobileNavigation} menuButtonRef={mobileDrawerButtonRef} />
        <nav id="saved-work-navigation" className="conversation-list" aria-label="Saved conversations">
          <p className="sidebar-label">Recent</p>
          {!hasHydrated ? <p className="empty-history">Loading saved conversations…</p> : conversations.length === 0 ? <p className="empty-history">Your chats will appear here.</p> : conversations.map((conversation) => (
            <div className={`conversation-row ${conversation.id === activeConversationId ? "active" : ""}`} key={conversation.id}>
              <button className="conversation-button" type="button" onClick={() => {
                setActiveConversationId(conversation.id);
                if (mode === "knowledge") {
                  setMode(conversation.messages.some((message) => message.taskSpec) ? "spec" : "chat");
                }
                setMenuConversationId(null);
                finishMobileNavigation();
              }} disabled={isLoading}><ConversationTitle title={conversation.title} /><small>{formatDate(conversation.updatedAt)}</small></button>
              <div className="conversation-actions"><button className="conversation-more" type="button" onClick={() => setMenuConversationId((current) => current === conversation.id ? null : conversation.id)} aria-label={`More options for ${conversation.title}`} aria-expanded={menuConversationId === conversation.id} disabled={isLoading}>⋯</button>{menuConversationId === conversation.id && <div className="conversation-menu"><button type="button" onClick={() => deleteConversation(conversation.id)}>Delete chat</button></div>}</div>
            </div>
          ))}
        </nav>
        <section className="drafts-panel" aria-labelledby="drafts-heading">
          <div className="drafts-panel-heading"><p id="drafts-heading">Draft tasks</p><span>{hasHydrated ? drafts.length : "…"}</span></div>
          {!hasHydrated ? <p className="empty-drafts">Loading saved drafts…</p> : drafts.length === 0 ? <p className="empty-drafts">Approved task drafts will appear here.</p> : <ul className="draft-list">{drafts.map((draft) => <li key={draft.draft.id}><div className="draft-summary" title={draft.draft.taskSpec.title}><span>{draft.draft.taskSpec.title}</span><small>{draft.draft.taskSpec.priority} priority</small></div><div className="draft-controls"><button type="button" onClick={() => openDraft(draft)} aria-label={`Open ${draft.draft.taskSpec.title}`}>Open</button><button type="button" onClick={() => copyDraft(draft.draft)} aria-label={`Copy ${draft.draft.taskSpec.title}`}>{copiedDraftId === draft.draft.id ? "Copied" : "Copy"}</button><button className="draft-delete" type="button" onClick={() => deleteDraft(draft)} aria-label={`Delete ${draft.draft.taskSpec.title}`}>Delete</button></div></li>)}</ul>}
        </section>
        <p className="sidebar-note">Stored only in this browser</p>
      </div>

      <section className="chat-panel" inert={isMobileNavOpen}>
        <header className="topbar">
          <div className="chat-heading"><h1>{mode === "knowledge" ? "Portfolio Assistant" : activeConversation?.title ?? (mode === "spec" ? "New task spec" : "New conversation")}</h1></div>
          <div className="header-tools">
            <nav className="mode-switch" aria-label="Application mode"><button type="button" className={mode === "chat" ? "active" : ""} onClick={() => selectMode("chat")} aria-pressed={mode === "chat"}>Chat</button><button type="button" className={mode === "spec" ? "active" : ""} onClick={() => selectMode("spec")} aria-pressed={mode === "spec"}>Spec</button><button type="button" className={mode === "knowledge" ? "active" : ""} onClick={() => selectMode("knowledge")} aria-pressed={mode === "knowledge"}>Portfolio Assistant</button></nav>
            <ThemeToggle />
          </div>
        </header>
        {hasStorageError && <p className="storage-notice" role="status">Conversation saving is unavailable. Keep this page open to retain your current messages.</p>}
        {mode === "knowledge" ? <KnowledgePanel /> : <>
        <section className="thread" aria-live="polite" aria-label="Chat messages">
          {messages.length === 0 ? (
            mode === "spec" ? <div className="welcome"><span className="brand-glyph welcome-mark" aria-hidden="true" /><h2>Turn an idea into a task spec</h2><p>Describe a feature or attach a product screenshot, then review the generated criteria before saving a draft.</p><button type="button" className="prompt-chip" onClick={() => setInput("Add a mobile navigation menu with accessible keyboard controls.")}>Try an example feature</button></div> : <div className="welcome"><span className="brand-glyph welcome-mark" aria-hidden="true" /><h2>How can I help you learn today?</h2><p>Ask Streamwise a question and follow up as you learn. Your conversations stay in this browser.</p><button type="button" className="prompt-chip" onClick={() => setInput("Explain streaming AI responses in a Next.js app using four short sections.")}>Explain streaming responses</button></div>
          ) : messages.map((message) => (
            <article className={`message ${message.role}`} id={`message-${message.id}`} tabIndex={message.taskDraft ? -1 : undefined} key={message.id}><div className="avatar">{message.role === "user" ? "T" : <span className="brand-glyph" aria-hidden="true" />}</div><div className="message-body"><p className="message-role">{message.role === "user" ? "You" : "Streamwise"}</p>{message.imageName ? <UserImageMessage name={message.imageName} previewUrl={messageImageUrls[message.id]} content={message.content} /> : message.taskSpec ? <TaskSpecCard spec={message.taskSpec} draft={message.taskDraft} isCreatingDraft={creatingDraftMessageId === message.id} onChange={(taskSpec) => updateTaskSpec(activeConversation!.id, message.id, taskSpec)} onCreateDraft={() => createTaskDraft(activeConversation!.id, message.id, message.taskSpec!)} /> : message.studyPlan ? <StudyPlanCard plan={message.studyPlan} /> : message.content ? <MarkdownMessage content={message.content} /> : <p>{isLoading ? <span className="typing">{message.pendingLabel ?? "Thinking"}<span>…</span></span> : "No response received."}</p>}</div></article>
          ))}
          <div ref={threadEndRef} />
        </section>
        <form className="composer" onSubmit={handleSubmit}>
          {selectedImage && imagePreviewUrl && <div className="attachment-preview" aria-live="polite"><Image className="attachment-thumbnail" src={imagePreviewUrl} alt={`Preview of ${selectedImage.name}`} width={48} height={48} unoptimized /><span><strong>{selectedImage.name}</strong><small>{(selectedImage.size / 1024 / 1024).toFixed(1)} MB · ready to analyze</small></span><button type="button" onClick={clearSelectedImage} aria-label={`Remove ${selectedImage.name}`}>×</button></div>}
          {attachmentError && <p className="attachment-error" role="alert">{attachmentError}</p>}
          <label className="sr-only" htmlFor="prompt">Message</label>
          <textarea ref={inputRef} id="prompt" value={input} onChange={(event) => setInput(event.target.value)} onPaste={pasteImage} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={selectedImage ? mode === "spec" ? "Add context for this screenshot…" : "Ask about this image…" : mode === "spec" ? "Describe a feature…" : "Message Streamwise…"} rows={1} disabled={isLoading} />
          <div className="composer-actions"><input ref={imageInputRef} hidden tabIndex={-1} aria-label={mode === "spec" ? "Product screenshot" : "Image attachment"} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => selectImage(event.target.files?.[0])} disabled={isLoading} /><button className="attach-button" type="button" onClick={() => imageInputRef.current?.click()} disabled={isLoading} aria-label={mode === "spec" ? "Attach product screenshot" : "Attach image"} title={mode === "spec" ? "Attach product screenshot" : "Attach image"}>＋</button><button className="send-button" type="submit" disabled={isLoading || (!input.trim() && !selectedImage)} aria-label={mode === "spec" ? "Create task specification" : "Send message"}>↑</button></div>
        </form>
        <p className="disclaimer">AI can make mistakes. Avoid entering sensitive information.</p>
        </>}
      </section>
    </main>
  );
}
