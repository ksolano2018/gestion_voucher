'use strict';
// Integración con Stripe: cliente, sincronización de customers↔partners/usuarios,
// y el job de sincronización en background. Usado por purchases/checkout/users/webhooks.
const Stripe = require('stripe');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const { logSystemEvent } = require('../lib/audit');
const { getDefaultPricingProfileId } = require('../modules/pricing/service');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_XXXXXXXXXXXXXXXX');

function generateTemporaryPassword(seed = 'partner') {
  const normalizedSeed = String(seed).replace(/[^a-zA-Z0-9]/g, '').slice(-8) || 'Partner';
  return `Tmp!${normalizedSeed}Aa1`;
}

function isMissingStripeCustomerError(error) {
  return Boolean(
    error &&
    error.type === 'StripeInvalidRequestError' &&
    error.statusCode === 400 &&
    typeof error.message === 'string' &&
    error.message.includes('No such customer')
  );
}

async function upsertStripeCustomerRecord(stripeCustomerId, email, name, partnerId = null, metadata = {}) {
  await pool.query(
    `INSERT INTO stripe_customers (stripe_customer_id, customer_email, customer_name, partner_id, metadata)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (stripe_customer_id)
     DO UPDATE SET customer_email=$2, customer_name=$3, partner_id=$4, metadata=$5, updated_at=NOW()`,
    [stripeCustomerId, email, name, partnerId, JSON.stringify(metadata)]
  );
}

async function syncUserWithStripe(email, name, userId) {
  try {
    console.log(`🔍 Sincronizando usuario con Stripe: ${email}`);

    const customers = await stripe.customers.list({ email: email, limit: 1 });

    let stripeCustomerId = null;

    let customerMetadata = {
      app_user_id: userId ? String(userId) : undefined,
      synced_at: new Date().toISOString()
    };

    if (customers.data && customers.data.length > 0) {
      stripeCustomerId = customers.data[0].id;
      customerMetadata = {
        ...customers.data[0].metadata,
        ...customerMetadata
      };
      console.log(`✅ Cliente Stripe encontrado: ${stripeCustomerId}`);
    } else {
      const customer = await stripe.customers.create({
        email: email,
        name: name,
        metadata: customerMetadata
      });
      stripeCustomerId = customer.id;
      customerMetadata = customer.metadata || customerMetadata;
      console.log(`✨ Cliente Stripe creado: ${stripeCustomerId}`);
    }

    let partnerId = null;
    if (userId) {
      const updatedUser = await pool.query(
        'UPDATE users SET stripe_customer_id=$1, updated_at=NOW() WHERE id=$2 RETURNING partner_id',
        [stripeCustomerId, userId]
      );
      partnerId = updatedUser.rowCount > 0 ? updatedUser.rows[0].partner_id : null;
      console.log(`💾 Usuario actualizado con stripe_customer_id: ${stripeCustomerId}`);
    }

    await upsertStripeCustomerRecord(stripeCustomerId, email, name, partnerId, customerMetadata);

    return stripeCustomerId;
  } catch (e) {
    console.error('❌ Error sincronizando con Stripe:', e.message);
    throw e;
  }
}

async function upsertPartnerAndUserFromStripeCustomer(customer, source = 'STRIPE_SYNC', req = null) {
  if (!customer || !customer.id || !customer.email) {
    return { status: 'SKIPPED', reason: 'missing_required_customer_fields' };
  }

  const stripeCustomerId = customer.id;
  const email = customer.email.toLowerCase();
  const name = customer.name || email.split('@')[0] || `Partner ${stripeCustomerId.slice(-6)}`;
  const metadata = customer.metadata || {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let userId = null;
    let partnerId = null;
    let createdUser = false;
    let createdPartner = false;

    if (metadata.app_user_id) {
      const byAppUserId = await client.query('SELECT id, partner_id FROM users WHERE id=$1', [metadata.app_user_id]);
      if (byAppUserId.rowCount > 0) {
        userId = byAppUserId.rows[0].id;
        partnerId = byAppUserId.rows[0].partner_id;
      }
    }

    if (!userId) {
      const byStripe = await client.query('SELECT id, partner_id FROM users WHERE stripe_customer_id=$1', [stripeCustomerId]);
      if (byStripe.rowCount > 0) {
        userId = byStripe.rows[0].id;
        partnerId = byStripe.rows[0].partner_id;
      }
    }

    if (!userId) {
      const byEmail = await client.query('SELECT id, partner_id FROM users WHERE email=$1', [email]);
      if (byEmail.rowCount > 0) {
        userId = byEmail.rows[0].id;
        partnerId = byEmail.rows[0].partner_id;
      }
    }

    if (!partnerId) {
      const partnerByStripe = await client.query('SELECT id FROM partners WHERE stripe_customer_id=$1', [stripeCustomerId]);
      if (partnerByStripe.rowCount > 0) {
        partnerId = partnerByStripe.rows[0].id;
      }
    }

    if (!partnerId) {
      const partnerByEmail = await client.query('SELECT id FROM partners WHERE email=$1', [email]);
      if (partnerByEmail.rowCount > 0) {
        partnerId = partnerByEmail.rows[0].id;
      }
    }

    if (!partnerId) {
      const defaultPricingProfileId = await getDefaultPricingProfileId();
      const createdPartnerResult = await client.query(
        'INSERT INTO partners (name, email, role, stripe_customer_id, pricing_profile_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [name, email, 'partner', stripeCustomerId, defaultPricingProfileId]
      );
      partnerId = createdPartnerResult.rows[0].id;
      createdPartner = true;
    } else {
      await client.query(
        'UPDATE partners SET name=$1, email=$2, stripe_customer_id=$3 WHERE id=$4',
        [name, email, stripeCustomerId, partnerId]
      );
    }

    let tempPassword = null;
    if (!userId) {
      tempPassword = generateTemporaryPassword(stripeCustomerId);
      const passwordHash = await bcrypt.hash(tempPassword, 10);
      const createdUserResult = await client.query(
        `INSERT INTO users (email, password, role, partner_id, stripe_customer_id, must_change_password, updated_at)
         VALUES ($1, $2, $3, $4, $5, TRUE, NOW())
         RETURNING id`,
        [email, passwordHash, 'partner', partnerId, stripeCustomerId]
      );
      userId = createdUserResult.rows[0].id;
      createdUser = true;
    } else {
      await client.query(
        'UPDATE users SET role=$1, partner_id=$2, stripe_customer_id=$3, updated_at=NOW() WHERE id=$4',
        ['partner', partnerId, stripeCustomerId, userId]
      );
    }

    await client.query(
      `INSERT INTO stripe_customers (stripe_customer_id, customer_email, customer_name, partner_id, metadata)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (stripe_customer_id)
       DO UPDATE SET customer_email=$2, customer_name=$3, partner_id=$4, metadata=$5, updated_at=NOW()`,
      [stripeCustomerId, email, name, partnerId, JSON.stringify(metadata)]
    );

    await client.query('COMMIT');

    await logSystemEvent(
      createdUser ? 'STRIPE_CUSTOMER_SYNC_CREATED_USER' : 'STRIPE_CUSTOMER_SYNC_UPDATED_USER',
      'STRIPE_SYNC',
      userId,
      stripeCustomerId,
      null,
      {
        source,
        customer_email: email,
        partner_id: partnerId,
        created_user: createdUser,
        created_partner: createdPartner
      },
      'SUCCESS',
      null,
      req
    );

    return {
      status: createdUser ? 'CREATED' : 'UPDATED',
      user_id: userId,
      partner_id: partnerId,
      stripe_customer_id: stripeCustomerId,
      email,
      temp_password: tempPassword
    };
  } catch (e) {
    await client.query('ROLLBACK');
    await logSystemEvent(
      'STRIPE_CUSTOMER_SYNC_ERROR',
      'STRIPE_SYNC',
      null,
      customer.id,
      null,
      { source, customer_email: customer.email },
      'FAILED',
      e.message,
      req
    );
    throw e;
  } finally {
    client.release();
  }
}

