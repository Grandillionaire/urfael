---
description: Deep-research a topic, then write it up as a logo'd document and open it in Obsidian
argument-hint: <topic to research>
---

Do thorough research for the user on:

$ARGUMENTS

1. **Research deeply.** Use the web (Tavily search per `_urfael/apis.md`, plus Wikipedia and any
   relevant free APIs), and the Playwright browser if you need to read specific pages. Gather real
   substance — facts, figures, multiple sources, contrasting views — not a shallow summary.
2. **Write it up as a document** in `03_Resources/research-<kebab-topic>.md`, built from
   `99_Templates/research.md`. **Keep the `![[urfael-logo.svg|90]]` embed as the very first line**
   (the Urfael logo, top-left), then fill in Summary → Key findings → Details → Sources → Open
   questions. Cite each source. Be comprehensive but well-organized.
3. **Open it in Obsidian** so the user can read along: use the Obsidian `open_file` tool on the new note
   (fallback: `open "obsidian://open?vault=Urfael&file=03_Resources/research-<kebab-topic>"`).
4. **Report back** in one or two spoken-style sentences: the headline of what you found and that the
   full write-up is open in Obsidian. (The HUD/document shows the detail — don't read it all aloud.)
