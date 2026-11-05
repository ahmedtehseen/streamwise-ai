"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";

type ProjectDocument = {
  id: string;
  name: string;
  mediaType: string;
  byteSize: number;
  status: "indexing" | "ready" | "failed";
  failureDetail: string | null;
  retryable: boolean;
  createdAt: string;
  updatedAt: string;
  replacement?: ProjectDocument;
};

type SourceReference = {
  id: string;
  documentName: string;
  headingPath: string[];
  startLine: number;
  endLine: number;
  excerpt: string;
};

type GroundedAnswer = {
  outcome: "answered";
  paragraphs: Array<{ text: string; sourceReferences: SourceReference[] }>;
} | {
  outcome: "insufficient_evidence";
  paragraphs: [];
};

type KnowledgeResponse = GroundedAnswer & {
  degradedSearch?: boolean;
  responseId: string;
  respondedAt: string;
};

type AnswerFlag = {
  id: string;
  question: string;
  outcome: "answered" | "insufficient_evidence";
  responseContent: { paragraphs: Array<{ text: string; sourceReferences: SourceReference[] }>; degradedSearch: boolean };
  sourceReferences: SourceReference[];
  respondedAt: string;
  note: string | null;
  status: "open" | "reviewed";
  reviewedAt: string | null;
  createdAt: string;
};

