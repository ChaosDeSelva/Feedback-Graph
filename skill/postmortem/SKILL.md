---
name: postmortem
description: Use when the developer runs /postmortem or asks to record that the agent missed something. Sends the miss to the local Feedback Graph so a post-mortem can work out why it was missed and propose a lesson.
---

# /postmortem

1. Work out what the developer is reporting. Use the text after `/postmortem`; if it's empty, use their most recent pushback in this conversation.
2. In one or two sentences, summarise what you (the agent) had built or claimed before that feedback.
3. Call the `report_feedback` MCP tool with:
   - `cwd`: the current working directory
   - `feedback`: the developer's words, verbatim where possible
   - `what_was_done`: your summary from step 2
   - `session_id`: your session id, when you know it (it lets the Feedback Graph merge this report with the same pushback flagged from the transcript)
4. Tell the developer it is waiting in the Feedback Graph **Inbox** (the Feedback Graph web UI, http://localhost:8787/#inbox by default). If the same pushback was already flagged from the transcript, the report is added to that Inbox item instead of making a second one. Once they confirm it there, a post-mortem runs and the proposed lesson appears under **Lessons**. Never confirm or approve anything in the Feedback Graph yourself; those decisions are the developer's.

Never invent feedback the developer did not give.
