import { EntityDefinitionSchema, toSdkEntity } from "@poc/blueprint";
import { columnDefinitions } from "@poc/sdk";

// The ADD COLUMN statements a deploy plan adds when a deployed entity gains a field (or a field becomes money). The table
// name is written as the evolution code has always written it.

/**
 * The SDK column definitions (type and CHECK) of a date, longtext, relation or money field; null for the other types,
 * which keep their existing mapping.
 */
function sdkColumnDefinitions(entityName: string, field: { name: string; type: string }): string[] | null {
  if (!["date", "longtext", "relation", "money"].includes(field.type)) return null;
  const declared = EntityDefinitionSchema.safeParse({ name: entityName, workspaceScoped: true, fields: [field] });
  if (!declared.success) return null;
  try {
    return columnDefinitions(toSdkEntity(declared.data).fields[0]!);
  } catch {
    return null;
  }
}

/** One `{column, sql}` per column to add for `currField`, given the deployed field of the same name (if any). */
export function entityAddColumnStatements(
  entityName: string,
  prevField: { name: string; type: string } | undefined,
  currField: { name: string; type: string },
): Array<{ column: string; sql: string }> {
  const add = (definition: string) => ({
    column: /^"([^"]+)"/.exec(definition)?.[1] ?? currField.name,
    sql: `ALTER TABLE ${entityName} ADD COLUMN ${definition};`,
  });
  if (prevField) {
    // A field that becomes money gains its currency column (the amount column is already there).
    if (currField.type !== "money" || prevField.type === "money") return [];
    const currency = sdkColumnDefinitions(entityName, currField)?.[1];
    return currency ? [add(currency)] : [];
  }
  const definitions = sdkColumnDefinitions(entityName, currField);
  // date, longtext, relation and money: the same type and CHECK a new table gets (money is two columns).
  if (definitions) return definitions.map(add);
  const addType = currField.type === "number" ? "REAL" : currField.type === "integer" || currField.type === "boolean" ? "INTEGER" : "TEXT";
  return [{ column: currField.name, sql: `ALTER TABLE ${entityName} ADD COLUMN ${currField.name} ${addType};` }];
}
