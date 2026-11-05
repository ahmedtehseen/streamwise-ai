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

export default function KnowledgePanel() {
  const [documents, setDocuments] = useState<ProjectDocument[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [question, setQuestion] = useState("");
  const [isAsking, setIsAsking] = useState(false);
  const [answer, setAnswer] = useState<GroundedAnswer | null>(null);
  const [selectedSource, setSelectedSource] = useState<SourceReference | null>(null);
  const [deletingDocumentIds, setDeletingDocumentIds] = useState<string[]>([]);
  const [retryingDocumentId, setRetryingDocumentId] = useState<string | null>(null);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [questionError, setQuestionError] = useState<string | null>(null);
  const [isDocumentDrawerOpen, setIsDocumentDrawerOpen] = useState(false);
  const [selectedUploadName, setSelectedUploadName] = useState<string | null>(null);
  const [askingStep, setAskingStep] = useState<string | null>(null);
  const [adminKey, setAdminKey] = useState("");
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
      const payload = await response.json() as GroundedAnswer | { error?: string };
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
                  placeholder="Enter owner secret to upload or delete"
                  value={adminKey}
                  onChange={(e) => {
                    setAdminKey(e.target.value);
                    sessionStorage.setItem("portfolio_admin_key", e.target.value);
                  }}
                  style={{ width: "100%", padding: "0.35rem 0.5rem", fontSize: "0.825rem", background: "transparent", border: "1px solid rgba(255, 255, 255, 0.2)", borderRadius: "0.25rem", color: "inherit" }}
                />
              </div>

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
                      </div>
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
