'use strict';
// Nombre de grupo de Moodle del partner (partners.group_name).
// Único sin distinguir mayúsculas (índice idx_partners_group_name_ci en initDb).
// Acepta un pool o un client de pg, ambos tienen .query().

async function isGroupNameTaken(db, groupName, excludePartnerId = null) {
  const r = await db.query(
    'SELECT id FROM partners WHERE LOWER(group_name)=LOWER($1) AND ($2::int IS NULL OR id<>$2) LIMIT 1',
    [groupName, excludePartnerId]
  );
  return r.rowCount > 0;
}

module.exports = { isGroupNameTaken };
