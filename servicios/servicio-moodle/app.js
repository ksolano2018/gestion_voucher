'use strict';
// Microservicio servicio-moodle (adaptador de Moodle Web Services).
// Extraído de servicio-usuarios: posee TODAS las llamadas al WS de Moodle (vía
// moodle-service.js). servicio-usuarios lo consume por HTTP (cliente fino en
// src/integrations/moodle.js) en lugar de hablar con Moodle directamente.
//
// NO expone puerto al host (solo red interna de Docker) y exige x-internal-token.
// No usa base de datos: es un adaptador puro sobre el WS. La lógica de negocio
// (sync de completaciones/cursos, persistencia en activations/courses) sigue en
// servicio-usuarios, que llama a estos endpoints.
const express = require('express');
const moodle = require('./moodle-service');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 8084;
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || '';

function requireInternalToken(req, res, next) {
  if (!INTERNAL_API_TOKEN) return next(); // sin token configurado: no se exige (dev)
  if (req.get('x-internal-token') === INTERNAL_API_TOKEN) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

app.get('/health', (req, res) => {
  res.json({ status: 'UP', service: 'servicio-moodle', mock: moodle.isMockMode() });
});

// Todas las funciones de moodle-service devuelven un objeto de resultado y NUNCA lanzan,
// así que las exponemos tal cual; el cliente reenvía el JSON a quien la invocó.

// Matrícula del estudiante (crea usuario si no existe + matrícula en curso).
app.post('/internal/enroll', requireInternalToken, async (req, res) => {
  try {
    const result = await moodle.enrollStudent(req.body || {});
    res.json(result);
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Prueba de conexión con Moodle.
app.get('/internal/test-connection', requireInternalToken, async (req, res) => {
  try {
    res.json(await moodle.testConnection());
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Lista de cursos de Moodle.
app.get('/internal/courses', requireInternalToken, async (req, res) => {
  try {
    res.json(await moodle.getCourses());
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Quizzes de un curso.
app.get('/internal/course-quizzes/:moodleCourseId', requireInternalToken, async (req, res) => {
  try {
    res.json(await moodle.getCourseQuizzes(req.params.moodleCourseId));
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Mejor nota de un usuario en un quiz (gradepass opcional).
app.get('/internal/quiz-grade', requireInternalToken, async (req, res) => {
  try {
    const { moodleUserId, quizId, gradepass } = req.query;
    const gp = gradepass !== undefined ? parseInt(gradepass, 10) : undefined;
    res.json(await moodle.getUserQuizBestGrade(moodleUserId, quizId, gp));
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Estado de finalización de actividades de un usuario en un curso.
app.get('/internal/activities-completion', requireInternalToken, async (req, res) => {
  try {
    const { moodleUserId, moodleCourseId } = req.query;
    res.json(await moodle.getActivitiesCompletion(moodleUserId, moodleCourseId));
  } catch (e) {
    res.json({ error: e.message });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✓ servicio-moodle escuchando en puerto: ${PORT} (mock=${moodle.isMockMode()})`);
  });
}

module.exports = { app };
