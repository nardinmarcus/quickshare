# Domain Docs

QuickShare is a single-context repository.

## Before exploring

- Read the root `CONTEXT.md` and use its canonical domain terms.
- Read relevant records under `docs/adr/` when that directory exists.
- If either source is absent, proceed silently; create domain documentation lazily through the domain-modeling workflow only when terminology or a qualifying decision is resolved.

## Layout

```text
/
├── CONTEXT.md
├── docs/
│   └── adr/
└── ...
```

## Consumer rules

- Use glossary terms in issue titles, specs, tests, implementation plans, and user-facing copy.
- Avoid synonyms explicitly rejected by the glossary.
- Surface conflicts with an existing ADR instead of silently overriding it.
