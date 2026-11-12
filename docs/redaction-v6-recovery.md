# Recovering data rewritten by redaction v6

Redaction rules v6 had three over-broad patterns (Basic auth, Docker `auth` and pgpass lines) that overwrote ordinary text with `[REDACTED]`; 0.6.5 corrected them. When the worker starts on a store last redacted under older rules, it runs a source-backed recovery pass once, before applying the current rules. The pass has its own cursor, so one interrupted by a restart runs again.

Activity's “Redaction v6 source recovery scheduled” entry distinguishes suspected facts, files queued, uploads queued, exact lesson snapshots restored, and items needing an original. Queued work is not a claim that wording has already been restored. Credential-closed facts stay closed until a source scan or upload read rebuilds them. An install with nothing suspected gets no entry.

Existing files inside selected project folders receive explicit rescan requests and scan jobs, even if their hashes have not changed. Unselected, deleted or unavailable files need the project selected and a manual rescan. Uploads are reread only when the retained image or all original text chunks are intact. Re-upload an original document when its stored chunks contain `[REDACTED]`; v6 overwrote those words and kept no reversible copy.

An approved lesson can be repaired automatically only when its retained original proposal matches the damaged field exactly under a known defective v6 pattern and the original passes current redaction without changes. Approval is preserved. Other damaged approved lessons receive an explanation in their checks: recover the exact wording from the source PR or a trusted backup and edit the lesson. Do not guess placeholder contents or reopen masked facts.

## Checking a recovery

1. After the upgrade, open Activity and find the “Redaction v6 source recovery scheduled” entry. No entry means nothing was suspected.
2. Wait for the queued scans and document reads to finish (Projects shows each scan's state, Docs and discussions each document's).
3. Search the project's facts and documents for `[REDACTED]` where no credential belongs. A queued scan or rescan request is not proof that wording came back; only the rebuilt fact or chunk is.
4. For anything still damaged: select its project and rescan, re-upload the original document, or edit the lesson from the source PR. When the source no longer exists, restore the original from a trusted backup taken before v6.
