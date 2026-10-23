# demo-shop

Tiny multi-tenant shop API (Node 26, no framework, `node --test`).

## Rules for every endpoint

- **Tenant isolation:** every query MUST go through `db.scoped(req.auth.orgId)`. Never call `db.raw()` from a route; it bypasses tenant scoping and exists only for admin scripts.
- **Pagination:** list endpoints paginate server-side with `paginate(rows, req.query)` (default 20, max 50). Never return an unbounded list.
- **Errors:** respond with `{ error: { code, message } }` via `sendError`, never a bare string.
- Every route gets a test in `test/` that covers a cross-tenant request.
