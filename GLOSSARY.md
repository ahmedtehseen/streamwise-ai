# Streamwise AI

Streamwise AI turns project material into structured, reviewable work and source-backed project knowledge.

## Language

**Portfolio Assistant**:
The public Streamwise capability that answers questions about the portfolio owner using the contents of the Knowledge Base.
_Avoid_: Personal agent, Project Knowledge Assistant, document chatbot

**Knowledge Base**:
A collection of Project Documents available to the Portfolio Assistant as evidence.
_Avoid_: Corpus, dataset

**Project Document**:
A document supplied as evidence for the Portfolio Assistant.
_Avoid_: File, attachment

**Grounded Answer**:
An answer supported entirely by evidence from Project Documents and accompanied by Source References.
_Avoid_: AI answer, generated answer

**Insufficient Evidence**:
The outcome returned when the Knowledge Base does not contain enough support for a Grounded Answer.
_Avoid_: Unknown answer, best guess

**Source Reference**:
A pointer from a Grounded Answer to the Project Document passage that supports it.
_Avoid_: Link, footnote

**Portfolio Owner**:
The person represented by the Portfolio Assistant and solely responsible for managing its Knowledge Base.
_Avoid_: Admin user, tenant

**Visitor**:
A person who uses Streamwise AI's public capabilities without permission to manage the Knowledge Base.
_Avoid_: User, guest account

**Answer Flag**:
A Visitor's report that a Portfolio Assistant response may be unhelpful or incorrect and should be reviewed by the Portfolio Owner.
_Avoid_: Rating, automatic correction

**Answer Flag Review**:
The Portfolio Owner's inspection of an Answer Flag and explicit decision to mark it reviewed without automatically changing the captured response, its Source References, or the Knowledge Base.
_Avoid_: Automatic remediation, feedback training

**Document Replacement**:
A proposed Project Document revision that becomes available as evidence only after it is successfully processed, without interrupting the current revision.
_Avoid_: In-place edit, version history
