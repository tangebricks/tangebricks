# Entities: field types, relations and money

A project declares its own tables as entities. One declaration drives everything: the migration the assembler writes
(`entityDdl` in `@poc/sdk`), the validation and SQL of the deployed router (`@poc/dynamic-entities`), the OpenAPI
document, and what the MCP tool `define_entity` and the blueprint ops `add_entity` / `update_entity` accept. Every value
is checked twice: by the router's schema before it reaches the database, and by a CHECK constraint in the table.

```json
{
  "name": "invoice",
  "fields": [
    { "name": "customer_id", "type": "relation", "relation": "customer", "required": true },
    { "name": "due_on", "type": "date" },
    { "name": "total", "type": "money", "currencies": ["INR", "USD"] },
    { "name": "notes", "type": "longtext", "maxLength": 50000 }
  ]
}
```

Entity and field names are `snake_case` (`^[a-z][a-z0-9_]{0,39}$`). `id`, `workspace_id`, `created_at`, `updated_at`,
`rowid`, `oid` and `_rowid_` are taken by the system. Every row belongs to one workspace.

## Field types

| Type | Options | A client sends and receives | Stored as |
|---|---|---|---|
| `text` | `maxLength` 1-10 000 (default 500) | a string | `TEXT`, length checked |
| `longtext` | `maxLength` 1-100 000 (default 20 000) | a string | `TEXT`, length checked |
| `number` | `min`, `max` (integers) | a whole number | `INTEGER`, bounds checked |
| `boolean` | | `true` / `false` | `INTEGER` 0 or 1 |
| `enum` | `values`: 1-20 of `^[a-z0-9_]{1,40}$` | one of the values | `TEXT IN (...)` |
| `date` | | `"YYYY-MM-DD"`, a real calendar date | `TEXT`, `CHECK (x IS date(x))` |
| `money` | `currencies`: 1-20 ISO-4217 codes (`^[A-Z]{3}$`) | `{"amount": 1999, "currency": "INR"}` or `null` | two columns (below) |
| `relation` | `relation`: the target entity's name | the `id` of a row of that entity | `TEXT`, 36 characters |

Every type takes `required` (default `false`). An optional field may be sent as `null` or left out.

The blueprint also accepts `string` (as `text`), `integer` (as `number`), `json` and `datetime` (both stored as length-checked
text). They deploy exactly as before.

## Relations

A relation field points at another entity declared in the same project (or at its own entity). The one key is `relation`:

```json
{ "name": "customer_id", "type": "relation", "relation": "customer" }
```

- The target must be declared in the project. A relation to an undeclared entity is refused, naming the field and the
  entity. In the blueprint, `"relation": "customer.id"` is also accepted; only the entity part is used.
- `target`, `entity`, `to`, `references` and `targetEntity` are not field keys. Each is refused with a message that says
  to use `relation`, both by `define_entity` and by the blueprint ops.
- A `relation` key on a field of any other type is refused by the blueprint ops (`use type: "relation"`), since it
  would not be enforced.
- On create and update, the router checks that the id is a UUID and that a row with that id exists in the target entity's
  table **in the same workspace**. An id from another workspace, an id of a row of another entity, or an id that does not
  exist gets `400 VALIDATION_ERROR` naming the field.
- There is no SQL foreign key: deleting a referenced row stays allowed, and nothing cascades. Relations never cross
  workspaces.
- A batch of blueprint ops is checked as a whole, so it may add an entity before the entity it relates to, or two entities
  that relate to each other. Removing an entity that another one still relates to is refused.

## Money

A `money` value is `{amount, currency}`: `amount` is an integer in the currency's minor units (1999 for 19.99), and
`currency` is one of the field's declared `currencies`. A fractional amount, an undeclared currency or a bare number is
refused with `400 VALIDATION_ERROR`.

A money field `total` is stored in two columns: `total` (`INTEGER`) and `total__currency` (`TEXT`, `IN` the declared
currencies). The table checks that both are set or both are empty. Because of that second column, a field named
`total__currency` next to a money field `total` is refused, and a money field counts as two columns towards the D1 limit of
100 bound parameters per statement.
