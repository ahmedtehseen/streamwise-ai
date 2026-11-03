# Domain Docs

This repository uses a single-context domain-document layout.

## Before exploring

Read these files when they are relevant:

- `GLOSSARY.md` at the repository root
- Applicable architecture decision records under `docs/adr/`

If either location does not exist, proceed silently. Domain-modeling skills
create these documents when terminology or architectural decisions are
actually established.

## Layout

```text
/
├── GLOSSARY.md
├── docs/
│   └── adr/
└── app/
```

## Vocabulary

Use terms as defined in `GLOSSARY.md` when naming concepts in issues, tests,
implementation plans, and code.

Avoid introducing synonyms that the glossary explicitly rejects. If a required
concept is missing, reconsider whether it is established project language or
record the gap for domain modeling.

## Architecture decisions

Read ADRs affecting an area before changing it. If proposed work contradicts an
existing ADR, identify the conflict explicitly instead of silently overriding
the decision.
