'use strict';
// Módulo Pricing: perfiles de precio, reglas escalonadas, asignación por partner y preview.
const express = require('express');
const router = express.Router();
const pool = require('../../db/pool');
const { authenticate, requireRole } = require('../../lib/auth');
const { apiLimiter } = require('../../lib/rateLimit');
const { logSystemEvent } = require('../../lib/audit');
const {
  normalizePricingProfileCode, normalizePricingRules, getPricingProfilesDetailed,
  getPartnerPricingAssignment, getPartnerCumulativePaidQty, resolvePartnerPricing,
} = require('./service');

router.get('/admin/pricing/profiles', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const profiles = await getPricingProfilesDetailed();
    res.json(profiles);
  } catch (e) {
    res.status(400).json({ error: 'Error al obtener perfiles de pricing' });
  }
});

router.post('/admin/pricing/profiles', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  const { name, code, description, profile_type } = req.body || {};

  try {
    const profileName = String(name || '').trim();
    const profileType = String(profile_type || 'SPECIAL').trim().toUpperCase();
    if (!profileName) {
      return res.status(400).json({ error: 'Nombre del perfil es obligatorio' });
    }
    if (!['SPECIAL', 'CATEGORY'].includes(profileType)) {
      return res.status(400).json({ error: 'Tipo de perfil inválido' });
    }

    const normalizedCode = normalizePricingProfileCode(code || profileName);
    const created = await pool.query(
      `INSERT INTO pricing_profiles (code, name, profile_type, description, active, is_system, updated_at)
       VALUES ($1, $2, $3, $4, TRUE, FALSE, NOW())
       RETURNING id, code, name, profile_type, description, active, is_system`,
      [normalizedCode, profileName, profileType, description || null]
    );

    await logSystemEvent('PRICING_PROFILE_CREATED', 'PRICING', req.user.sub, null, null, {
      profile_id: created.rows[0].id,
      code: created.rows[0].code,
      name: created.rows[0].name,
      profile_type: created.rows[0].profile_type
    }, 'SUCCESS', null, req);

    res.status(201).json(created.rows[0]);
  } catch (e) {
    if (e.code === '23505') {
      await logSystemEvent('PRICING_PROFILE_CREATE_ERROR', 'PRICING', req.user.sub, null, null, { code, name, profile_type }, 'FAILED', 'Ya existe un perfil con ese código', req);
      return res.status(400).json({ error: 'Ya existe un perfil con ese código' });
    }
    await logSystemEvent('PRICING_PROFILE_CREATE_ERROR', 'PRICING', req.user.sub, null, null, { code, name, profile_type }, 'FAILED', e.message, req);
    res.status(400).json({ error: 'Error al crear perfil de pricing' });
  }
});

router.put('/admin/pricing/profiles/:id', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  const profileId = parseInt(req.params.id, 10);
  const { name, description, active, rules } = req.body || {};

  if (!Number.isInteger(profileId) || profileId < 1) {
    return res.status(400).json({ error: 'Perfil inválido' });
  }

  try {
    const normalizedRules = normalizePricingRules(rules || []);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const existing = await client.query(
        'SELECT id, code, name, profile_type, active, is_system FROM pricing_profiles WHERE id=$1',
        [profileId]
      );
      if (existing.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Perfil no encontrado' });
      }

      const profile = existing.rows[0];
      await client.query(
        `UPDATE pricing_profiles
         SET name=$1,
             description=$2,
             active=$3,
             updated_at=NOW()
         WHERE id=$4`,
        [String(name || profile.name).trim() || profile.name, description || null, active !== false, profileId]
      );

      await client.query('DELETE FROM pricing_rules WHERE profile_id=$1', [profileId]);
      for (const rule of normalizedRules) {
        await client.query(
          `INSERT INTO pricing_rules (profile_id, min_qty, max_qty, unit_price, active, updated_at)
           VALUES ($1, $2, $3, $4, TRUE, NOW())`,
          [profileId, rule.min_qty, rule.max_qty, rule.unit_price]
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const profiles = await getPricingProfilesDetailed();
    const updated = profiles.find(profile => profile.id === profileId);

    await logSystemEvent('PRICING_PROFILE_UPDATED', 'PRICING', req.user.sub, null, null, {
      profile_id: profileId,
      name: updated ? updated.name : null,
      active: updated ? updated.active : null,
      rules_count: Array.isArray(normalizedRules) ? normalizedRules.length : 0
    }, 'SUCCESS', null, req);

    res.json(updated);
  } catch (e) {
    await logSystemEvent('PRICING_PROFILE_UPDATE_ERROR', 'PRICING', req.user.sub, null, null, { profile_id: profileId }, 'FAILED', e.message, req);
    res.status(400).json({ error: e.message || 'Error al actualizar perfil de pricing' });
  }
});

router.get('/admin/partners/:id/pricing', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  const partnerId = parseInt(req.params.id, 10);
  if (!Number.isInteger(partnerId) || partnerId < 1) {
    return res.status(400).json({ error: 'Partner inválido' });
  }

  try {
    const partner = await getPartnerPricingAssignment(partnerId);
    const cumulativeQty = await getPartnerCumulativePaidQty(partnerId);
    const [sampleQty1, sampleQty10, sampleQty25] = await Promise.all([
      resolvePartnerPricing(partnerId, 1,  cumulativeQty),
      resolvePartnerPricing(partnerId, 10, cumulativeQty),
      resolvePartnerPricing(partnerId, 25, cumulativeQty)
    ]);

    res.json({
      partner,
      cumulative_qty: cumulativeQty,
      samples: [sampleQty1, sampleQty10, sampleQty25]
    });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Error al obtener pricing del partner' });
  }
});

