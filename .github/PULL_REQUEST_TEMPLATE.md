<!--
Thanks for the PR! A short, focused description here is worth a lot
during review. Delete sections that don't apply.
-->

## Summary

<!-- What does this PR change, in 1–3 bullets? -->

-
-

## Why

<!-- The motivation. Link the issue if there is one. -->

Closes #

## Changes

<!--
List the user-visible or API-visible changes. Skip if Summary already
covers everything.
-->

- Backend:
- Frontend:
- Docs / screenshots:

## How was this tested?

<!--
Concrete, reproducible. "Manually clicked around" is fine if you say
*what* you clicked and *what* you observed.
-->

- [ ] Backend: ran `python main.py` and exercised affected endpoints
- [ ] Frontend: `npm run build` and `npm run lint` pass
- [ ] Manual end-to-end check on:
  - [ ] ND2 Manager
  - [ ] Cell Extraction
  - [ ] Annotation
  - [ ] Bulk Engine
  - [ ] Other:
- [ ] Tests added / updated (if applicable)

## Screenshots / recordings

<!-- For UI changes or new analysis modes, drag images/GIFs here. -->

## Breaking changes

<!--
API shape, DB schema, env var, or default behavior changes.
If none, write "None".
-->

## Checklist

- [ ] PR is scoped to one logical change
- [ ] Docs updated (README / module READMEs / CITATION.cff if applicable)
- [ ] New analysis mode? Formula documented in
      `backend/app/bulk_engine/README.md` or equivalent
- [ ] No secrets or large binaries committed
