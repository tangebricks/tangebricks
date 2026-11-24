# Data Privacy & GDPR Toolkit (`@poc/data-privacy-gdpr`)

The Data Privacy & GDPR brick provides end-to-end data privacy governance, GDPR Article 17 Right to Erasure cascade deletion, Article 20 personal data portability exports, consent tracking, and tenant workspace offboarding.

## Manifest Contract: `privacy`

Every brick shipping tenant database tables (`workspace_id`) must declare its privacy and erasure handling in `brick.manifest.json`:

```json
{
  "privacy": {
    "tables": {
      "example_items": {
        "subject": "workspace",
        "erase": "delete",
        "export": true
      },
      "user_records": {
        "subject": "user",
        "userColumn": "user_id",
        "erase": "delete",
        "export": true
      },
      "audit_logs": {
        "subject": "user",
        "userColumn": "actor_id",
        "erase": "retain",
        "retainReason": "Legal compliance audit trail requirement",
        "export": true
      }
    },
    "hookTables": ["custom_managed_table"]
  },
  "worker": {
    "privacy": {
      "exportTenant": "exportTenantHook",
      "eraseTenant": "eraseTenantHook"
    }
  }
}
```

### Table Properties
- **`subject`**: `"workspace" | "user"`. Indicates whether rows belong to a workspace entity or an individual user.
- **`userColumn`**: Column name storing the user identifier (required when `subject` is `"user"` for per-user queries).
- **`erase`**: `"delete" | "anonymize" | "retain"`.
  - `"delete"`: Rows are deleted during erasure.
  - `"anonymize"`: Specified columns in `anonymize: string[]` are cleared / nullified.
  - `"retain"`: Rows are preserved during erasure, requiring a documented `retainReason`.
- **`export`**: `boolean`. Whether rows from this table are included in GDPR Article 20 data export archives.

## Generated Privacy Operations (`src/privacy.generated.ts`)

During project assembly, `@poc/assembler` statically inspects every mounted brick migration and declared entity table, verifying full privacy coverage. It emits `src/privacy.generated.ts` containing:

- **`exportTenant(db, subject)`**: Iterates all covered tables with `export: true`, selecting user rows (or all workspace rows for workspace export), invokes any custom `worker.privacy.exportTenant` hooks, and returns a document keyed by table name.
- **`eraseTenant(db, subject)`**: Iterates covered tables in reverse topological dependency order to avoid foreign key conflicts. Builds atomic `DELETE` statements inside `db.batch()`, skips and records `retain` tables with reasons, and invokes any custom `worker.privacy.eraseTenant` hooks.

## REST Endpoints

### 1. User Consents
- `POST /api/privacy/consents`: Update user consent preferences (e.g. cookie categories: `necessary`, `analytics`, `marketing`, `preferences`).
- `GET /api/privacy/consents`: Retrieve user consent status.

### 2. GDPR Article 20 Data Export
- `POST /api/privacy/export`: Triggers personal data export across all user-subject tables.
- `GET /api/privacy/export/:id`: Retrieve exported data archive keyed by table name.

### 3. GDPR Article 17 Right to Erasure
- `POST /api/privacy/erasure`: Executes user erasure across all `user`-subject tables (except `retain` tables), resets consents, and purges export history.
- `GET /api/privacy/erasure/:id`: Retrieve erasure request audit record.

### 4. Tenant Workspace Offboarding
- `DELETE /api/privacy/workspace`: Owner-only workspace erasure. Purges all non-`retain` tables with `workspace_id = ?` in atomic batches and returns the list of retained tables with reasons. Refuses non-owner callers with `403 Forbidden`.
