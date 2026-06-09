'use strict';

/**
 * Mock Moodle Web Services REST server para desarrollo local.
 *
 * Simula los 3 endpoints WS que usa la plataforma:
 *   - core_user_get_users_by_field
 *   - core_user_create_users
 *   - enrol_manual_enrol_users
 *
 * Uso: node server.js  (puerto 8082)
 */

const express = require('express');
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Almacén en memoria: email → { id, username, firstname, lastname }
const usersByEmail = new Map();
// courseId → Set de userIds
const enrollments  = new Map();
// Completaciones manuales: `${courseId}:${userId}` → unixTimestamp
const completions  = new Map();
let userIdCounter  = 5000;

// Course IDs que simulan errores específicos de Moodle
// Mapeados a moodle_course_id 901 y 902 en la BD de prueba
const FAIL_COURSES = {
  901: { errorcode: 'courseidnotfound',    message: 'Course id not found: el curso no existe en Moodle' },
  902: { errorcode: 'enrolmentalreadyexists', message: 'Enrolment already exists: el usuario ya estaba matriculado (conflicto)' }
};

// Course IDs 800-899: reportan completación automáticamente (para pruebas)
const AUTO_COMPLETE_MIN = 800;
const AUTO_COMPLETE_MAX = 899;

function log(msg) {
  console.log(`[${new Date().toISOString()}] [MOODLE-MOCK] ${msg}`);
}

app.post('/webservice/rest/server.php', (req, res) => {
  const params = req.body;
  const { wsfunction } = params;

  // ── core_user_get_users_by_field ───────────────────────────────────────────
  if (wsfunction === 'core_user_get_users_by_field') {
    const field = params.field;
    // Express extended:true convierte values[0] en params.values[0] (array anidado)
    const value = params.values ? params.values[0] : params['values[0]'];

    if (field !== 'email') {
      return res.json({ exception: 'invalid_parameter_exception', errorcode: 'invalidfield', message: `Field '${field}' not supported in mock` });
    }

    const user = usersByEmail.get((value || '').toLowerCase());
    if (user) {
      log(`core_user_get_users_by_field email=${value} → found id=${user.id}`);
      return res.json([{ id: user.id, username: user.username, email: value, firstname: user.firstname, lastname: user.lastname }]);
    }
    log(`core_user_get_users_by_field email=${value} → not found`);
    return res.json([]);
  }

  // ── core_user_create_users ─────────────────────────────────────────────────
  if (wsfunction === 'core_user_create_users') {
    // Express extended:true convierte users[0][email] en params.users[0].email
    const u0       = params.users ? params.users[0] : null;
    const email    = u0 ? u0.email    : params['users[0][email]'];
    const username = u0 ? u0.username : params['users[0][username]'];
    const firstname = (u0 ? u0.firstname : params['users[0][firstname]']) || '';
    const lastname  = (u0 ? u0.lastname  : params['users[0][lastname]'])  || '';

    if (!email || !username) {
      return res.json({ exception: 'invalid_parameter_exception', errorcode: 'missingparam', message: 'email and username required' });
    }

    const key = email.toLowerCase();
    if (usersByEmail.has(key)) {
      // Moodle devuelve error si el email ya existe
      return res.json({ exception: 'moodle_exception', errorcode: 'emailalreadyexists', message: `Email ${email} already exists` });
    }

    const id = ++userIdCounter;
    usersByEmail.set(key, { id, username, firstname, lastname });
    log(`core_user_create_users email=${email} → created id=${id}`);
    return res.json([{ id, username }]);
  }

  // ── enrol_manual_enrol_users ───────────────────────────────────────────────
  if (wsfunction === 'enrol_manual_enrol_users') {
    // Express extended:true convierte enrolments[0][userid] en params.enrolments[0].userid
    const e0      = params.enrolments ? params.enrolments[0] : null;
    const userId   = parseInt(e0 ? e0.userid   : params['enrolments[0][userid]'],   10);
    const courseId = parseInt(e0 ? e0.courseid : params['enrolments[0][courseid]'], 10);
    const roleId   = parseInt(e0 ? e0.roleid   : params['enrolments[0][roleid]'],   10);

    if (!userId || !courseId) {
      return res.json({ exception: 'invalid_parameter_exception', errorcode: 'missingparam', message: 'userid and courseid required' });
    }

    // Cursos especiales que simulan errores de Moodle
    if (FAIL_COURSES[courseId]) {
      const err = FAIL_COURSES[courseId];
      log(`enrol_manual_enrol_users courseId=${courseId} → SIMULATED ERROR: ${err.message}`);
      return res.json({ exception: 'moodle_exception', errorcode: err.errorcode, message: err.message });
    }

    if (!enrollments.has(courseId)) enrollments.set(courseId, new Set());
    enrollments.get(courseId).add(userId);
    log(`enrol_manual_enrol_users userId=${userId} courseId=${courseId} roleId=${roleId} → enrolled`);
    // Moodle retorna null en éxito para esta función
    return res.json(null);
  }

  // ── core_completion_get_course_completion_status ───────────────────────────
  if (wsfunction === 'core_completion_get_course_completion_status') {
    const courseId = parseInt(params.courseid, 10);
    const userId   = parseInt(params.userid,   10);

    if (!courseId || !userId) {
      return res.json({ exception: 'invalid_parameter_exception', errorcode: 'missingparam', message: 'courseid and userid required' });
    }

    const key = `${courseId}:${userId}`;
    const autoComplete = courseId >= AUTO_COMPLETE_MIN && courseId <= AUTO_COMPLETE_MAX;
    const manualTs     = completions.get(key);
    const isCompleted  = autoComplete || Boolean(manualTs);
    const timecompleted = isCompleted ? (manualTs || Math.floor(Date.now() / 1000)) : 0;

    log(`core_completion_get_course_completion_status courseId=${courseId} userId=${userId} → completed=${isCompleted}`);
    return res.json({
      completionstatus: {
        id:             isCompleted ? 1 : 0,
        statustext:     isCompleted ? 'Complete' : 'In progress',
        timecompleted
      }
    });
  }

  // ── Estado del mock (útil para depurar) ────────────────────────────────────
  if (wsfunction === 'mock_status') {
    return res.json({
      users:       Array.from(usersByEmail.entries()).map(([email, u]) => ({ email, ...u })),
      enrollments: Array.from(enrollments.entries()).map(([cid, uids]) => ({ courseId: cid, userIds: Array.from(uids) })),
      completions: Array.from(completions.entries()).map(([key, ts]) => ({ key, timecompleted: ts }))
    });
  }

  // ── core_course_get_courses ────────────────────────────────────────────────
  if (wsfunction === 'core_course_get_courses') {
    log('core_course_get_courses → returning mock courses');
    return res.json([
      { id: 1, shortname: 'SITE',   fullname: 'Site', summary: '', visible: 0 },
      { id: 2, shortname: 'JAVA-01', fullname: 'Certificación Java Developer',             summary: 'Curso de Java',  visible: 1 },
      { id: 3, shortname: 'AWS-01',  fullname: 'Certificación AWS Solutions Architect',    summary: '',               visible: 1 },
      { id: 4, shortname: 'PMP-01',  fullname: 'Certificación PMP Project Management',     summary: '',               visible: 1 }
    ]);
  }

  log(`wsfunction desconocida: ${wsfunction}`);
  res.status(400).json({ exception: 'invalid_parameter_exception', errorcode: 'invalidfunction', message: `Unknown wsfunction: ${wsfunction}` });
});

