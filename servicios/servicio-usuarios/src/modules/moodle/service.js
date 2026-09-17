'use strict';
// Lógica de sincronización con Moodle (completaciones y cursos).
// Usada por los schedulers (app.js), el webhook de course-event y las rutas admin de Moodle.
const pool = require('../../db/pool');
// WS de Moodle vía microservicio servicio-moodle (cliente HTTP fino).
const moodleService = require('../../integrations/moodle');

/**
 * Trae filas ENROLLED/COURSE_COMPLETED de `tableName` (activations o
 * activation_child_enrollments — ambas tienen course_id, moodle_user_id,
 * moodle_status, moodle_completion_synced_at) pendientes de re-chequear.
 */
async function fetchPendingCompletionRows(tableName, minInterval, params) {
  const whereExtra = minInterval
    ? `AND (t.moodle_completion_synced_at IS NULL OR t.moodle_completion_synced_at < $1)`
    : '';
  return pool.query(
    `SELECT t.id, t.moodle_user_id, t.moodle_status, c.moodle_course_id
     FROM ${tableName} t
     JOIN courses c ON c.id = t.course_id
     WHERE t.moodle_status IN ('ENROLLED', 'COURSE_COMPLETED')
       AND t.moodle_user_id IS NOT NULL
       AND c.moodle_course_id IS NOT NULL
       ${whereExtra}
     ORDER BY t.id`,
    params
  );
}

/**
 * Aplica a una fila de `tableName` el mismo criterio de completado:
 *  - aprobó el quiz → COMPLETED
 *  - vio el contenido (actividad 'page') → COURSE_COMPLETED
 * No asume que un curso "hijo" (Content/Simulator) solo tiene una page: en la
 * práctica algunos ya traen su propio examen real (cursos que el cliente
 * unificó sin cambiarles el nombre), así que se revisa igual que el padre.
 */
async function applyCompletionCheck(tableName, row, result) {
  result.checked++;

  // ── Nivel 2: ¿aprobó el quiz? → COMPLETED ──────────────────────────────
  const quizResult = await moodleService.getCourseQuizzes(row.moodle_course_id);
  if (!quizResult.error && quizResult.quizzes.length > 0) {
    const quiz = quizResult.quizzes[0];
    const gradeResult = await moodleService.getUserQuizBestGrade(row.moodle_user_id, quiz.id, 60);

    if (gradeResult.error) {
      result.errors++;
      await pool.query(`UPDATE ${tableName} SET moodle_completion_synced_at=NOW() WHERE id=$1`, [row.id]);
      return;
    }

    if (gradeResult.passed) {
      result.completed++;
      await pool.query(
        `UPDATE ${tableName}
         SET moodle_status='COMPLETED',
             moodle_completed_at=NOW(),
             moodle_completion_synced_at=NOW()
         WHERE id=$1`,
        [row.id]
      );
      return;
    }
  }

  // ── Nivel 1: ¿vio el contenido del curso? → COURSE_COMPLETED ───────────
  if (row.moodle_status === 'ENROLLED') {
    const activitiesResult = await moodleService.getActivitiesCompletion(row.moodle_user_id, row.moodle_course_id);

    if (activitiesResult.error) {
      result.errors++;
      await pool.query(`UPDATE ${tableName} SET moodle_completion_synced_at=NOW() WHERE id=$1`, [row.id]);
      return;
    }

    const pageCompleted = activitiesResult.activities.some(a => a.modname === 'page' && a.state >= 1);

    if (pageCompleted) {
      result.course_completed++;
      await pool.query(
        `UPDATE ${tableName} SET moodle_status='COURSE_COMPLETED', moodle_completion_synced_at=NOW() WHERE id=$1`,
        [row.id]
      );
      return;
    }
  }

  result.skipped++;
  await pool.query(`UPDATE ${tableName} SET moodle_completion_synced_at=NOW() WHERE id=$1`, [row.id]);
}

/**
 * Revisa activaciones ENROLLED/COURSE_COMPLETED (padre) Y sus hijos del fan-out
 * de jerarquía (Content/Simulator) y avanza el estado de cada uno según Moodle.
 * Seguro para correr concurrentemente — usa moodle_completion_synced_at para no martillar.
 */
