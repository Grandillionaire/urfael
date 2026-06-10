# Heartbeat checklist

<!-- Read by the automated heartbeat (opt-in: set URFAEL_HEARTBEAT_MINS in the daemon plist).
     Urfael runs through this list every beat and stays SILENT unless something genuinely needs
     attention — you only hear from it when it matters. Keep this list short: every line costs
     tokens on every beat. Delete what you don't use. -->

- Check today's calendar: is there an event starting in the next 45 minutes I haven't been reminded about?
- Scan the inbox (if email is connected): anything urgent and unanswered from a real person?
- Look at `00_Inbox/`: more than 10 unfiled captures piling up?
- Any task in `01_Projects/` with a deadline in the next 24 hours that has no progress note today?

Rules:
- If none of the above needs attention, reply exactly `HEARTBEAT_OK` — nothing else.
- Alert at most once per topic per day (note what you alerted about in today's daily note, and check it first).
- Never take actions during a heartbeat — only look and report.