async function syncAllStripeCustomersToPartners(req = null) {
  let hasMore = true;
  let startingAfter = null;
  const summary = {
    processed: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    details: []
  };

  while (hasMore) {
    const params = { limit: 100 };
    if (startingAfter) {
      params.starting_after = startingAfter;
    }

    const batch = await stripe.customers.list(params);
    for (const customer of batch.data) {
      try {
        const result = await upsertPartnerAndUserFromStripeCustomer(customer, 'STRIPE_BATCH_SYNC', req);
        summary.processed += 1;
        if (result.status === 'CREATED') summary.created += 1;
        else if (result.status === 'UPDATED') summary.updated += 1;
        else summary.skipped += 1;
        summary.details.push(result);
      } catch (e) {
        summary.processed += 1;
        summary.failed += 1;
        summary.details.push({
          status: 'FAILED',
          stripe_customer_id: customer.id,
          email: customer.email,
          error: e.message
        });
      }
    }

    hasMore = batch.has_more;
    if (batch.data.length > 0) {
      startingAfter = batch.data[batch.data.length - 1].id;
    }
  }

  return summary;
}

// ── Job de sincronización en background ────────────────────────────────────────
const stripeSyncJobs = new Map();
let latestStripeSyncJobId = null;

function getStripeSyncJobResponse(job) {
  if (!job) return null;
  return {
    job_id: job.job_id,
    status: job.status,
    started_at: job.started_at,
    finished_at: job.finished_at,
    summary: job.summary,
    error: job.error
  };
}

async function runStripeSyncJob(jobId) {
  const job = stripeSyncJobs.get(jobId);
  if (!job) return;

  job.status = 'running';
  job.started_at = new Date().toISOString();

  try {
    const summary = await syncAllStripeCustomersToPartners();
    job.status = 'completed';
    job.finished_at = new Date().toISOString();
    job.summary = summary;
  } catch (e) {
    job.status = 'failed';
    job.finished_at = new Date().toISOString();
    job.error = e.message;
    console.error('❌ Error en sync async de Stripe customers:', e);
  }
}

// Encola un job y lo lanza en background; devuelve { job_id, response }.
function enqueueStripeSyncJob() {
  const jobId = uuidv4();
  const job = { job_id: jobId, status: 'queued', started_at: null, finished_at: null, summary: null, error: null };
  stripeSyncJobs.set(jobId, job);
  latestStripeSyncJobId = jobId;
  setImmediate(() => { runStripeSyncJob(jobId); });
  return { job_id: jobId, response: getStripeSyncJobResponse(job) };
}

function getStripeSyncJob(jobId) {
  return getStripeSyncJobResponse(stripeSyncJobs.get(jobId));
}

// { hasJobs, response } — hasJobs=false si nunca se registró ningún job.
function getLatestStripeSyncJob() {
  if (!latestStripeSyncJobId) return { hasJobs: false, response: null };
  return { hasJobs: true, response: getStripeSyncJobResponse(stripeSyncJobs.get(latestStripeSyncJobId)) };
}

module.exports = {
  stripe,
  isMissingStripeCustomerError,
  syncUserWithStripe,
  upsertPartnerAndUserFromStripeCustomer,
  syncAllStripeCustomersToPartners,
  enqueueStripeSyncJob,
  getStripeSyncJob,
  getLatestStripeSyncJob,
};
