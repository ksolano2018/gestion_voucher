'use strict';
// Módulo Courses: catálogo de cursos/certificaciones (tabla courses) y catalogs.
const express = require('express');
const { body, param } = require('express-validator');
const router = express.Router();
const pool = require('../../db/pool');
const { authenticate, requireRole, requirePermission } = require('../../lib/auth');
const { apiLimiter } = require('../../lib/rateLimit');
const { handleValidationErrors } = require('../../lib/validation');
const { logSystemEvent } = require('../../lib/audit');

// Admin: courses CRUD
router.get('/admin/courses', authenticate, requirePermission('courses', 'view'), apiLimiter, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, COALESCE(active, TRUE) AS active, created_at, updated_at FROM courses ORDER BY name ASC');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Error al obtener cursos' });
  }
});

router.post('/admin/courses',
  authenticate,
  requireRole('admin'),
  apiLimiter,
  body('name').trim().isLength({ min: 2, max: 200 }).withMessage('Nombre de curso inválido (2-200 caracteres)'),
  handleValidationErrors,
  async (req, res) => {
    const name = String(req.body.name || '').trim();
    try {
      const duplicate = await pool.query('SELECT id FROM courses WHERE LOWER(name)=LOWER($1)', [name]);
      if (duplicate.rowCount > 0) {
        return res.status(409).json({ error: 'Ya existe un curso con ese nombre' });
      }

      const created = await pool.query(
        'INSERT INTO courses (name, active) VALUES ($1, TRUE) RETURNING id, name, COALESCE(active, TRUE) AS active, created_at',
        [name]
      );
      await logSystemEvent('COURSE_CREATED', 'COURSE_MANAGEMENT', req.user.sub, null, null, {
        course_id: created.rows[0].id,
        name: created.rows[0].name
      }, 'SUCCESS', null, req);
      res.status(201).json(created.rows[0]);
    } catch (e) {
      await logSystemEvent('COURSE_CREATE_ERROR', 'COURSE_MANAGEMENT', req.user.sub, null, null, { name }, 'FAILED', e.message, req);
      res.status(500).json({ error: 'Error al crear curso' });
    }
  }
);

router.put('/admin/courses/:id',
  authenticate,
  requireRole('admin'),
  apiLimiter,
  param('id').isInt({ min: 1 }).withMessage('ID de curso inválido'),
  body('name').trim().isLength({ min: 2, max: 200 }).withMessage('Nombre de curso inválido (2-200 caracteres)'),
  handleValidationErrors,
  async (req, res) => {
    const courseId = parseInt(req.params.id, 10);
    const name = String(req.body.name || '').trim();
    try {
      const duplicate = await pool.query('SELECT id FROM courses WHERE LOWER(name)=LOWER($1) AND id<>$2', [name, courseId]);
      if (duplicate.rowCount > 0) {
        return res.status(409).json({ error: 'Ya existe un curso con ese nombre' });
      }

      const updated = await pool.query(
        'UPDATE courses SET name=$1, updated_at=NOW() WHERE id=$2 RETURNING id, name, COALESCE(active, TRUE) AS active, created_at, updated_at',
        [name, courseId]
      );

      if (updated.rowCount === 0) {
        return res.status(404).json({ error: 'Curso no encontrado' });
      }

      await logSystemEvent('COURSE_UPDATED', 'COURSE_MANAGEMENT', req.user.sub, null, null, {
        course_id: courseId,
        name
      }, 'SUCCESS', null, req);
      res.json(updated.rows[0]);
    } catch (e) {
      await logSystemEvent('COURSE_UPDATE_ERROR', 'COURSE_MANAGEMENT', req.user.sub, null, null, { course_id: courseId, name }, 'FAILED', e.message, req);
      res.status(500).json({ error: 'Error al actualizar curso' });
    }
  }
);

router.patch('/admin/courses/:id/status',
  authenticate,
  requireRole('admin'),
  apiLimiter,
  param('id').isInt({ min: 1 }).withMessage('ID de curso inválido'),
  body('active').isBoolean().withMessage('Estado inválido'),
  handleValidationErrors,
  async (req, res) => {
    const courseId = parseInt(req.params.id, 10);
    const active = req.body.active === true || req.body.active === 'true';
    try {
      const updated = await pool.query(
        'UPDATE courses SET active=$1, updated_at=NOW() WHERE id=$2 RETURNING id, name, COALESCE(active, TRUE) AS active, created_at, updated_at',
        [active, courseId]
      );

      if (updated.rowCount === 0) {
        return res.status(404).json({ error: 'Curso no encontrado' });
      }

      await logSystemEvent('COURSE_STATUS_UPDATED', 'COURSE_MANAGEMENT', req.user.sub, null, null, {
        course_id: courseId,
        active
      }, 'SUCCESS', null, req);
      res.json(updated.rows[0]);
    } catch (e) {
      await logSystemEvent('COURSE_STATUS_UPDATE_ERROR', 'COURSE_MANAGEMENT', req.user.sub, null, null, { course_id: courseId, active }, 'FAILED', e.message, req);
      res.status(500).json({ error: 'Error al actualizar estado del curso' });
    }
  }
);

router.delete('/admin/courses/:id',
  authenticate,
  requireRole('admin'),
  apiLimiter,
  param('id').isInt({ min: 1 }).withMessage('ID de curso inválido'),
  handleValidationErrors,
  async (req, res) => {
    const courseId = parseInt(req.params.id, 10);
    try {
      const deleted = await pool.query('DELETE FROM courses WHERE id=$1 RETURNING id', [courseId]);
      if (deleted.rowCount === 0) {
        return res.status(404).json({ error: 'Curso no encontrado' });
      }
      await logSystemEvent('COURSE_DELETED', 'COURSE_MANAGEMENT', req.user.sub, null, null, {
        course_id: courseId
      }, 'SUCCESS', null, req);
      res.json({ ok: true, id: courseId });
    } catch (e) {
      if (e && e.code === '23503') {
        await logSystemEvent('COURSE_DELETE_ERROR', 'COURSE_MANAGEMENT', req.user.sub, null, null, { course_id: courseId }, 'FAILED', 'Curso con dependencias', req);
        return res.status(409).json({ error: 'No se puede eliminar: el curso tiene activaciones o vouchers asociados' });
      }
      await logSystemEvent('COURSE_DELETE_ERROR', 'COURSE_MANAGEMENT', req.user.sub, null, null, { course_id: courseId }, 'FAILED', e.message, req);
      res.status(500).json({ error: 'Error al eliminar curso' });
    }
  }
);

// Partner: cursos activos disponibles
router.get('/partner/:id/courses', authenticate, apiLimiter, async (req, res) => {
  const pid = req.params.id;
  if (req.user && req.user.role !== 'admin') {
    if (!req.user.partner_id || String(req.user.partner_id) !== String(pid)) {
      return res.status(403).json({ error: 'forbidden' });
    }
  }

  try {
    const courses = await pool.query('SELECT id, name FROM courses WHERE COALESCE(active, TRUE)=TRUE ORDER BY name ASC');
    res.json(courses.rows);
  } catch (e) {
    res.status(400).json({ error: 'Error al obtener cursos' });
  }
});

// Catálogo público
router.get('/catalogs', async (req, res) => {
  const r = await pool.query('SELECT * FROM catalogs');
  res.json(r.rows);
});

module.exports = router;
