'use strict';
// Lógica de pricing (perfiles + reglas escalonadas por cantidad acumulada).
// Usado por el módulo pricing y por purchases/checkout/users (vía import en app.js).
const pool = require('../../db/pool');

const DEFAULT_PRICING_PROFILES = [
  {
    code: 'base',
    name: 'Base',
    profile_type: 'CATEGORY',
    description: 'Categoría base para todos los partners',
    rules: [
      { min_qty: 1, max_qty: 5, unit_price: 100.00 },
      { min_qty: 6, max_qty: 20, unit_price: 90.00 },
      { min_qty: 21, max_qty: null, unit_price: 80.00 }
    ]
  }
];

function normalizePricingProfileCode(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized || `profile_${Date.now()}`;
}

function normalizePricingRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error('Debes configurar al menos una regla de precio');
  }

  const normalized = rules.map((rule, index) => {
    const minQty = parseInt(rule.min_qty, 10);
    const maxQty = rule.max_qty === '' || rule.max_qty === null || rule.max_qty === undefined
      ? null
      : parseInt(rule.max_qty, 10);
    const unitPrice = parseFloat(rule.unit_price);

    if (!Number.isInteger(minQty) || minQty < 1) {
      throw new Error(`La regla ${index + 1} tiene una cantidad mínima inválida`);
    }
    if (maxQty !== null && (!Number.isInteger(maxQty) || maxQty < minQty)) {
      throw new Error(`La regla ${index + 1} tiene una cantidad máxima inválida`);
    }
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      throw new Error(`La regla ${index + 1} tiene un precio unitario inválido`);
    }

    return {
      min_qty: minQty,
      max_qty: maxQty,
      unit_price: Number(unitPrice.toFixed(2))
    };
  }).sort((a, b) => a.min_qty - b.min_qty);

  if (normalized[0].min_qty !== 1) {
    throw new Error('Las reglas deben comenzar desde cantidad 1');
  }

  for (let index = 0; index < normalized.length; index++) {
    const current = normalized[index];
    const next = normalized[index + 1];

    if (!next) {
      break;
    }

    if (current.max_qty === null) {
      throw new Error('Solo la última regla puede quedar abierta sin cantidad máxima');
    }

    if (next.min_qty !== current.max_qty + 1) {
      throw new Error('Las reglas deben ser continuas y sin traslapes entre cantidades');
    }
  }

  return normalized;
}

async function ensureDefaultPricingProfilesAndRules() {
  for (const profile of DEFAULT_PRICING_PROFILES) {
    const profileResult = await pool.query(
      `INSERT INTO pricing_profiles (code, name, profile_type, description, active, is_system, updated_at)
       VALUES ($1, $2, $3, $4, TRUE, TRUE, NOW())
       ON CONFLICT (code)
       DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         profile_type = EXCLUDED.profile_type,
         is_system = TRUE,
         updated_at = NOW()
       RETURNING id`,
      [profile.code, profile.name, profile.profile_type, profile.description]
    );

    const profileId = profileResult.rows[0].id;
    const ruleCount = await pool.query('SELECT COUNT(*) FROM pricing_rules WHERE profile_id=$1', [profileId]);

    if (parseInt(ruleCount.rows[0].count, 10) === 0) {
      for (const rule of profile.rules) {
        await pool.query(
          `INSERT INTO pricing_rules (profile_id, min_qty, max_qty, unit_price, active, updated_at)
           VALUES ($1, $2, $3, $4, TRUE, NOW())`,
          [profileId, rule.min_qty, rule.max_qty, rule.unit_price]
        );
      }
    }
  }

  // Migration: consolidate old CATEGORY profiles (silver/plate/gold) into single 'base'
  const baseProfile = await pool.query('SELECT id FROM pricing_profiles WHERE code=$1 LIMIT 1', ['base']);
  if (baseProfile.rowCount > 0) {
    const baseId = baseProfile.rows[0].id;
    await pool.query(
      `UPDATE partners SET pricing_profile_id=$1
       WHERE pricing_profile_id IN (SELECT id FROM pricing_profiles WHERE code IN ('silver','plate','gold') AND id <> $1)
          OR pricing_profile_id IS NULL`,
      [baseId]
    );
    await pool.query(
      `UPDATE pricing_profiles SET active=FALSE WHERE code IN ('silver','plate','gold')`
    );
  }
}

async function getPricingProfilesDetailed(profileType = null) {
  const params = [];
  let whereClause = '';

  if (profileType) {
    params.push(profileType);
    whereClause = 'WHERE profile_type = $1';
  }

  const profilesResult = await pool.query(
    `SELECT id, code, name, profile_type, description, active, is_system, created_at, updated_at
     FROM pricing_profiles
     ${whereClause}
     ORDER BY profile_type ASC, name ASC`,
    params
  );

  const rulesResult = await pool.query(
    `SELECT id, profile_id, min_qty, max_qty, unit_price, active, created_at, updated_at
     FROM pricing_rules
     ORDER BY profile_id ASC, min_qty ASC`
  );

  const rulesByProfile = new Map();
  for (const rule of rulesResult.rows) {
    if (!rulesByProfile.has(rule.profile_id)) {
      rulesByProfile.set(rule.profile_id, []);
    }
    rulesByProfile.get(rule.profile_id).push(rule);
  }

  return profilesResult.rows.map(profile => ({
    ...profile,
    rules: rulesByProfile.get(profile.id) || []
  }));
}

