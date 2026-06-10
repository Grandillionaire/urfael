---
description: Generate a chart / diagram / visual and show it (Mermaid, matplotlib PNG, or interactive HTML)
argument-hint: <what to visualize, + any data>
---

Make a visual for User:

$ARGUMENTS

1. **Pick the right medium** (see the Visuals playbook in CLAUDE.md):
   - flow/relationship/timeline/mindmap → a ` ```mermaid ` block in a note (Obsidian renders it).
   - data chart (bar/line/scatter/pie/histogram) → a **matplotlib** Python script run via Bash → PNG in
     `03_Resources/visuals/`. Use `plt.style.use('dark_background')`, cyan accents, `dpi=150`, `bbox_inches='tight'`.
   - interactive/dashboard → self-contained HTML (Chart.js/Plotly via CDN) in `03_Resources/visuals/`.
2. **If data is missing**, pull it from the relevant source (the vault, a calendar, an API in `_urfael/apis.md`)
   or ask the user for it — don't invent numbers.
3. **Save + embed + open.** Put the visual in `03_Resources/visuals/`; for a chart/diagram, create a note
   `03_Resources/visuals/<name>.md` that starts with `![[urfael-logo.svg|90]]`, a title, and embeds the
   visual (`![[visuals/<name>.png]]` or the mermaid block). Open it in Obsidian (or the HTML in the browser).
4. **Report** with one short spoken-style line pointing the user to the screen + your read on what it shows.