// ─── Endpoints de control del mock (solo desarrollo) ─────────────────────────

// Health check
app.get('/health', (_req, res) => res.json({ ok: true, users: usersByEmail.size }));

// POST /mock/complete — marcar un usuario como completado en un curso
// Body: { courseId, userId }  o  { courseId, email }
app.post('/mock/complete', (req, res) => {
  let { courseId, userId, email } = req.body;
  courseId = parseInt(courseId, 10);

  if (!userId && email) {
    const u = usersByEmail.get((email || '').toLowerCase());
    userId = u ? u.id : null;
  }
  userId = parseInt(userId, 10);

  if (!courseId || !userId) {
    return res.status(400).json({ error: 'courseId y userId (o email) son requeridos' });
  }

  const key = `${courseId}:${userId}`;
  const ts  = Math.floor(Date.now() / 1000);
  completions.set(key, ts);
  log(`/mock/complete courseId=${courseId} userId=${userId} → marcado completado ts=${ts}`);
  res.json({ ok: true, key, timecompleted: ts });
});

// DELETE /mock/complete — desmarcar completación (reset para pruebas)
app.delete('/mock/complete', (req, res) => {
  let { courseId, userId } = req.body;
  courseId = parseInt(courseId, 10);
  userId   = parseInt(userId,   10);
  const key = `${courseId}:${userId}`;
  const deleted = completions.delete(key);
  res.json({ ok: true, deleted, key });
});

const PORT = process.env.PORT || 8082;
app.listen(PORT, () => {
  log(`Mock Moodle WS corriendo en http://0.0.0.0:${PORT}`);
  log('Funciones disponibles: core_user_get_users_by_field, core_user_create_users, enrol_manual_enrol_users');
});
