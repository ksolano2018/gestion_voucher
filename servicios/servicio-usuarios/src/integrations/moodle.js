'use strict';
// Cliente del microservicio servicio-moodle (adaptador del WS de Moodle).
// Expone los MISMOS nombres/firmas que el antiguo moodle-service.js local, así los
// call-sites (activación, schedulers, módulo moodle) cambian solo el require.
// Igual que el wrapper original: estas funciones NUNCA lanzan; devuelven un objeto
// de resultado (con `error` si algo falla), para no romper el flujo de negocio.
const MOODLE_SERVICE_URL = (process.env.MOODLE_SERVICE_URL || 'http://servicio-moodle:8084').replace(/\/$/, '');
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || '';

// isMockMode se resuelve localmente por env (sin llamada de red): lo usan los
// schedulers (para saltarse el sync) y la activación (flag mock_mode en logs).
// servicio-moodle lee el mismo MOODLE_MOCK, así que ambos coinciden.
function isMockMode() {
  return process.env.MOODLE_MOCK === 'true';
}

async function request(path, { method = 'GET', body } = {}) {
  try {
    const headers = {};
    if (INTERNAL_API_TOKEN) headers['x-internal-token'] = INTERNAL_API_TOKEN;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const resp = await fetch(`${MOODLE_SERVICE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      return { error: `servicio-moodle respondió ${resp.status}${detail ? ': ' + detail : ''}` };
    }
    return await resp.json().catch(() => ({ error: 'respuesta no-JSON de servicio-moodle' }));
  } catch (e) {
    return { error: `Error llamando a servicio-moodle: ${e.message}` };
  }
}

async function enrollStudent(args = {}) {
  return request('/internal/enroll', { method: 'POST', body: args });
}

async function testConnection() {
  return request('/internal/test-connection');
}

async function getCourses() {
  return request('/internal/courses');
}

async function getCourseQuizzes(moodleCourseId) {
  return request(`/internal/course-quizzes/${encodeURIComponent(moodleCourseId)}`);
}

async function getUserQuizBestGrade(moodleUserId, quizId, gradepass = 60) {
  const qs = new URLSearchParams({ moodleUserId: String(moodleUserId), quizId: String(quizId), gradepass: String(gradepass) });
  return request(`/internal/quiz-grade?${qs.toString()}`);
}

async function getActivitiesCompletion(moodleUserId, moodleCourseId) {
  const qs = new URLSearchParams({ moodleUserId: String(moodleUserId), moodleCourseId: String(moodleCourseId) });
  return request(`/internal/activities-completion?${qs.toString()}`);
}

module.exports = {
  isMockMode,
  enrollStudent,
  testConnection,
  getCourses,
  getCourseQuizzes,
  getUserQuizBestGrade,
  getActivitiesCompletion,
};
