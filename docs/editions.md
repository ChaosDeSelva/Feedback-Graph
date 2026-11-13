# Editions

Feedback Graph is open source under the Apache License 2.0. This repository is the complete tool for one developer on their own machine:

- transcript parsing for Claude Code and Codex, with redaction before anything is stored or sent to a model
- pushback detection, the Inbox, post-mortems, lessons and lesson triggers, every lesson decided by you or, once your own verdicts have earned it, by the learning loop (audited and reversible; set it to `propose` to keep every decision yours)
- the learning loop, which links repeated misses, merges, re-ranks, retires, rewords and approves lessons, triages the Inbox and helps review claims by the mode you choose, and the Decisions audit log of everything it did, with rollback
- the code map, code scans into facts, uploaded docs, and GitHub and Linear context
- knowledge intake (opt-in): call transcripts and notes read into claims and questions you review, conflicts between what agents are told for you to settle, and look-ups of what is known about a topic
- the graph on Neo4j or Postgres, the MCP server (with the judge behind `check_before_done`), the agent skills, the Claude Code plugin and the web UI
- token access control, Activity (provenance), export and delete

It never phones home and needs no account.

There is also a hosted team edition, which shares approved lessons across a team. It builds on this repository; nothing here depends on it.
