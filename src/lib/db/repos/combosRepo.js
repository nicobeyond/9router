import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function rowToCombo(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    models: parseJson(row.models, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getCombos() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM combos ORDER BY createdAt ASC`);
  return rows.map(rowToCombo);
}

export async function getComboById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
  return rowToCombo(row);
}

export async function getComboByName(name) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE name = ?`, [name]);
  return rowToCombo(row);
}

export async function createCombo(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const combo = {
    id: uuidv4(),
    name: data.name,
    kind: data.kind || null,
    models: data.models || [],
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
    [combo.id, combo.name, combo.kind, stringifyJson(combo.models), combo.createdAt, combo.updatedAt]
  );
  return combo;
}

export async function updateCombo(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToCombo(row), ...data, updatedAt: new Date().toISOString() };
    db.run(
      `UPDATE combos SET name = ?, kind = ?, models = ?, updatedAt = ? WHERE id = ?`,
      [merged.name, merged.kind, stringifyJson(merged.models || []), merged.updatedAt, id]
    );
    result = merged;
  });
  return result;
}

export async function deleteCombo(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM combos WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

/**
 * Remove models belonging to the given prefixes/providerIds from ALL combos.
 * Called when a custom provider connection is deleted or disabled so combos
 * stop referencing it (and stop trying it during fallback rotation).
 * A combo model is either "<prefix>/<model>" or "<providerId>/<model>"; both
 * share the same leading token, which is matched against `prefixes`.
 * @param {string[]} prefixes - node prefixes and/or raw providerIds to purge
 * @returns {number} number of combos modified
 */
export async function removeComboModelsByPrefixes(prefixes) {
  const set = new Set((prefixes || []).filter((p) => typeof p === "string" && p.length > 0));
  if (set.size === 0) return 0;
  const db = await getAdapter();
  let affected = 0;
  db.transaction(() => {
    const rows = db.all(`SELECT * FROM combos`);
    for (const row of rows) {
      const combo = rowToCombo(row);
      const before = combo.models.length;
      combo.models = combo.models.filter((m) => {
        if (typeof m !== "string") return true;
        return !set.has(m.split("/")[0]);
      });
      if (combo.models.length !== before) {
        db.run(
          `UPDATE combos SET models = ?, updatedAt = ? WHERE id = ?`,
          [stringifyJson(combo.models), new Date().toISOString(), combo.id]
        );
        affected++;
      }
    }
  });
  return affected;
}