export default function KnowledgePanel() {
  const [documents, setDocuments] = useState<ProjectDocument[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [question, setQuestion] = useState("");
  const [isAsking, setIsAsking] = useState(false);
  const [answer, setAnswer] = useState<KnowledgeResponse | null>(null);
  const [selectedSource, setSelectedSource] = useState<SourceReference | null>(null);
  const [deletingDocumentIds, setDeletingDocumentIds] = useState<string[]>([]);
  const [retryingDocumentId, setRetryingDocumentId] = useState<string | null>(null);
  const [replacingDocumentId, setReplacingDocumentId] = useState<string | null>(null);
  const [discardingReplacementId, setDiscardingReplacementId] = useState<string | null>(null);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [questionError, setQuestionError] = useState<string | null>(null);
  const [isDocumentDrawerOpen, setIsDocumentDrawerOpen] = useState(false);
  const [selectedUploadName, setSelectedUploadName] = useState<string | null>(null);
  const [askingStep, setAskingStep] = useState<string | null>(null);
  const [adminKey, setAdminKey] = useState("");
  const [flagNote, setFlagNote] = useState("");
  const [flagState, setFlagState] = useState<"idle" | "submitting" | "submitted">("idle");
  const [flagError, setFlagError] = useState<string | null>(null);
  const [answerFlags, setAnswerFlags] = useState<AnswerFlag[]>([]);
  const [isLoadingFlags, setIsLoadingFlags] = useState(false);
  const [flagsLoaded, setFlagsLoaded] = useState(false);
  const [flagReviewError, setFlagReviewError] = useState<string | null>(null);
  const [reviewingFlagId, setReviewingFlagId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const drawerTriggerRef = useRef<HTMLButtonElement>(null);
  const hasReadyDocument = documents.some((document) => document.status === "ready");

  const samplePrompts = [
    "What are your core technical skills and architecture experience?",
    "Tell me about a challenging project and how you solved it.",
    "What is your experience with performance optimization and databases?"
  ];

  function formatMediaType(type: string): string {
    switch (type) {
      case "application/pdf": return "PDF";
      case "text/markdown": return "Markdown";
      case "text/html": return "HTML";
      case "application/json": return "JSON";
      case "text/csv": return "CSV";
      default: return "Plain text";
    }
  }

  useEffect(() => {
    const savedKey = sessionStorage.getItem("portfolio_admin_key");
    if (savedKey) setAdminKey(savedKey);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function loadDocuments() {
      try {
        const response = await fetch("/api/knowledge/documents", { signal: controller.signal });
        const payload = await response.json() as { documents?: ProjectDocument[]; error?: string };
        if (!response.ok || !payload.documents) throw new Error(payload.error || "The Knowledge Base could not be loaded.");
        setDocuments(payload.documents);
      } catch (caughtError) {
        if (!controller.signal.aborted) setDocumentError(caughtError instanceof Error ? caughtError.message : "The Knowledge Base could not be loaded.");
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }
    loadDocuments();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!isDocumentDrawerOpen) return;
    drawerCloseRef.current?.focus();
  }, [isDocumentDrawerOpen]);

  function closeDocumentDrawer() {
    setIsDocumentDrawerOpen(false);
    requestAnimationFrame(() => drawerTriggerRef.current?.focus());
  }

  function handleDrawerKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDocumentDrawer();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    ) ?? []);
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

  async function uploadDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = inputRef.current?.files?.[0];
    if (!file || isUploading) return;
    const pendingId = `indexing-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    setDocumentError(null);
    setIsUploading(true);
    setDocuments((current) => [{ id: pendingId, name: file.name, mediaType: file.type, byteSize: file.size, status: "indexing", failureDetail: null, retryable: false, createdAt: now, updatedAt: now }, ...current]);

    try {
      const formData = new FormData();
      formData.set("document", file);
      const headers: Record<string, string> = {};
      if (adminKey.trim()) headers["x-admin-key"] = adminKey.trim();
      const response = await fetch("/api/knowledge/documents", { method: "POST", body: formData, headers });
      const payload = await response.json() as { document?: ProjectDocument; error?: string };
      if (!response.ok) {
        if (payload.document) setDocuments((current) => current.map((document) => document.id === pendingId ? payload.document! : document));
        else setDocuments((current) => current.filter((document) => document.id !== pendingId));
        setDocumentError(payload.error || "The Project Document could not be indexed.");
        return;
      }
      if (!payload.document) throw new Error(payload.error || "The Project Document could not be indexed.");
      setDocuments((current) => current.map((document) => document.id === pendingId ? payload.document! : document));
      if (inputRef.current) inputRef.current.value = "";
      setSelectedUploadName(null);
    } catch (caughtError) {
      setDocuments((current) => current.filter((document) => document.id !== pendingId));
      setDocumentError(caughtError instanceof Error ? caughtError.message : "The Project Document could not be indexed.");
    } finally {
      setIsUploading(false);
    }
  }

  async function askQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!question.trim() || !hasReadyDocument || isAsking) return;
    setQuestionError(null);
    setAnswer(null);
    setFlagNote("");
    setFlagState("idle");
    setFlagError(null);
    setSelectedSource(null);
    setIsAsking(true);
    setAskingStep("Searching Knowledge Base…");

    const timer1 = setTimeout(() => {
      setAskingStep("Reading relevant passages…");
    }, 1100);

    const timer2 = setTimeout(() => {
      setAskingStep("Synthesizing Grounded Answer…");
    }, 2200);

    try {
      const response = await fetch("/api/knowledge/questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: question.trim() })
      });
      const payload = await response.json() as KnowledgeResponse | { error?: string };
      if (!response.ok || !("outcome" in payload)) {
        throw new Error("error" in payload && payload.error ? payload.error : "A Grounded Answer could not be generated.");
      }
      setAnswer(payload);
    } catch (caughtError) {
      setQuestionError(caughtError instanceof Error ? caughtError.message : "A Grounded Answer could not be generated.");
    } finally {
      clearTimeout(timer1);
      clearTimeout(timer2);
      setIsAsking(false);
      setAskingStep(null);
    }
  }

  async function submitAnswerFlag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!answer || flagState !== "idle") return;
    setFlagError(null);
    setFlagState("submitting");
    try {
      const response = await fetch("/api/knowledge/answer-flags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ responseId: answer.responseId, ...(flagNote.trim() ? { note: flagNote.trim() } : {}) })
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "The Answer Flag could not be submitted.");
      setFlagState("submitted");
    } catch (caughtError) {
      setFlagState("idle");
      setFlagError(caughtError instanceof Error ? caughtError.message : "The Answer Flag could not be submitted.");
    }
  }

  async function loadAnswerFlags() {
    if (isLoadingFlags) return;
    setFlagReviewError(null);
    setIsLoadingFlags(true);
    try {
      const headers: Record<string, string> = {};
      if (adminKey.trim()) headers["x-admin-key"] = adminKey.trim();
      const response = await fetch("/api/knowledge/answer-flags", { headers });
      const payload = await response.json() as { flags?: AnswerFlag[]; error?: string };
      if (!response.ok || !payload.flags) throw new Error(payload.error || "Answer Flags could not be loaded.");
      setAnswerFlags(payload.flags);
      setFlagsLoaded(true);
    } catch (caughtError) {
      setFlagReviewError(caughtError instanceof Error ? caughtError.message : "Answer Flags could not be loaded.");
    } finally {
      setIsLoadingFlags(false);
    }
  }

  async function reviewAnswerFlag(flagId: string) {
    if (reviewingFlagId) return;
    setFlagReviewError(null);
    setReviewingFlagId(flagId);
    try {
      const headers: Record<string, string> = {};
      if (adminKey.trim()) headers["x-admin-key"] = adminKey.trim();
      const response = await fetch(`/api/knowledge/answer-flags/${encodeURIComponent(flagId)}`, { method: "PATCH", headers });
      const payload = await response.json() as { flag?: { reviewedAt: string }; error?: string };
      if (!response.ok || !payload.flag) throw new Error(payload.error || "The Answer Flag could not be reviewed.");
      setAnswerFlags((current) => current.map((flag) => flag.id === flagId
        ? { ...flag, status: "reviewed", reviewedAt: payload.flag!.reviewedAt }
        : flag));
    } catch (caughtError) {
      setFlagReviewError(caughtError instanceof Error ? caughtError.message : "The Answer Flag could not be reviewed.");
    } finally {
      setReviewingFlagId(null);
    }
  }

  async function deleteDocument(document: ProjectDocument) {
    if (deletingDocumentIds.includes(document.id)) return;
    setDocumentError(null);
    setDeletingDocumentIds((current) => [...current, document.id]);
    try {
      const headers: Record<string, string> = {};
      if (adminKey.trim()) headers["x-admin-key"] = adminKey.trim();
      const response = await fetch(`/api/knowledge/documents/${encodeURIComponent(document.id)}`, { method: "DELETE", headers });
      if (!response.ok) {
        const payload = await response.json() as { error?: string };
        throw new Error(payload.error || "The Project Document could not be deleted.");
      }
      setDocuments((current) => current.filter((item) => item.id !== document.id));
      setAnswer(null);
      setSelectedSource(null);
    } catch (caughtError) {
      setDocumentError(caughtError instanceof Error ? caughtError.message : "The Project Document could not be deleted.");
    } finally {
      setDeletingDocumentIds((current) => current.filter((documentId) => documentId !== document.id));
    }
  }

  async function retryDocument(documentId: string) {
    if (retryingDocumentId) return;
    const previousDocument = documents.find((document) => document.id === documentId);
    setDocumentError(null);
    setRetryingDocumentId(documentId);
    setDocuments((current) => current.map((document) => document.id === documentId
      ? { ...document, status: "indexing", failureDetail: null, retryable: false }
      : document));
    try {
      const headers: Record<string, string> = {};
      if (adminKey.trim()) headers["x-admin-key"] = adminKey.trim();
      const response = await fetch(`/api/knowledge/documents/${encodeURIComponent(documentId)}/retry`, { method: "POST", headers });
      const payload = await response.json() as { document?: ProjectDocument; error?: string };
      if (payload.document) setDocuments((current) => current.map((document) => document.id === documentId ? payload.document! : document));
      if (!response.ok || !payload.document) throw new Error(payload.error || "The Project Document could not be retried.");
    } catch (caughtError) {
      setDocumentError(caughtError instanceof Error ? caughtError.message : "The Project Document could not be retried.");
      const response = await fetch("/api/knowledge/documents");
      const payload = await response.json() as { documents?: ProjectDocument[] };
      if (response.ok && payload.documents) setDocuments(payload.documents);
      else if (previousDocument) setDocuments((current) => current.map((document) => document.id === documentId ? previousDocument : document));
    } finally {
      setRetryingDocumentId(null);
    }
  }

  async function replaceDocument(document: ProjectDocument, file: File) {
    if (replacingDocumentId || document.replacement) return;
    setDocumentError(null);
    setReplacingDocumentId(document.id);
    const now = new Date().toISOString();
    const pending: ProjectDocument = {
      id: `replacement-${crypto.randomUUID()}`,
      name: file.name,
      mediaType: file.type,
      byteSize: file.size,
      status: "indexing",
      failureDetail: null,
      retryable: false,
      createdAt: now,
      updatedAt: now
    };
    setDocuments((current) => current.map((item) => item.id === document.id ? { ...item, replacement: pending } : item));
    try {
      const formData = new FormData();
      formData.set("document", file);
      const headers: Record<string, string> = {};
      if (adminKey.trim()) headers["x-admin-key"] = adminKey.trim();
      const response = await fetch(`/api/knowledge/documents/${encodeURIComponent(document.id)}/replacement`, { method: "POST", headers, body: formData });
      const payload = await response.json() as { document?: ProjectDocument; replacement?: ProjectDocument; error?: string };
      if (response.ok && payload.document) {
        setDocuments((current) => current.map((item) => item.id === document.id ? payload.document! : item));
        setAnswer(null);
        setSelectedSource(null);
        return;
      }
      setDocuments((current) => current.map((item) => item.id === document.id
        ? { ...item, replacement: payload.replacement }
        : item));
      throw new Error(payload.error || "The Document Replacement could not be processed.");
    } catch (caughtError) {
      setDocuments((current) => current.map((item) => item.id === document.id && item.replacement?.id === pending.id
        ? { ...item, replacement: undefined }
        : item));
      setDocumentError(caughtError instanceof Error ? caughtError.message : "The Document Replacement could not be processed.");
    } finally {
      setReplacingDocumentId(null);
    }
  }

  async function retryReplacement(document: ProjectDocument) {
    if (!document.replacement || retryingDocumentId) return;
    setDocumentError(null);
    setRetryingDocumentId(document.id);
    setDocuments((current) => current.map((item) => item.id === document.id && item.replacement
      ? { ...item, replacement: { ...item.replacement, status: "indexing", failureDetail: null, retryable: false } }
      : item));
    try {
      const headers: Record<string, string> = {};
      if (adminKey.trim()) headers["x-admin-key"] = adminKey.trim();
      const response = await fetch(`/api/knowledge/documents/${encodeURIComponent(document.id)}/replacement/retry`, { method: "POST", headers });
      const payload = await response.json() as { document?: ProjectDocument; replacement?: ProjectDocument; error?: string };
      if (response.ok && payload.document) {
        setDocuments((current) => current.map((item) => item.id === document.id ? payload.document! : item));
        setAnswer(null);
        setSelectedSource(null);
        return;
      }
      if (payload.replacement) setDocuments((current) => current.map((item) => item.id === document.id ? { ...item, replacement: payload.replacement } : item));
      throw new Error(payload.error || "The Document Replacement could not be retried.");
    } catch (caughtError) {
      setDocumentError(caughtError instanceof Error ? caughtError.message : "The Document Replacement could not be retried.");
    } finally {
      setRetryingDocumentId(null);
    }
  }

  async function discardReplacement(document: ProjectDocument) {
    if (!document.replacement || discardingReplacementId) return;
    setDocumentError(null);
    setDiscardingReplacementId(document.id);
    try {
      const headers: Record<string, string> = {};
      if (adminKey.trim()) headers["x-admin-key"] = adminKey.trim();
      const response = await fetch(`/api/knowledge/documents/${encodeURIComponent(document.id)}/replacement`, { method: "DELETE", headers });
      if (!response.ok) {
        const payload = await response.json() as { error?: string };
        throw new Error(payload.error || "The Document Replacement could not be discarded.");
      }
      setDocuments((current) => current.map((item) => item.id === document.id ? { ...item, replacement: undefined } : item));
    } catch (caughtError) {
      setDocumentError(caughtError instanceof Error ? caughtError.message : "The Document Replacement could not be discarded.");
    } finally {
      setDiscardingReplacementId(null);
    }
  }

  return (
    <section className="knowledge-panel" aria-labelledby="knowledge-heading">
      <div className="knowledge-canvas">
        <header className="knowledge-intro">
          <div>
            <p className="eyebrow">Shared private Knowledge Base</p>
            <h2 id="knowledge-heading">Ask your project</h2>
            <p>Get answers grounded in the documents your team has added.</p>
          </div>
          <button
            ref={drawerTriggerRef}
            className="document-drawer-trigger"
            type="button"
            aria-label={isLoading ? "Project Documents, loading" : `Project Documents, ${documents.length} uploaded`}
            aria-expanded={isDocumentDrawerOpen}
            aria-controls="document-drawer"
            onClick={() => setIsDocumentDrawerOpen(true)}
          >
            <span>Documents</span><strong>{isLoading ? "…" : documents.length}</strong>
          </button>
        </header>

        {questionError && <p className="knowledge-error" role="alert">{questionError}</p>}

        <div className="knowledge-prompts" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
          {samplePrompts.map((prompt) => (
            <button
              key={prompt}
              type="button"
              className="prompt-chip"
              onClick={() => setQuestion(prompt)}
              style={{
                fontSize: "0.8rem",
                padding: "0.25rem 0.6rem",
                borderRadius: "1rem",
                border: "1px solid rgba(255, 255, 255, 0.15)",
                background: "rgba(255, 255, 255, 0.05)",
                color: "inherit",
                cursor: "pointer"
              }}
            >
              {prompt}
            </button>
          ))}
        </div>

        <form className="knowledge-question" onSubmit={askQuestion}>
          <label htmlFor="knowledge-question">What would you like to know?</label>
          <textarea id="knowledge-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder={isLoading ? "Loading Project Documents…" : hasReadyDocument ? "Ask about decisions, requirements, policies, or project details…" : "Add a Project Document to start asking grounded questions"} disabled={isLoading || !hasReadyDocument || isAsking} rows={4} required />
          <div className="knowledge-question-footer">
            <span>{isLoading ? "Loading the Knowledge Base…" : hasReadyDocument ? "Answers include Source References" : "Add at least one ready Project Document"}</span>
            <button type="submit" disabled={isLoading || !hasReadyDocument || !question.trim() || isAsking}>{isAsking ? "Searching…" : "Ask question"}</button>
          </div>
        </form>
        {isAsking && askingStep && (
          <div
            className="knowledge-asking-status"
            role="status"
            aria-live="polite"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.65rem",
              marginTop: "1.5rem",
              padding: "0.75rem 1rem",
              borderRadius: "0.625rem",
              background: "#1d2024",
              border: "1px solid #40464f",
              color: "#c4c7c5",
              fontSize: "0.875rem"
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: "0.85rem",
                height: "0.85rem",
                borderRadius: "50%",
                border: "2px solid #5a5f67",
                borderTopColor: "#a8c7fa",
                animation: "spin 0.8s linear infinite"
              }}
            />
            <span>{askingStep}</span>
          </div>
        )}
        {answer?.degradedSearch && (
          <p className="knowledge-degraded" role="status">
            Semantic search is temporarily unavailable. These keyword results may be less complete.
          </p>
        )}
        {answer?.outcome === "insufficient_evidence" && <p className="knowledge-empty">The Knowledge Base does not contain enough evidence to answer that question.</p>}
        {answer?.outcome === "answered" && (
          <article className="grounded-answer" aria-live="polite">
            <p className="eyebrow">Grounded Answer</p>
            {answer.paragraphs.map((paragraph, paragraphIndex) => (
              <div className="answer-paragraph" key={`${paragraphIndex}-${paragraph.text}`}>
                <p>{paragraph.text}</p>
                <div className="source-reference-list" aria-label="Source References">
                  {paragraph.sourceReferences.map((source) => (
                    <button type="button" key={`${paragraphIndex}-${source.id}`} className={selectedSource?.id === source.id ? "selected" : ""} aria-pressed={selectedSource?.id === source.id} onClick={() => setSelectedSource(source)}>
                      {source.documentName} · lines {source.startLine}–{source.endLine}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {selectedSource && (
              <aside className="source-excerpt" aria-live="polite">
                <strong>{selectedSource.documentName} · lines {selectedSource.startLine}–{selectedSource.endLine}</strong>
                {selectedSource.headingPath.length > 0 && <span>{selectedSource.headingPath.join(" › ")}</span>}
                <blockquote>{selectedSource.excerpt}</blockquote>
              </aside>
            )}
          </article>
        )}
        {answer && (
          <form className="answer-flag-form" onSubmit={submitAnswerFlag}>
            <div>
              <strong>Something not right?</strong>
              <span>Flag this response for the Portfolio Owner. This will not change answers automatically.</span>
            </div>
            {flagState !== "submitted" ? (
              <>
                <label htmlFor="answer-flag-note">Optional note</label>
                <textarea
                  id="answer-flag-note"
                  value={flagNote}
                  onChange={(event) => setFlagNote(event.target.value)}
                  maxLength={500}
                  rows={2}
                  placeholder="Briefly explain what seems incorrect or unhelpful"
                  disabled={flagState === "submitting"}
                />
                <div className="answer-flag-footer">
                  <span>{flagNote.length}/500</span>
                  <button type="submit" disabled={flagState === "submitting"}>{flagState === "submitting" ? "Submitting…" : "Flag response"}</button>
                </div>
              </>
            ) : <p className="answer-flag-success" role="status">Flag submitted for owner review.</p>}
            {flagError && <p className="knowledge-error" role="alert">{flagError}</p>}
          </form>
        )}
      </div>

      {isDocumentDrawerOpen && (
        <div className="document-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDocumentDrawer(); }}>
          <aside ref={drawerRef} id="document-drawer" className="document-drawer" role="dialog" aria-modal="true" aria-labelledby="document-drawer-title" onKeyDown={handleDrawerKeyDown}>
            <header className="document-drawer-header">
              <div><p className="eyebrow">Knowledge sources</p><h3 id="document-drawer-title">Project Documents</h3></div>
              <button ref={drawerCloseRef} className="document-drawer-close" type="button" onClick={closeDocumentDrawer} aria-label="Close project documents">×</button>
            </header>
            <div className="document-drawer-content">
              <div style={{ marginBottom: "1rem", padding: "0.5rem", borderRadius: "0.375rem", border: "1px solid rgba(255, 255, 255, 0.15)" }}>
                <label htmlFor="admin-key-input" style={{ fontSize: "0.75rem", display: "block", marginBottom: "0.25rem", opacity: 0.8 }}>Portfolio Owner secret</label>
                <input
                  id="admin-key-input"
                  type="password"
                  placeholder="Enter owner secret to manage documents"
                  value={adminKey}
                  onChange={(e) => {
                    setAdminKey(e.target.value);
                    sessionStorage.setItem("portfolio_admin_key", e.target.value);
                  }}
                  style={{ width: "100%", padding: "0.35rem 0.5rem", fontSize: "0.825rem", background: "transparent", border: "1px solid rgba(255, 255, 255, 0.2)", borderRadius: "0.25rem", color: "inherit" }}
                />
              </div>

              <section className="answer-flag-review" aria-labelledby="answer-flags-heading">
                <div className="answer-flag-review-heading">
                  <div><strong id="answer-flags-heading">Answer Flags</strong><span>Private owner review</span></div>
                  <button type="button" onClick={loadAnswerFlags} disabled={isLoadingFlags}>{isLoadingFlags ? "Loading…" : flagsLoaded ? "Refresh" : "Load flags"}</button>
                </div>
                {flagReviewError && <p className="knowledge-error" role="alert">{flagReviewError}</p>}
                {flagsLoaded && answerFlags.length === 0 && <p className="knowledge-empty">No Answer Flags yet.</p>}
                {answerFlags.length > 0 && (
                  <ul className="answer-flag-list">
                    {answerFlags.map((flag) => (
                      <li key={flag.id}>
                        <div className="answer-flag-meta"><span className={`answer-flag-status ${flag.status}`}>{flag.status}</span><time dateTime={flag.respondedAt}>{new Date(flag.respondedAt).toLocaleString()}</time></div>
                        <strong>{flag.question}</strong>
                        <p>{flag.outcome === "answered" ? flag.responseContent.paragraphs.map((paragraph) => paragraph.text).join(" ") : "Insufficient Evidence"}</p>
                        {flag.responseContent.degradedSearch && <span className="answer-flag-degraded">Degraded keyword search</span>}
                        {flag.note && <blockquote>{flag.note}</blockquote>}
                        {flag.status === "open" && <button type="button" onClick={() => reviewAnswerFlag(flag.id)} disabled={reviewingFlagId !== null}>{reviewingFlagId === flag.id ? "Marking…" : "Mark reviewed"}</button>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <form className="knowledge-upload" onSubmit={uploadDocument}>
                <div className="knowledge-upload-heading"><strong>Add a document</strong><span>PDF, MD, TXT, HTML, JSON, CSV · max 500 KB</span></div>
                <input ref={inputRef} className="sr-only" id="project-document" name="document" type="file" accept=".md,.markdown,.txt,.pdf,.html,.htm,.json,.csv,text/markdown,text/plain,application/pdf,text/html,application/json,text/csv" disabled={isUploading} onChange={(event) => setSelectedUploadName(event.target.files?.[0]?.name ?? null)} required />
                <label className="document-file-picker" htmlFor="project-document">
                  <span>{selectedUploadName ?? "Choose a document"}</span><strong>{selectedUploadName ? "Change" : "Browse"}</strong>
                </label>
                <button type="submit" disabled={isUploading || !selectedUploadName}>{isUploading ? "Indexing…" : "Upload and index"}</button>
              </form>
              {documentError && <p className="knowledge-error" role="alert">{documentError}</p>}
              <div className="knowledge-list-heading"><h4>Uploaded Project Documents</h4><span>{isLoading ? "…" : documents.length}</span></div>
              {isLoading ? <p className="knowledge-empty">Loading the Knowledge Base…</p> : documents.length === 0 ? <p className="knowledge-empty">No documents yet. Add a Project Document to get started.</p> : (
                <ul className="knowledge-list">
                  {documents.map((document) => (
                    <li key={document.id}>
                      <div className="document-details"><strong title={document.name}>{document.name}</strong><span>{Math.max(1, Math.ceil(document.byteSize / 1024))} KB · {formatMediaType(document.mediaType)}</span>{document.status === "failed" && document.failureDetail && <span className="document-failure">{document.failureDetail}</span>}</div>
                      <div className="document-actions">
                        <span className={`document-status ${document.status}`}><i aria-hidden="true" />{document.status}</span>
                        {document.status !== "indexing" && (
                          <button className="document-delete" type="button" onClick={() => deleteDocument(document)} disabled={deletingDocumentIds.includes(document.id)}>
                            {deletingDocumentIds.includes(document.id) ? "Deleting…" : "Delete"}
                          </button>
                        )}
                        {document.status === "failed" && document.retryable && (
                          <button type="button" onClick={() => retryDocument(document.id)} disabled={retryingDocumentId !== null}>
                            {retryingDocumentId === document.id ? "Retrying…" : "Retry"}
                          </button>
                        )}
                        {document.status === "ready" && !document.replacement && (
                          <>
                            <input
                              className="sr-only"
                              id={`replace-${document.id}`}
                              type="file"
                              accept=".md,.markdown,.txt,.pdf,.html,.htm,.json,.csv,text/markdown,text/plain,application/pdf,text/html,application/json,text/csv"
                              disabled={replacingDocumentId !== null}
                              onChange={(event) => {
                                const file = event.target.files?.[0];
                                if (file) void replaceDocument(document, file);
                                event.target.value = "";
                              }}
                            />
                            <label className="document-delete" htmlFor={`replace-${document.id}`}>
                              {replacingDocumentId === document.id ? "Replacing…" : "Replace"}
                            </label>
                          </>
                        )}
                      </div>
                      {document.replacement && (
                        <div className="document-details" aria-label={`Pending replacement for ${document.name}`}>
                          <strong title={document.replacement.name}>Replacement: {document.replacement.name}</strong>
                          <span>{Math.max(1, Math.ceil(document.replacement.byteSize / 1024))} KB · {formatMediaType(document.replacement.mediaType)}</span>
                          <span className={`document-status ${document.replacement.status}`}><i aria-hidden="true" />{document.replacement.status}</span>
                          {document.replacement.failureDetail && <span className="document-failure">{document.replacement.failureDetail}</span>}
                          {document.replacement.status === "failed" && (
                            <div className="document-actions">
                              {document.replacement.retryable && <button type="button" onClick={() => retryReplacement(document)} disabled={retryingDocumentId !== null}>{retryingDocumentId === document.id ? "Retrying…" : "Retry replacement"}</button>}
                              <button type="button" onClick={() => discardReplacement(document)} disabled={discardingReplacementId !== null}>{discardingReplacementId === document.id ? "Discarding…" : "Discard replacement"}</button>
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}
