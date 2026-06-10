---
description: Frictionless capture — drop a thought into the inbox / today's note
argument-hint: <the thing to capture>
---

Capture this for the user with zero friction:

$ARGUMENTS

Steps:
1. If it's a quick thought/idea/link, append it as a timestamped bullet under `## Captured`
   in today's daily note (`90_Daily/<today>.md`, today = the real current date). Create the
   daily note from `99_Templates/daily.md` if it doesn't exist.
2. If it's substantial enough to deserve its own note (a project, a person, a topic), create
   a note in `00_Inbox/` from `99_Templates/note.md` with a sensible kebab-case filename and
   frontmatter, then add a one-line pointer to it under `## Captured` in today's daily note.
3. Add relevant `[[wikilinks]]` and tags. Don't over-file — speed matters; sorting happens
   in `/weekly-review`.
4. Confirm in ONE short line what you captured and where. Nothing more.
