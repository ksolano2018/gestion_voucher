'use strict';
// Módulo Final Clients: clientes finales de cada partner (tabla partner_final_clients).
const express = require('express');
const { body } = require('express-validator');
const router = express.Router();
const pool = require('../../db/pool');
const { authenticate, requireRole } = require('../../lib/auth');
const { apiLimiter } = require('../../lib/rateLimit');
const { handleValidationErrors } = require('../../lib/validation');
const { logSystemEvent } = require('../../lib/audit');

router.get('/partner/:id/final-clients', authenticate, async (req, res) => {
  const pid = req.params.id;
  if(req.user.role !== 'admin'){
    if(!req.user.partner_id || String(req.user.partner_id) !== String(pid))
      return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const r = await pool.query(
      'SELECT id, name, created_at FROM partner_final_clients WHERE partner_id=$1 ORDER BY name ASC',
      [pid]
    );
    res.json(r.rows);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

router.post('/partner/:id/final-clients',
  authenticate, requireRole('partner'), apiLimiter,
  body('name').trim().isLength({ min: 2, max: 200 }).withMessage('Nombre obligatorio (2-200 caracteres)'),
  handleValidationErrors,
  async (req, res) => {
    const pid = req.params.id;
    if(!req.user.partner_id || String(req.user.partner_id) !== String(pid))
      return res.status(403).json({ error: 'forbidden' });
    try {
      const { name } = req.body;
      const dup = await pool.query(
        'SELECT id FROM partner_final_clients WHERE partner_id=$1 AND LOWER(name)=LOWER($2)',
        [pid, name]
      );
      if(dup.rowCount > 0) return res.status(409).json({ error: 'Ya existe un cliente con ese nombre' });
      const r = await pool.query(
        'INSERT INTO partner_final_clients (partner_id, name) VALUES ($1,$2) RETURNING id, name, created_at',
        [pid, name]
      );
      await logSystemEvent('FINAL_CLIENT_CREATED', 'FINAL_CLIENT_MANAGEMENT', req.user.sub, null, null, {
        partner_id: parseInt(pid, 10),
        final_client_id: r.rows[0].id,
        name: r.rows[0].name
      }, 'SUCCESS', null, req);
      res.status(201).json(r.rows[0]);
    } catch(e) {
      await logSystemEvent('FINAL_CLIENT_CREATE_ERROR', 'FINAL_CLIENT_MANAGEMENT', req.user.sub, null, null, { partner_id: parseInt(pid, 10) || null }, 'FAILED', e.message, req);
      res.status(400).json({ error: e.message });
    }
  }
);

router.put('/partner/:id/final-clients/:clientId',
  authenticate, requireRole('partner'), apiLimiter,
  body('name').trim().isLength({ min: 2, max: 200 }).withMessage('Nombre obligatorio (2-200 caracteres)'),
  handleValidationErrors,
  async (req, res) => {
    const pid = req.params.id;
    const clientId = parseInt(req.params.clientId, 10);
    if(!req.user.partner_id || String(req.user.partner_id) !== String(pid))
      return res.status(403).json({ error: 'forbidden' });
    try {
      const { name } = req.body;
      const dup = await pool.query(
        'SELECT id FROM partner_final_clients WHERE partner_id=$1 AND LOWER(name)=LOWER($2) AND id<>$3',
        [pid, name, clientId]
      );
      if(dup.rowCount > 0) return res.status(409).json({ error: 'Ya existe un cliente con ese nombre' });
      const r = await pool.query(
        'UPDATE partner_final_clients SET name=$1 WHERE id=$2 AND partner_id=$3 RETURNING id, name, created_at',
        [name, clientId, pid]
      );
      if(r.rowCount === 0) return res.status(404).json({ error: 'Cliente no encontrado' });
      await logSystemEvent('FINAL_CLIENT_UPDATED', 'FINAL_CLIENT_MANAGEMENT', req.user.sub, null, null, {
        partner_id: parseInt(pid, 10),
        final_client_id: clientId,
        name
      }, 'SUCCESS', null, req);
      res.json(r.rows[0]);
    } catch(e) {
      await logSystemEvent('FINAL_CLIENT_UPDATE_ERROR', 'FINAL_CLIENT_MANAGEMENT', req.user.sub, null, null, {
        partner_id: parseInt(pid, 10) || null,
        final_client_id: clientId
      }, 'FAILED', e.message, req);
      res.status(400).json({ error: e.message });
    }
  }
);

router.delete('/partner/:id/final-clients/:clientId',
  authenticate, requireRole('partner'),
  async (req, res) => {
    const pid = req.params.id;
    const clientId = parseInt(req.params.clientId, 10);
    if(!req.user.partner_id || String(req.user.partner_id) !== String(pid))
      return res.status(403).json({ error: 'forbidden' });
    try {
      const r = await pool.query(
        'DELETE FROM partner_final_clients WHERE id=$1 AND partner_id=$2 RETURNING id',
        [clientId, pid]
      );
      if(r.rowCount === 0) return res.status(404).json({ error: 'Cliente no encontrado' });
      await logSystemEvent('FINAL_CLIENT_DELETED', 'FINAL_CLIENT_MANAGEMENT', req.user.sub, null, null, {
        partner_id: parseInt(pid, 10),
        final_client_id: clientId
      }, 'SUCCESS', null, req);
      res.json({ ok: true });
    } catch(e) {
      await logSystemEvent('FINAL_CLIENT_DELETE_ERROR', 'FINAL_CLIENT_MANAGEMENT', req.user.sub, null, null, {
        partner_id: parseInt(pid, 10) || null,
        final_client_id: clientId
      }, 'FAILED', e.message, req);
      res.status(400).json({ error: e.message });
    }
  }
);

module.exports = router;
