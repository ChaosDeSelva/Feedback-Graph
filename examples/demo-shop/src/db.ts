export type Row = { id: string; orgId: string; [k: string]: unknown };

const tables: Record<string, Row[]> = {
  customers: [
    { id: 'c1', orgId: 'acme', name: 'Ada' },
    { id: 'c2', orgId: 'acme', name: 'Bo' },
    { id: 'c3', orgId: 'globex', name: 'Cy' },
  ],
  orders: [
    { id: 'o1', orgId: 'acme', customerId: 'c1', total: 120 },
    { id: 'o2', orgId: 'globex', customerId: 'c3', total: 80 },
  ],
};

/** Tenant-scoped access. Routes must only ever use this. */
export function scoped(orgId: string) {
  return {
    list: (table: string) => (tables[table] ?? []).filter((r) => r.orgId === orgId),
    get: (table: string, id: string) => (tables[table] ?? []).find((r) => r.orgId === orgId && r.id === id) ?? null,
  };
}

/** Unscoped access for admin scripts ONLY. Never import this from src/routes. */
export function raw(table: string): Row[] {
  return tables[table] ?? [];
}

export const db = { scoped, raw };