async function getPartnerPricingAssignment(partnerId) {
  const result = await pool.query(
    `SELECT p.id, p.name, p.email,
            p.pricing_profile_id, p.special_pricing_profile_id,
            base.code AS pricing_profile_code, base.name AS pricing_profile_name, base.profile_type AS pricing_profile_type,
            special.code AS special_pricing_profile_code, special.name AS special_pricing_profile_name, special.profile_type AS special_pricing_profile_type
     FROM partners p
     LEFT JOIN pricing_profiles base ON base.id = p.pricing_profile_id
     LEFT JOIN pricing_profiles special ON special.id = p.special_pricing_profile_id
     WHERE p.id = $1`,
    [partnerId]
  );

  if (result.rowCount === 0) {
    throw new Error('Partner no encontrado');
  }

  return result.rows[0];
}

async function getDefaultPricingProfileId() {
  const result = await pool.query('SELECT id FROM pricing_profiles WHERE code=$1 LIMIT 1', ['base']);
  return result.rowCount > 0 ? result.rows[0].id : null;
}

async function findMatchingPricingRule(profileId, qty) {
  const result = await pool.query(
    `SELECT r.id, r.profile_id, r.min_qty, r.max_qty, r.unit_price,
            p.code AS profile_code, p.name AS profile_name, p.profile_type
     FROM pricing_rules r
     INNER JOIN pricing_profiles p ON p.id = r.profile_id
     WHERE r.profile_id = $1
       AND r.active = TRUE
       AND r.min_qty <= $2
       AND (r.max_qty IS NULL OR r.max_qty >= $2)
     ORDER BY r.min_qty DESC
     LIMIT 1`,
    [profileId, qty]
  );

  return result.rowCount > 0 ? result.rows[0] : null;
}

async function getPartnerCumulativePaidQty(partnerId) {
  const result = await pool.query(
    `SELECT COALESCE(SUM(qty), 0) AS cumulative_qty
     FROM purchases
     WHERE partner_id = $1
       AND payment_method != 'complimentary'
       AND (status = 'PAID' OR stripe_status IN ('paid', 'succeeded'))`,
    [partnerId]
  );
  return parseInt(result.rows[0].cumulative_qty, 10);
}

async function resolvePartnerPricing(partnerId, qty, cumulativeOverride = null) {
  const quantity = parseInt(qty, 10);
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error('Cantidad inválida para cálculo de precio');
  }

  // Cumulative historical paid qty determines the tier; current qty is added to it.
  const cumulativeQty = (cumulativeOverride !== null && cumulativeOverride !== undefined)
    ? parseInt(cumulativeOverride, 10)
    : await getPartnerCumulativePaidQty(partnerId);
  const lookupQty = cumulativeQty + quantity;

  const partner = await getPartnerPricingAssignment(partnerId);
  const defaultSilver = await pool.query(
    'SELECT id, code, name, profile_type FROM pricing_profiles WHERE code=$1 LIMIT 1',
    ['base']
  );

  const candidates = [];
  if (partner.special_pricing_profile_id) {
    candidates.push({
      source: 'SPECIAL',
      profile_id: partner.special_pricing_profile_id
    });
  }
  if (partner.pricing_profile_id) {
    candidates.push({
      source: 'CATEGORY',
      profile_id: partner.pricing_profile_id
    });
  }
  if (defaultSilver.rowCount > 0) {
    const fallbackId = defaultSilver.rows[0].id;
    if (!candidates.some(candidate => candidate.profile_id === fallbackId)) {
      candidates.push({
        source: 'DEFAULT',
        profile_id: fallbackId
      });
    }
  }

  for (const candidate of candidates) {
    const matchingRule = await findMatchingPricingRule(candidate.profile_id, lookupQty);
    if (!matchingRule) {
      continue;
    }

    const unitPrice = Number(parseFloat(matchingRule.unit_price).toFixed(2));
    const totalPrice = Number((unitPrice * quantity).toFixed(2));
    const qtyRange = matchingRule.max_qty === null
      ? `${matchingRule.min_qty}+`
      : `${matchingRule.min_qty}-${matchingRule.max_qty}`;

    return {
      partner_id: partner.id,
      partner_name: partner.name,
      quantity,
      cumulative_qty: cumulativeQty,
      lookup_qty: lookupQty,
      unit_price: unitPrice,
      total_price: totalPrice,
      pricing_source: candidate.source,
      pricing_profile_id: matchingRule.profile_id,
      pricing_profile_code: matchingRule.profile_code,
      pricing_profile_name: matchingRule.profile_name,
      pricing_rule_id: matchingRule.id,
      min_qty: matchingRule.min_qty,
      max_qty: matchingRule.max_qty,
      quantity_range: qtyRange,
      breakdown_message: `${matchingRule.profile_name} · tramo ${qtyRange} · ${unitPrice.toFixed(2)} por voucher`,
      cumulative_message: `${cumulativeQty} vouchers históricos · compra ${quantity} → tramo ${qtyRange}`,
      base_profile_name: partner.pricing_profile_name,
      special_profile_name: partner.special_pricing_profile_name
    };
  }

  throw new Error('No existe una regla de precio activa para esa cantidad');
}

module.exports = {
  DEFAULT_PRICING_PROFILES,
  normalizePricingProfileCode,
  normalizePricingRules,
  ensureDefaultPricingProfilesAndRules,
  getPricingProfilesDetailed,
  getPartnerPricingAssignment,
  getDefaultPricingProfileId,
  findMatchingPricingRule,
  getPartnerCumulativePaidQty,
  resolvePartnerPricing,
};
