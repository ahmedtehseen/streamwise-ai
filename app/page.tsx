"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

type ChatMessage = { id: string; role: "user" | "assistant"; content: string };
type Conversation = { id: string; title: string; updatedAt: number; messages: ChatMessage[] };
const STORAGE_KEY = "week-one-ai-chat-conversations";

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp);
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

export default function Home() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [hasHydrated, setHasHydrated] = useState(false);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const activeConversation = useMemo(() => conversations.find((c) => c.id === activeConversationId) ?? null, [activeConversationId, conversations]);
  const messages = activeConversation?.messages ?? [];

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) { const parsed = JSON.parse(saved) as Conversation[]; if (Array.isArray(parsed)) setConversations(parsed); }
    } catch { /* Ignore malformed local storage. */ } finally { setHasHydrated(true); }
  }, []);

  useEffect(() => { if (hasHydrated) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations)); }, [conversations, hasHydrated]);
  useEffect(() => { threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages, isLoading]);

  function startNewChat() {
    if (isLoading) return;
    setActiveConversationId(null);
    setInput("");
    window.setTimeout(() => inputRef.current?.focus(), 0);
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
    if (conversationId === activeConversationId) startNewChat();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
              <button className="conversation-button" type="button" onClick={() => setActiveConversationId(conversation.id)} disabled={isLoading}><span>{conversation.title}</span><small>{formatDate(conversation.updatedAt)}</small></button>
              <button className="delete-button" type="button" onClick={() => deleteConversation(conversation.id)} aria-label={`Delete ${conversation.title}`} disabled={isLoading}>×</button>
            </div>
          ))}
        </nav>
        <p className="sidebar-note">Stored only in this browser</p>
      </aside>

      <section className="chat-panel">
        <header className="topbar">
          <div><p className="eyebrow">WEEK 1 · AI INTEGRATION</p><h1>{activeConversation?.title ?? "New conversation"}</h1></div>
          <span className="model-pill"><span className="status-dot" /> Gemini 3.5 Flash Lite</span>
        </header>
        <section className="thread" aria-live="polite" aria-label="Chat messages">
          {messages.length === 0 ? (
            <div className="welcome"><span className="welcome-mark">✦</span><h2>How can I help you learn today?</h2><p>This is a real streaming conversation. Ask a question, then follow up and Gemini receives the earlier messages as context.</p><button type="button" className="prompt-chip" onClick={() => setInput("Explain streaming AI responses in a Next.js app using four short sections.")}>Explain streaming responses</button></div>
          ) : messages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}><div className="avatar">{message.role === "user" ? "T" : "✦"}</div><div className="message-body"><p className="message-role">{message.role === "user" ? "You" : "Gemini"}</p>{message.content ? <MarkdownMessage content={message.content} /> : <p>{isLoading ? <span className="typing">Thinking<span>…</span></span> : "No response received."}</p>}</div></article>
          ))}
          <div ref={threadEndRef} />
        </section>
        <form className="composer" onSubmit={handleSubmit}>
          <label className="sr-only" htmlFor="prompt">Message</label>
          <textarea ref={inputRef} id="prompt" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="Message Gemini…" rows={1} disabled={isLoading} />
          <button className="send-button" type="submit" disabled={isLoading || !input.trim()} aria-label="Send message">↑</button>
        </form>
        <p className="disclaimer">Gemini can make mistakes. Do not enter sensitive information while using the free API tier.</p>
      </section>
    </main>
  );
}
