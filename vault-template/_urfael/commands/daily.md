---
description: Open/create today's daily note and brief the user on what matters
argument-hint: (optional focus for the day)
---

Run the user's daily startup:

1. Determine today's real date. Open `90_Daily/<today>.md`; create it from
   `99_Templates/daily.md` if it doesn't exist.
2. Read `MEMORY.md` and skim `01_Projects/` for anything time-sensitive (deadlines, stale
   "active" projects) and `00_Inbox/` for un-filed items.
3. Pull **today's Google Calendar** events (all calendars) and scan **Gmail** for important
   unread threads or anything clearly awaiting the user's reply. Read-only — don't draft or send.
4. Give the user a short spoken-style brief: today's date, today's meetings/time-blocks, anything
   in email that needs a reply, plus vault deadlines/open loops and anything stale. Headline
   first, 3-5 lines max. Write the day's meetings into the daily note for reference.
5. If the user passed a focus ($ARGUMENTS), write it under `## Focus` in today's note.
6. End by asking what he wants to tackle first — one line.