router.put('/admin/partners/:id/pricing', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  const partnerId = parseInt(req.params.id, 10);
  const baseProfileId = req.body && req.body.pricing_profile_id !== undefined && req.body.pricing_profile_id !== null && req.body.pricing_profile_id !== ''
    ? parseInt(req.body.pricing_profile_id, 10)
    : null;
  const specialProfileId = req.body && req.body.special_pricing_profile_id !== undefined && req.body.special_pricing_profile_id !== null && req.body.special_pricing_profile_id !== ''
    ? parseInt(req.body.special_pricing_profile_id, 10)
    : null;

  if (!Number.isInteger(partnerId) || partnerId < 1) {
    return res.status(400).json({ error: 'Partner inválido' });
  }
  if (!Number.isInteger(baseProfileId) || baseProfileId < 1) {
    return res.status(400).json({ error: 'La categoría base es obligatoria' });
  }

  try {
    const profileChecks = await pool.query(
      'SELECT id, profile_type FROM pricing_profiles WHERE id = ANY($1::int[])',
      [[baseProfileId, ...(specialProfileId ? [specialProfileId] : [])]]
    );

    const profileMap = new Map(profileChecks.rows.map(row => [row.id, row.profile_type]));
    if (profileMap.get(baseProfileId) !== 'CATEGORY') {
      return res.status(400).json({ error: 'La categoría base debe ser un perfil de tipo CATEGORY' });
    }
    if (specialProfileId && profileMap.get(specialProfileId) !== 'SPECIAL') {
      return res.status(400).json({ error: 'El precio especial debe ser un perfil de tipo SPECIAL' });
    }

    const updated = await pool.query(
      `UPDATE partners
       SET pricing_profile_id=$1,
           special_pricing_profile_id=$2
       WHERE id=$3
       RETURNING id`,
      [baseProfileId, specialProfileId, partnerId]
    );

    if (updated.rowCount === 0) {
      return res.status(404).json({ error: 'Partner no encontrado' });
    }

    const partner = await getPartnerPricingAssignment(partnerId);
    await logSystemEvent('PARTNER_PRICING_UPDATED', 'PRICING', req.user.sub, null, null, {
      partner_id: partnerId,
      pricing_profile_id: baseProfileId,
      special_pricing_profile_id: specialProfileId || null
    }, 'SUCCESS', null, req);
    res.json(partner);
  } catch (e) {
    await logSystemEvent('PARTNER_PRICING_UPDATE_ERROR', 'PRICING', req.user.sub, null, null, {
      partner_id: partnerId,
      pricing_profile_id: baseProfileId,
      special_pricing_profile_id: specialProfileId || null
    }, 'FAILED', e.message, req);
    res.status(400).json({ error: e.message || 'Error al guardar pricing del partner' });
  }
});

router.get('/partner/:id/pricing-preview', authenticate, apiLimiter, async (req, res) => {
  const pid = req.params.id;
  const qty = parseInt(req.query.qty, 10);

  if (req.user && req.user.role === 'partner') {
    if (!req.user.partner_id || String(req.user.partner_id) !== String(pid)) {
      return res.status(403).json({ error: 'forbidden' });
    }
  } else if (req.user && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }

  try {
    const pricing = await resolvePartnerPricing(pid, qty);
    res.json(pricing);
  } catch (e) {
    res.status(400).json({ error: e.message || 'Error al calcular precio' });
  }
});

module.exports = router;
