'use strict';
// Lógica de sincronización con Moodle (completaciones y cursos).
// Usada por los schedulers (app.js), el webhook de course-event y las rutas admin de Moodle.
const pool = require('../../db/pool');
const moodleService = require('../../../moodle-service');

/**
 * Revisa activaciones ENROLLED/COURSE_COMPLETED y avanza su estado según Moodle:
 *  - aprobó el quiz → COMPLETED
 *  - vio el contenido (actividad 'page') → COURSE_COMPLETED
 * Seguro para correr concurrentemente — usa moodle_completion_synced_at para no martillar.
 */
async function syncMoodleCompletions({ force = false } = {}) {
  const result = { checked: 0, course_completed: 0, completed: 0, errors: 0, skipped: 0 };

  const minInterval = force ? null : new Date(Date.now() - 4 * 60 * 60 * 1000);
  const params = [];
  let whereExtra = '';
  if (minInterval) {
    params.push(minInterval);
    whereExtra = `AND (a.moodle_completion_synced_at IS NULL OR a.moodle_completion_synced_at < $1)`;
  }

  const rows = await pool.query(
    `SELECT a.id, a.moodle_user_id, a.moodle_status, c.moodle_course_id
     FROM activations a
     JOIN courses c ON c.id = a.course_id
     WHERE a.moodle_status IN ('ENROLLED', 'COURSE_COMPLETED')
       AND a.moodle_user_id IS NOT NULL
       AND c.moodle_course_id IS NOT NULL
       ${whereExtra}
     ORDER BY a.id`,
    params
  );

  for (const act of rows.rows) {
    result.checked++;

    // ── Nivel 2: ¿aprobó el quiz? → COMPLETED ──────────────────────────────
    const quizResult = await moodleService.getCourseQuizzes(act.moodle_course_id);
    if (!quizResult.error && quizResult.quizzes.length > 0) {
      const quiz      = quizResult.quizzes[0];
      const gradeResult = await moodleService.getUserQuizBestGrade(
        act.moodle_user_id, quiz.id, 60
      );

      if (gradeResult.error) {
        result.errors++;
        await pool.query(`UPDATE activations SET moodle_completion_synced_at=NOW() WHERE id=$1`, [act.id]);
        continue;
      }

      if (gradeResult.passed) {
        result.completed++;
        await pool.query(
          `UPDATE activations
           SET moodle_status='COMPLETED',
               moodle_completed_at=NOW(),
               moodle_completion_synced_at=NOW()
           WHERE id=$1`,
          [act.id]
        );
        continue;
      }
    }

    // ── Nivel 1: ¿vio el contenido del curso? → COURSE_COMPLETED ───────────
    if (act.moodle_status === 'ENROLLED') {
      const activitiesResult = await moodleService.getActivitiesCompletion(
        act.moodle_user_id, act.moodle_course_id
      );

      if (activitiesResult.error) {
        result.errors++;
        await pool.query(`UPDATE activations SET moodle_completion_synced_at=NOW() WHERE id=$1`, [act.id]);
        continue;
      }

      const pageCompleted = activitiesResult.activities.some(
        a => a.modname === 'page' && a.state >= 1
      );

      if (pageCompleted) {
        result.course_completed++;
        await pool.query(
          `UPDATE activations
           SET moodle_status='COURSE_COMPLETED',
               moodle_completion_synced_at=NOW()
           WHERE id=$1`,
          [act.id]
        );
        continue;
      }
    }

    result.skipped++;
    await pool.query(`UPDATE activations SET moodle_completion_synced_at=NOW() WHERE id=$1`, [act.id]);
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

    const existing = await pool.query(
      'SELECT id, name, active FROM courses WHERE moodle_course_id = $1', [mc.id]
    );

    if (existing.rowCount > 0) {
      const row = existing.rows[0];
      const nameChanged   = row.name !== name;
      const needsActivate = !row.active;
      if (nameChanged || needsActivate) {
        await pool.query('UPDATE courses SET name=$1, active=TRUE, updated_at=NOW() WHERE moodle_course_id=$2', [name, mc.id]);
        updated.push({ moodle_id: mc.id, name, reactivated: needsActivate });
      } else {
        skipped.push({ moodle_id: mc.id, reason: 'unchanged' });
      }
    } else {
      const ins = await pool.query(
        'INSERT INTO courses (name, moodle_course_id, active) VALUES ($1,$2,TRUE) RETURNING id',
        [name, mc.id]
      );
      created.push({ id: ins.rows[0].id, moodle_id: mc.id, name });
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
