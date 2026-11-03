"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

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

export default function KnowledgePanel() {
  const [documents, setDocuments] = useState<ProjectDocument[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [retryingDocumentId, setRetryingDocumentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function loadDocuments() {
      try {
        const response = await fetch("/api/knowledge/documents", { signal: controller.signal });
        const payload = await response.json() as { documents?: ProjectDocument[]; error?: string };
        if (!response.ok || !payload.documents) throw new Error(payload.error || "The Knowledge Base could not be loaded.");
        setDocuments(payload.documents);
      } catch (caughtError) {
        if (!controller.signal.aborted) setError(caughtError instanceof Error ? caughtError.message : "The Knowledge Base could not be loaded.");
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }
    loadDocuments();
    return () => controller.abort();
  }, []);

  async function uploadDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = inputRef.current?.files?.[0];
    if (!file || isUploading) return;
    const pendingId = `indexing-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    setError(null);
    setIsUploading(true);
    setDocuments((current) => [{ id: pendingId, name: file.name, mediaType: file.type, byteSize: file.size, status: "indexing", failureDetail: null, retryable: false, createdAt: now, updatedAt: now }, ...current]);

    try {
      const formData = new FormData();
      formData.set("document", file);
      const response = await fetch("/api/knowledge/documents", { method: "POST", body: formData });
      const payload = await response.json() as { document?: ProjectDocument; error?: string };
      if (!response.ok) {
        if (payload.document) setDocuments((current) => current.map((document) => document.id === pendingId ? payload.document! : document));
        else setDocuments((current) => current.filter((document) => document.id !== pendingId));
        setError(payload.error || "The Project Document could not be indexed.");
        return;
      }
      if (!payload.document) throw new Error(payload.error || "The Project Document could not be indexed.");
      setDocuments((current) => current.map((document) => document.id === pendingId ? payload.document! : document));
      if (inputRef.current) inputRef.current.value = "";
    } catch (caughtError) {
      setDocuments((current) => current.filter((document) => document.id !== pendingId));
      setError(caughtError instanceof Error ? caughtError.message : "The Project Document could not be indexed.");
    } finally {
      setIsUploading(false);
    }
  }

  async function retryDocument(documentId: string) {
    if (retryingDocumentId) return;
    const previousDocument = documents.find((document) => document.id === documentId);
    setError(null);
    setRetryingDocumentId(documentId);
    setDocuments((current) => current.map((document) => document.id === documentId
      ? { ...document, status: "indexing", failureDetail: null, retryable: false }
      : document));
    try {
      const response = await fetch(`/api/knowledge/documents/${encodeURIComponent(documentId)}/retry`, { method: "POST" });
      const payload = await response.json() as { document?: ProjectDocument; error?: string };
      if (payload.document) setDocuments((current) => current.map((document) => document.id === documentId ? payload.document! : document));
      if (!response.ok || !payload.document) throw new Error(payload.error || "The Project Document could not be retried.");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "The Project Document could not be retried.");
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
      <div className="knowledge-intro">
        <p className="eyebrow">SHARED PRIVATE KNOWLEDGE BASE</p>
        <h2 id="knowledge-heading">Project Knowledge Assistant</h2>
        <p>Upload Markdown or plain-text Project Documents to make project knowledge available for grounded questions.</p>
      </div>
      <form className="knowledge-upload" onSubmit={uploadDocument}>
        <label htmlFor="project-document">Project Document</label>
        <div>
          <input ref={inputRef} id="project-document" name="document" type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" disabled={isUploading} required />
          <button type="submit" disabled={isUploading}>{isUploading ? "Indexing…" : "Upload and index"}</button>
        </div>
        <small>Markdown or plain text · maximum 500 KB</small>
      </form>
      {error && <p className="knowledge-error" role="alert">{error}</p>}
      <div className="knowledge-list-heading"><h3>Project Documents</h3><span>{documents.length}</span></div>
      {isLoading ? <p className="knowledge-empty">Loading the Knowledge Base…</p> : documents.length === 0 ? <p className="knowledge-empty">No Project Documents have been indexed yet.</p> : (
        <ul className="knowledge-list">
          {documents.map((document) => (
            <li key={document.id}>
              <div className="document-summary"><strong>{document.name}</strong><span>{Math.max(1, Math.ceil(document.byteSize / 1024))} KB · {document.mediaType === "text/markdown" ? "Markdown" : "Plain text"}</span>{document.status === "failed" && document.failureDetail && <span className="document-failure">{document.failureDetail}</span>}</div>
              <div className="document-actions"><span className={`document-status ${document.status}`}><i aria-hidden="true" />{document.status}</span>{document.status === "failed" && document.retryable && <button type="button" onClick={() => retryDocument(document.id)} disabled={retryingDocumentId !== null}>Retry indexing</button>}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
