# A2UI: a safe agent canvas

A2UI lets the brain emit interactive UI, a card with a table and buttons, a progress bar, a form, instead of only text. The agent writes a fenced block:

````
```a2ui
{ "blocks": [
  { "type": "heading", "text": "Deploy status" },
  { "type": "table", "headers": ["service", "state"], "rows": [["voicebot", "up"], ["chatbot", "up"]] },
  { "type": "progress", "value": 73, "label": "building" },
  { "type": "button", "label": "Redeploy", "action": "redeploy.voicebot" }
] }
```
````

`app/a2ui.js` extracts that block and validates it into a safe, normalized structure a surface renders.

## Why it is safe by construction

The reason most agent "canvases" are risky is that they render model-generated HTML, which is one injected instruction away from a script or a malicious link. A2UI never does that. The validator is the security boundary:

- **Allowlisted block types only**: heading, text, list, table, keyvalue, button, input, link, badge, progress, divider, card. A block of type `script`, `html`, or `iframe` is dropped, it is not in the allowlist.
- **No raw HTML**: every value is plain text with control characters stripped. The renderer's contract is to show text with `textContent`, never `innerHTML`, so `<script>` is displayed literally, never executed.
- **https-only links**: a `javascript:`, `data:`, `file:`, or plain `http:` href drops the whole link. Only `https://` survives.
- **Buttons carry no code**: a button is reduced to `{ type, label, action }`, where `action` is a bare command id (letters, digits, and `._:-`), never a URL or a handler. The surface treats it as an opaque command to confirm with the owner before running, the same fail-closed posture as everything else.
- **Bounded**: at most 40 blocks, bounded nesting, capped table size, and length-capped text, so a hostile canvas cannot blow up the renderer.

So a generative UI, even one shaped by a poisoned input, cannot become an XSS or a click-to-execute vector. This property is frozen as a security-benchmark check.

## Honest status

The protocol and the validator are shipped, unit-tested, and benchmark-frozen. Live rendering of A2UI blocks in the web dashboard and the Console is the next increment; the safe schema is the foundation it builds on. Read the validator at [app/a2ui.js](https://github.com/Grandillionaire/urfael/blob/main/app/a2ui.js).

## Related

- [security/model.md](security/model.md)
- [using/surfaces.md](using/surfaces.md)