async function syncMoodleCompletions({ force = false } = {}) {
  const result = { checked: 0, course_completed: 0, completed: 0, errors: 0, skipped: 0 };

  const minInterval = force ? null : new Date(Date.now() - 4 * 60 * 60 * 1000);
  const params = minInterval ? [minInterval] : [];

  const parentRows = await fetchPendingCompletionRows('activations', minInterval, params);
  for (const row of parentRows.rows) {
    await applyCompletionCheck('activations', row, result);
  }

  const childRows = await fetchPendingCompletionRows('activation_child_enrollments', minInterval, params);
  for (const row of childRows.rows) {
    await applyCompletionCheck('activation_child_enrollments', row, result);
  }

  return result;
}

// Sincroniza los cursos de Moodle hacia la tabla courses (crea/actualiza/desactiva).
async function syncMoodleCourses() {
  const result = await moodleService.getCourses();
  if (result.error) return { ok: false, error: result.error };

  const created = [], updated = [], deactivated = [], skipped = [];
  const activeMoodleIds = new Set();

  for (const mc of result.courses) {
    if (!mc.visible) { skipped.push({ moodle_id: mc.id, reason: 'hidden' }); continue; }
    const name = (mc.fullname || mc.shortname || '').trim();
    if (!name) { skipped.push({ moodle_id: mc.id, reason: 'no_name' }); continue; }
    activeMoodleIds.add(mc.id);

    const lang = mc.lang || null;
    const existing = await pool.query(
      'SELECT id, name, active, lang FROM courses WHERE moodle_course_id = $1', [mc.id]
    );

    if (existing.rowCount > 0) {
      const row = existing.rows[0];
      const nameChanged   = row.name !== name;
      const langChanged   = row.lang !== lang;
      const needsActivate = !row.active;
      if (nameChanged || langChanged || needsActivate) {
        await pool.query('UPDATE courses SET name=$1, lang=$2, active=TRUE, updated_at=NOW() WHERE moodle_course_id=$3', [name, lang, mc.id]);
        updated.push({ moodle_id: mc.id, name, reactivated: needsActivate });
      } else {
        skipped.push({ moodle_id: mc.id, reason: 'unchanged' });
      }
    } else {
      // Reconciliación por nombre: si ya existe un curso con ese nombre SIN vínculo a
      // Moodle (los que siembra ensureDefaultCatalogAndCourses en initDb), lo "adoptamos"
      // asignándole el moodle_course_id en vez de crear un duplicado. Evita que la app
      // muestre dos veces el mismo curso (uno matriculable y otro "fantasma" no enrolable).
      const orphan = await pool.query(
        'SELECT id FROM courses WHERE LOWER(name) = LOWER($1) AND moodle_course_id IS NULL ORDER BY id LIMIT 1',
        [name]
      );
      if (orphan.rowCount > 0) {
        await pool.query(
          'UPDATE courses SET moodle_course_id=$1, lang=$2, active=TRUE, updated_at=NOW() WHERE id=$3',
          [mc.id, lang, orphan.rows[0].id]
        );
        updated.push({ id: orphan.rows[0].id, moodle_id: mc.id, name, linked: true });
      } else {
        const ins = await pool.query(
          'INSERT INTO courses (name, moodle_course_id, lang, active) VALUES ($1,$2,$3,TRUE) RETURNING id',
          [name, mc.id, lang]
        );
        created.push({ id: ins.rows[0].id, moodle_id: mc.id, name });
      }
    }
  }

  // Desactiva cursos vinculados a Moodle que ya no existen allí (los manuales no se tocan).
  const linkedCourses = await pool.query(
    'SELECT id, name, moodle_course_id FROM courses WHERE moodle_course_id IS NOT NULL AND active = TRUE'
  );
  for (const c of linkedCourses.rows) {
    if (!activeMoodleIds.has(c.moodle_course_id)) {
      await pool.query('UPDATE courses SET active=FALSE, updated_at=NOW() WHERE id=$1', [c.id]);
      deactivated.push({ id: c.id, moodle_id: c.moodle_course_id, name: c.name });
    }
  }

  return { ok: true, created, updated, deactivated, skipped, total_moodle: result.courses.length };
}

module.exports = { syncMoodleCompletions, syncMoodleCourses };
