# Recovering data rewritten by redaction v6

Version 0.6.5 corrects the broad Basic-auth, Docker-auth and pgpass patterns. Worker startup on a store last migrated by v6 runs a source-backed recovery pass before applying v7. Its separate cursor makes an interrupted migration retry on restart.

Activity's “Redaction v6 source recovery scheduled” entry distinguishes suspected facts, files queued, uploads queued, exact lesson snapshots restored, and items needing an original. Queued work is not a claim that wording has already been restored. Credential-closed facts stay closed until a source scan or upload read rebuilds them.

Existing files inside selected project folders receive explicit rescan requests and scan jobs, even if their hashes have not changed. Unselected, deleted or unavailable files need the project selected and a manual rescan. Uploads are reread only when the retained image or all original text chunks are intact. Re-upload an original document when its stored chunks contain `[REDACTED]`; v6 overwrote those words and kept no reversible copy.

An approved lesson can be repaired automatically only when its retained original proposal matches the damaged field exactly under a known defective v6 pattern and the original passes current redaction without changes. Approval is preserved. Other damaged approved lessons receive an explanation in their checks: recover the exact wording from the source PR or a trusted backup and edit the lesson. Do not guess placeholder contents or reopen masked facts.

The five facts reported by the 0.6.4 audit require this pass against the affected live store and its original sources. A successful code test or queued scan does not establish that all five have been recovered. Verify the rebuilt facts and Activity after scans finish; restore unavailable originals from a trusted pre-v6 backup if necessary.
