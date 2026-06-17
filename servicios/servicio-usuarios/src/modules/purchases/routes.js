'use strict';
// Módulo de compras + integración de pagos Stripe (webhook, checkout, transaction-events).
// Rutas:
//   - Sync de clientes Stripe ↔ partners (sync, async, job status)
//   - Creación de compras (admin / partner) + Stripe Checkout
//   - Webhook real de Stripe (/webhook/stripe, raw body) y simulación (/stripe/webhook)
//   - Listados/consultas: purchases, stripe-customers, transaction-events, pagos por partner
//   - Operaciones financieras: vouchers de cortesía, compras externas, ajuste, detalle
// El comportamiento (rutas/respuestas) es idéntico al monolito; sólo cambia de archivo.
const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { body, param } = require('express-validator');

const pool = require('../../db/pool');
const { logSecurityEvent, logSystemEvent, logTransactionEvent } = require('../../lib/audit');
const { apiLimiter } = require('../../lib/rateLimit');
const { handleValidationErrors } = require('../../lib/validation');
const { authenticate, requireRole, requirePermission, requireAnyPermission } = require('../../lib/auth');
const { resolvePartnerPricing } = require('../pricing/service');
const {
  stripe, isMissingStripeCustomerError, syncUserWithStripe, upsertPartnerAndUserFromStripeCustomer,
  syncAllStripeCustomersToPartners, enqueueStripeSyncJob, getStripeSyncJob, getLatestStripeSyncJob,
} = require('../../integrations/stripe');
const { generateVoucherCode } = require('../../lib/vouchers');

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

const EXTERNAL_PAYMENT_METHODS = ['bank_transfer', 'cash', 'invoice'];
const ADJUSTABLE_PAYMENT_METHODS = [...EXTERNAL_PAYMENT_METHODS, 'complimentary'];

const router = express.Router();

router.post('/admin/stripe/sync-customers', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const summary = await syncAllStripeCustomersToPartners(req);
    res.json({ ok: true, summary });
  } catch (e) {
    console.error('❌ Error sincronizando clientes de Stripe:', e);
    res.status(500).json({ error: 'Error al sincronizar clientes de Stripe', detail: e.message });
  }
});

router.post('/admin/stripe/sync-customers/async', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  const { job_id, response } = enqueueStripeSyncJob();
  res.status(202).json({
    ok: true,
    message: 'Sincronización iniciada en segundo plano',
    job: response,
    status_endpoint: `/admin/stripe/sync-customers/async/${job_id}`
  });
});

router.get('/admin/stripe/sync-customers/async/latest', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  const { hasJobs, response } = getLatestStripeSyncJob();
  if (!hasJobs) {
    return res.status(404).json({ error: 'No hay jobs de sincronización registrados' });
  }
  if (!response) {
    return res.status(404).json({ error: 'Job no encontrado' });
  }
  return res.json({ ok: true, job: response });
});

router.get('/admin/stripe/sync-customers/async/:jobId', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  const response = getStripeSyncJob(req.params.jobId);
  if (!response) {
    return res.status(404).json({ error: 'Job no encontrado' });
  }
  return res.json({ ok: true, job: response });
});

// Admin: create purchase (generate stripe link)
router.post('/admin/purchases', authenticate, requireRole('admin'), async (req,res)=>{
  const { partner_id, qty } = req.body;
  const link = `https://fake-stripe/pay/${uuidv4()}`;
  const expires = new Date(Date.now() + 1000*60*60).toISOString();
  try{
    const pricing = await resolvePartnerPricing(partner_id, qty);
    const r = await pool.query(
      'INSERT INTO purchases (partner_id,qty,total_price,stripe_link,expires_at,pricing_details) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [partner_id, qty, pricing.total_price.toFixed(2), link, expires, JSON.stringify(pricing)]
    );
    await logSystemEvent('PURCHASE_CREATED_ADMIN', 'PURCHASE', req.user.sub, null, r.rows[0].id, {
      partner_id,
      qty,
      total_price: pricing.total_price
    }, 'SUCCESS', null, req);
    res.json(r.rows[0]);
  }catch(e){
    await logSystemEvent('PURCHASE_CREATE_ADMIN_ERROR', 'PURCHASE', req.user.sub, null, null, { partner_id, qty }, 'FAILED', e.message, req);
    res.status(400).json({error:e.message});
  }
});

// Partner: create purchase (partner inicia compra para su partner_id)
router.post('/partner/:id/purchases', authenticate, async (req,res)=>{
  const pid = req.params.id;
  // allow if admin OR if authenticated partner and partner_id matches
  if(req.user && req.user.role === 'partner'){
    if(!req.user.partner_id || String(req.user.partner_id) !== String(pid)) return res.status(403).json({ error: 'forbidden' });
  } else if(req.user && req.user.role !== 'admin'){
    return res.status(403).json({ error: 'forbidden' });
  }

  const { qty, descriptor, payment_method } = req.body || {};
  const q = parseInt(qty) || 0;
  if(q <= 0) return res.status(400).json({ error: 'Cantidad inválida' });

  let pricing;
  try {
    pricing = await resolvePartnerPricing(pid, q);
  } catch (pricingError) {
    return res.status(400).json({ error: pricingError.message });
  }
  // generate fake stripe link (simulación de pasarela en modo desarrollador)
  const link = `https://fake-stripe/pay/${uuidv4()}`;
  const expires = new Date(Date.now() + 1000*60*60).toISOString();

  try{
    // Do NOT store raw payment_method details in DB. We accept them to forward to gateway in a real integration.
    // Store descriptor if provided (we'll reuse existing stripe_link field to keep schema simple) - better would be an extra column.
    const r = await pool.query(
      'INSERT INTO purchases (partner_id,qty,total_price,stripe_link,expires_at,pricing_details) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [pid, q, pricing.total_price.toFixed(2), link, expires, JSON.stringify(pricing)]
    );
    // Return the created purchase and the link for frontend to redirect to pasarela
    if(r.rows && r.rows.length > 0){
      await logSystemEvent('PURCHASE_CREATED_PARTNER', 'PURCHASE', req.user.sub, null, r.rows[0].id, {
        partner_id: pid,
        qty: q,
        total_price: pricing.total_price
      }, 'SUCCESS', null, req);
      res.status(201).json(r.rows[0]);
    } else {
      res.status(400).json({error:'No se pudo crear la compra'});
    }
  }catch(e){
    await logSystemEvent('PURCHASE_CREATE_PARTNER_ERROR', 'PURCHASE', req.user.sub, null, null, { partner_id: pid, qty: q }, 'FAILED', e.message, req);
    console.error('Purchase creation error:', e);
    res.status(400).json({error:e.message});
  }
});

// Partner: create Stripe Checkout session and purchase record with validation
router.post('/partner/:id/checkout',
  authenticate,
  apiLimiter,
  param('id').isInt().withMessage('Partner ID inválido'),
  body('qty').isInt({ min: 1, max: 1000 }).withMessage('Cantidad debe estar entre 1 y 1000'),
  body('descriptor').optional().trim().isLength({ max: 200 }).withMessage('Descriptor muy largo'),
  handleValidationErrors,
  async (req,res)=>{
  const pid = req.params.id;

  // Authorization check
  if(req.user && req.user.role === 'partner'){
    if(!req.user.partner_id || String(req.user.partner_id) !== String(pid)) {
      logSecurityEvent('CHECKOUT_UNAUTHORIZED', { userId: req.user.sub, attemptedPartnerId: pid, ip: req.ip });
      return res.status(403).json({ error: 'forbidden' });
    }
  } else if(req.user && req.user.role !== 'admin'){
    logSecurityEvent('CHECKOUT_UNAUTHORIZED', { userId: req.user.sub, role: req.user.role, ip: req.ip });
    return res.status(403).json({ error: 'forbidden' });
  }

  const { qty, descriptor } = req.body || {};
  const q = parseInt(qty);

  let pricing;
  try {
    pricing = await resolvePartnerPricing(pid, q);
  } catch (pricingError) {
    return res.status(400).json({ error: pricingError.message });
  }

  const expires = new Date(Date.now() + 1000*60*60).toISOString();

  try{
    const userResult = await pool.query(
      'SELECT id, email, stripe_customer_id, must_change_password FROM users WHERE id=$1',
      [req.user.sub]
    );
    if (userResult.rowCount === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const currentUser = userResult.rows[0];
    if (currentUser.must_change_password) {
      return res.status(403).json({ error: 'password_change_required', message: 'Debes cambiar tu contraseña antes de comprar' });
    }

    let stripeCustomerId = currentUser.stripe_customer_id;
    if (!stripeCustomerId) {
      stripeCustomerId = await syncUserWithStripe(currentUser.email, currentUser.email.split('@')[0], currentUser.id);
    }

    // create purchase record first (status PENDING)
    const p = await pool.query(
      'INSERT INTO purchases (partner_id,qty,total_price,stripe_status,expires_at,pricing_details) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [pid, q, pricing.total_price.toFixed(2), 'pending', expires, JSON.stringify(pricing)]
    );
    const purchase = p.rows[0];

    // create Stripe Checkout session
    const sessionPayload = {
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: descriptor || `Vouchers x${q}` },
          unit_amount: Math.round(parseFloat(pricing.total_price) * 100)
        },
        quantity: 1
      }],
      mode: 'payment',
      customer: stripeCustomerId,
      success_url: `${FRONTEND_URL}/?checkout=success&purchase_id=${purchase.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/?checkout=cancel&purchase_id=${purchase.id}`,
      payment_intent_data: {
        metadata: {
          purchase_id: String(purchase.id),
          partner_id: String(pid),
          app_user_id: String(currentUser.id)
        }
      },
      metadata: {
        purchase_id: String(purchase.id),
        partner_id: String(pid),
        app_user_id: String(currentUser.id)
      }
    };

    let session;
    try {
      session = await stripe.checkout.sessions.create(sessionPayload);
    } catch (stripeError) {
      if (!isMissingStripeCustomerError(stripeError)) {
        throw stripeError;
      }

      console.warn(`⚠️ Stripe customer inválido para usuario ${currentUser.id}. Re-sincronizando customer antes de reintentar checkout.`);
      stripeCustomerId = await syncUserWithStripe(currentUser.email, currentUser.email.split('@')[0], currentUser.id);
      sessionPayload.customer = stripeCustomerId;
      session = await stripe.checkout.sessions.create(sessionPayload);
    }

    // update purchase record with stripe payment intent id
    await pool.query(
      'UPDATE purchases SET payment_intent_id=$1, stripe_link=$2, stripe_session_id=$3, updated_at=NOW() WHERE id=$4',
      [session.payment_intent || null, session.url, session.id, purchase.id]
    );

    logSecurityEvent('CHECKOUT_CREATED', { purchaseId: purchase.id, partnerId: pid, qty: q, total: pricing.total_price, userId: req.user.sub });
    await logSystemEvent('CHECKOUT_CREATED', 'PURCHASE', req.user.sub, stripeCustomerId || null, purchase.id, {
      partner_id: pid,
      qty: q,
      total_price: pricing.total_price,
      stripe_session_id: session.id
    }, 'SUCCESS', null, req);
    return res.status(201).json({ url: session.url, purchase_id: purchase.id, session_id: session.id });
  }catch(e){
    await logSystemEvent('CHECKOUT_CREATE_ERROR', 'PURCHASE', req.user ? req.user.sub : null, null, null, {
      partner_id: pid,
      qty: q
    }, 'FAILED', e.message, req);
    logSecurityEvent('CHECKOUT_ERROR', { error: e.message, partnerId: pid, userId: req.user.sub });
    console.error('Checkout error', e);
    return res.status(500).json({ error: 'Error al crear sesión de pago' });
  }
});

// Stripe Webhook - Enhanced for Stripe-first flow
router.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      if (process.env.NODE_ENV === 'production') {
        console.error('❌ STRIPE_WEBHOOK_SECRET no configurado en produccion. Webhook rechazado.');
        return res.status(500).send('Webhook configuration error');
      }
      console.warn('⚠️ WARNING: STRIPE_WEBHOOK_SECRET not configured. Webhook verification skipped (development only)');
      event = JSON.parse(req.body);
    } else {
      if (!sig) {
        console.error('❌ Webhook recibido sin cabecera stripe-signature');
        return res.status(400).send('Missing stripe-signature header');
      }
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    }
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('📨 Stripe Webhook received:', event.type, 'ID:', event.id);

  try {
    // Store event for audit trail
    await pool.query(
      `INSERT INTO stripe_events (stripe_event_id, event_type, event_data)
       VALUES ($1, $2, $3)
       ON CONFLICT (stripe_event_id) DO NOTHING`,
      [event.id, event.type, JSON.stringify(event.data)]
    );

    switch (event.type) {
      // ✅ PAYMENT SUCCESSFUL
      case 'payment_intent.succeeded':
        const paymentIntent = event.data.object;
        console.log('✅ Payment succeeded:', paymentIntent.id);

        const purchaseId = paymentIntent.metadata?.purchase_id;
        if (purchaseId) {
          // Get previous status for audit
          const prevResult = await pool.query('SELECT status, partner_id FROM purchases WHERE id=$1', [purchaseId]);
          const previousStatus = prevResult.rows[0]?.status || 'UNKNOWN';
          const partnerId = prevResult.rows[0]?.partner_id;

          const result = await pool.query(
            `UPDATE purchases SET stripe_status=$1, payment_intent_id=$2, status='PAID', updated_at=NOW()
             WHERE id=$3 RETURNING *`,
            ['succeeded', paymentIntent.id, purchaseId]
          );

          console.log('💾 Purchase marked as PAID:', result.rows[0]?.id);

          // Log transaction event
          await logTransactionEvent(
            purchaseId,
            'PAID',
            previousStatus,
            'payment_intent.succeeded',
            event.id,
            event.data.object,
            paymentIntent.id,
            partnerId,
            { amount: paymentIntent.amount / 100, currency: paymentIntent.currency }
          );

          // Generate vouchers if not already created
          const vouchersCount = await pool.query(
            'SELECT COUNT(*) FROM vouchers WHERE purchase_id=$1',
            [purchaseId]
          );

          if (parseInt(vouchersCount.rows[0].count) === 0) {
            const purchase = result.rows[0];
            console.log('🎫 Generating vouchers for purchase:', purchaseId);

            for (let i = 0; i < purchase.qty; i++) {
              const code = crypto.randomBytes(6).toString('hex').toUpperCase();
              await pool.query(
                'INSERT INTO vouchers (partner_id, purchase_id, code, status) VALUES ($1, $2, $3, $4)',
                [purchase.partner_id, purchaseId, code, 'AVAILABLE']
              );
            }
            console.log('🎉 Vouchers generated:', purchase.qty);
          }

          logSecurityEvent('PAYMENT_SUCCEEDED', { purchaseId, paymentIntentId: paymentIntent.id, amount: paymentIntent.amount / 100 });
          await logSystemEvent('PAYMENT_STATUS_CHANGED', 'PAYMENT', null, null, purchaseId, {
            stripe_event_type: event.type,
            payment_intent_id: paymentIntent.id,
            stripe_status: 'succeeded'
          });
        }
        break;

      case 'payment_intent.processing':
        const processingPayment = event.data.object;
        if (processingPayment.metadata?.purchase_id) {
          const processingPurchaseId = processingPayment.metadata.purchase_id;
          const prevProcessing = await pool.query('SELECT status, partner_id FROM purchases WHERE id=$1', [processingPurchaseId]);
          const prevStatusProcessing = prevProcessing.rows[0]?.status || 'UNKNOWN';
          const partnerIdProcessing = prevProcessing.rows[0]?.partner_id;

          await pool.query(
            `UPDATE purchases SET stripe_status=$1, payment_intent_id=$2, status='PENDING', updated_at=NOW() WHERE id=$3`,
            ['processing', processingPayment.id, processingPurchaseId]
          );

          await logTransactionEvent(
            processingPurchaseId,
            'PENDING',
            prevStatusProcessing,
            'payment_intent.processing',
            event.id,
            event.data.object,
            processingPayment.id,
            partnerIdProcessing,
            { amount: processingPayment.amount / 100 }
          );

          await logSystemEvent('PAYMENT_STATUS_CHANGED', 'PAYMENT', null, null, processingPurchaseId, {
            stripe_event_type: event.type,
            payment_intent_id: processingPayment.id,
            stripe_status: 'processing'
          });
        }
        break;

      case 'payment_intent.requires_action':
        const actionPayment = event.data.object;
        if (actionPayment.metadata?.purchase_id) {
          const actionPurchaseId = actionPayment.metadata.purchase_id;
          const prevAction = await pool.query('SELECT status, partner_id FROM purchases WHERE id=$1', [actionPurchaseId]);
          const prevStatusAction = prevAction.rows[0]?.status || 'UNKNOWN';
          const partnerIdAction = prevAction.rows[0]?.partner_id;

          await pool.query(
            `UPDATE purchases SET stripe_status=$1, payment_intent_id=$2, status='PENDING', updated_at=NOW() WHERE id=$3`,
            ['requires_action', actionPayment.id, actionPurchaseId]
          );

          await logTransactionEvent(
            actionPurchaseId,
            'PENDING',
            prevStatusAction,
            'payment_intent.requires_action',
            event.id,
            event.data.object,
            actionPayment.id,
            partnerIdAction,
            { requires_action: true, amount: actionPayment.amount / 100 }
          );

          await logSystemEvent('PAYMENT_STATUS_CHANGED', 'PAYMENT', null, null, actionPurchaseId, {
            stripe_event_type: event.type,
            payment_intent_id: actionPayment.id,
            stripe_status: 'requires_action'
          });
        }
        break;

      case 'payment_intent.canceled':
        const canceledPayment = event.data.object;
        if (canceledPayment.metadata?.purchase_id) {
          const canceledPurchaseId = canceledPayment.metadata.purchase_id;
          const prevCanceled = await pool.query('SELECT status, partner_id FROM purchases WHERE id=$1', [canceledPurchaseId]);
          const prevStatusCanceled = prevCanceled.rows[0]?.status || 'UNKNOWN';
          const partnerIdCanceled = prevCanceled.rows[0]?.partner_id;

          await pool.query(
            `UPDATE purchases SET stripe_status=$1, payment_intent_id=$2, status='FAILED', updated_at=NOW() WHERE id=$3`,
            ['canceled', canceledPayment.id, canceledPurchaseId]
          );

          await logTransactionEvent(
            canceledPurchaseId,
            'FAILED',
            prevStatusCanceled,
            'payment_intent.canceled',
            event.id,
            event.data.object,
            canceledPayment.id,
            partnerIdCanceled,
            { cancellation_reason: canceledPayment.cancellation_reason }
          );

          await logSystemEvent('PAYMENT_STATUS_CHANGED', 'PAYMENT', null, null, canceledPurchaseId, {
            stripe_event_type: event.type,
            payment_intent_id: canceledPayment.id,
            stripe_status: 'canceled'
          });
        }
        break;

      // ❌ PAYMENT FAILED
      case 'payment_intent.payment_failed':
        const failedPayment = event.data.object;
        console.log('❌ Payment failed:', failedPayment.id, 'Reason:', failedPayment.last_payment_error?.message);

        const failedPurchaseId = failedPayment.metadata?.purchase_id;
        if (failedPurchaseId) {
          const prevFailed = await pool.query('SELECT status, partner_id FROM purchases WHERE id=$1', [failedPurchaseId]);
          const prevStatusFailed = prevFailed.rows[0]?.status || 'UNKNOWN';
          const partnerIdFailed = prevFailed.rows[0]?.partner_id;

          await pool.query(
            `UPDATE purchases SET stripe_status=$1, payment_intent_id=$2, status='FAILED', updated_at=NOW()
             WHERE id=$3`,
            ['failed', failedPayment.id, failedPurchaseId]
          );

          await logTransactionEvent(
            failedPurchaseId,
            'FAILED',
            prevStatusFailed,
            'payment_intent.payment_failed',
            event.id,
            event.data.object,
            failedPayment.id,
            partnerIdFailed,
            { error_message: failedPayment.last_payment_error?.message, error_code: failedPayment.last_payment_error?.code }
          );

          await logSystemEvent('PAYMENT_STATUS_CHANGED', 'PAYMENT', null, null, failedPurchaseId, {
            stripe_event_type: event.type,
            payment_intent_id: failedPayment.id,
            stripe_status: 'failed',
            error_message: failedPayment.last_payment_error?.message || null
          });
          logSecurityEvent('PAYMENT_FAILED', {
            purchaseId: failedPurchaseId,
            paymentIntentId: failedPayment.id,
            errorMessage: failedPayment.last_payment_error?.message
          });
        }
        break;

      // 🛒 CHECKOUT SESSION COMPLETED
      case 'checkout.session.completed':
        const session = event.data.object;
        console.log('✨ Checkout session completed:', session.id);

        const customer = session.customer;
        const customerEmail = session.customer_details?.email || session.customer_email;
        const customerName = session.customer_details?.name;
        const paymentStatus = session.payment_status;
        const amountTotal = session.amount_total / 100;
        const currency = session.currency;
        const metadata = session.metadata || {};

        console.log('📦 Processing Stripe purchase:', {
          email: customerEmail,
          amount: amountTotal,
          status: paymentStatus
        });

        // Step 1: Sync Stripe customer with app partner/user
        const syncResult = await upsertPartnerAndUserFromStripeCustomer(
          {
            id: customer,
            email: customerEmail,
            name: customerName,
            metadata: {
              ...metadata,
              app_user_id: metadata.app_user_id || null
            }
          },
          'WEBHOOK_CHECKOUT_COMPLETED',
          req
        );

        const partnerId = syncResult.partner_id;

        // Step 2: Retrieve line items from Stripe
        let lineItems = { data: [] };
        let totalQty = 1;

        try {
          lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
            expand: ['data.price.product']
          });

          totalQty = lineItems.data.reduce((sum, item) => sum + item.quantity, 0);
          console.log('🛍️ Line items retrieved:', lineItems.data.length, 'Total quantity:', totalQty);
        } catch (lineItemsError) {
          console.log('⚠️ Could not retrieve line items (test event):', lineItemsError.code);
        }

        // Step 3: Create purchase
        let newPurchaseId = metadata.purchase_id;
        let previousPurchaseStatus = null;

        if (newPurchaseId) {
          const prevPurchaseData = await pool.query('SELECT status FROM purchases WHERE id=$1', [newPurchaseId]);
          previousPurchaseStatus = prevPurchaseData.rows[0]?.status || 'UNKNOWN';

          await pool.query(
            `UPDATE purchases
             SET partner_id=$1, qty=$2, total_price=$3, status=$4, stripe_status=$5, stripe_session_id=$6, payment_intent_id=$7, updated_at=NOW()
             WHERE id=$8`,
            [partnerId, totalQty, amountTotal, paymentStatus === 'paid' ? 'PAID' : 'PENDING', paymentStatus, session.id, session.payment_intent, newPurchaseId]
          );
        } else {
          const purchaseResult = await pool.query(
            `INSERT INTO purchases (partner_id, qty, total_price, status, stripe_status, stripe_session_id, payment_intent_id, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
             RETURNING id`,
            [partnerId, totalQty, amountTotal, paymentStatus === 'paid' ? 'PAID' : 'PENDING', paymentStatus, session.id, session.payment_intent]
          );
          newPurchaseId = purchaseResult.rows[0].id;
          previousPurchaseStatus = 'NEW';
        }
        console.log('💰 Purchase created:', newPurchaseId);

        // Log transaction event for checkout session
        await logTransactionEvent(
          newPurchaseId,
          paymentStatus === 'paid' ? 'PAID' : 'PENDING',
          previousPurchaseStatus || 'NEW',
          'checkout.session.completed',
          event.id,
          event.data.object,
          session.payment_intent,
          partnerId,
          { session_id: session.id, amount: amountTotal, currency }
        );

        // Step 4: Save line items
        for (const item of lineItems.data) {
          const product = item.price?.product;
          const productName = typeof product === 'object' ? product.name : 'Unknown Product';
          const productId = typeof product === 'object' ? product.id : product;
          const unitAmount = item.price?.unit_amount / 100 || 0;
          const totalAmount = item.amount_total / 100;

          await pool.query(
            `INSERT INTO stripe_line_items (purchase_id, stripe_product_id, product_name, quantity, unit_amount, total_amount, currency)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [newPurchaseId, productId, productName, item.quantity, unitAmount, totalAmount, currency]
          );
        }

        console.log('✅ Line items saved:', lineItems.data.length);

        // Step 5: Generate vouchers
        if (paymentStatus === 'paid') {
          console.log('🎫 Generating vouchers...', totalQty);
          for (let i = 0; i < totalQty; i++) {
            const code = crypto.randomBytes(6).toString('hex').toUpperCase();
            await pool.query(
              'INSERT INTO vouchers (partner_id, purchase_id, code, status) VALUES ($1, $2, $3, $4)',
              [partnerId, newPurchaseId, code, 'AVAILABLE']
            );
          }
          console.log('🎉 Vouchers generated:', totalQty);
        }

        logSecurityEvent('CHECKOUT_COMPLETED', {
          sessionId: session.id,
          purchaseId: newPurchaseId,
          customer: customerEmail,
          amount: amountTotal
        });

        await logSystemEvent('PAYMENT_STATUS_CHANGED', 'PAYMENT', syncResult.user_id || null, customer || null, newPurchaseId, {
          stripe_event_type: event.type,
          session_id: session.id,
          stripe_status: paymentStatus
        });

        break;

      case 'checkout.session.async_payment_succeeded':
        const asyncSucceeded = event.data.object;
        if (asyncSucceeded.metadata?.purchase_id) {
          await pool.query(
            `UPDATE purchases SET stripe_status=$1, status='PAID', updated_at=NOW() WHERE id=$2`,
            ['paid', asyncSucceeded.metadata.purchase_id]
          );
          await logSystemEvent('PAYMENT_STATUS_CHANGED', 'PAYMENT', null, asyncSucceeded.customer || null, asyncSucceeded.metadata.purchase_id, {
            stripe_event_type: event.type,
            session_id: asyncSucceeded.id,
            stripe_status: 'paid'
          });
        }
        break;

      case 'checkout.session.async_payment_failed':
        const asyncFailed = event.data.object;
        if (asyncFailed.metadata?.purchase_id) {
          await pool.query(
            `UPDATE purchases SET stripe_status=$1, status='FAILED', updated_at=NOW() WHERE id=$2`,
            ['failed', asyncFailed.metadata.purchase_id]
          );
          await logSystemEvent('PAYMENT_STATUS_CHANGED', 'PAYMENT', null, asyncFailed.customer || null, asyncFailed.metadata.purchase_id, {
            stripe_event_type: event.type,
            session_id: asyncFailed.id,
            stripe_status: 'failed'
          });
        }
        break;

      case 'customer.created':
      case 'customer.updated':
        const customerPayload = event.data.object;
        await upsertPartnerAndUserFromStripeCustomer(customerPayload, event.type, req);
        break;

      case 'customer.deleted':
        const deletedCustomer = event.data.object;
        if (deletedCustomer?.id) {
          await pool.query(
            `UPDATE users SET updated_at=NOW() WHERE stripe_customer_id=$1`,
            [deletedCustomer.id]
          );
          await logSystemEvent('STRIPE_CUSTOMER_DELETED', 'STRIPE_SYNC', null, deletedCustomer.id, null, {
            stripe_event_type: event.type
          }, 'SUCCESS', null, req);
        }
        break;

      // 💳 CHARGE REFUNDED
      case 'charge.refunded':
        const refundedCharge = event.data.object;
        console.log('💸 Charge refunded:', refundedCharge.id, 'Amount:', refundedCharge.amount_refunded / 100);

        const refundPaymentIntent = refundedCharge.payment_intent;
        if (refundPaymentIntent) {
          const refundPurchase = await pool.query(
            'SELECT id, partner_id, status FROM purchases WHERE payment_intent_id=$1',
            [refundPaymentIntent]
          );

          if (refundPurchase.rows[0]) {
            const purchaseId = refundPurchase.rows[0].id;
            const partnerId = refundPurchase.rows[0].partner_id;
            const previousStatus = refundPurchase.rows[0].status;

            await pool.query(
              `UPDATE purchases SET stripe_status=$1, status='REFUNDED', updated_at=NOW()
               WHERE id=$2`,
              ['refunded', purchaseId]
            );

            await logTransactionEvent(
              purchaseId,
              'REFUNDED',
              previousStatus,
              'charge.refunded',
              event.id,
              event.data.object,
              refundPaymentIntent,
              partnerId,
              { amount_refunded: refundedCharge.amount_refunded / 100, refund_reason: refundedCharge.refund_reason }
            );

            // Mark vouchers as revoked
            await pool.query(
              `UPDATE vouchers SET status='REVOKED'
               WHERE purchase_id=$1 AND status='AVAILABLE'`,
              [purchaseId]
            );

            console.log('🔄 Vouchers revoked for purchase:', purchaseId);
            logSecurityEvent('PURCHASE_REFUNDED', { purchaseId, chargeId: refundedCharge.id });
          }
        }
        break;

      // ⏰ CHARGE DISPUTE CREATED
      case 'charge.dispute.created':
        const disputedCharge = event.data.object.charge;
        console.log('⚠️ Dispute created for charge:', disputedCharge);
        logSecurityEvent('CHARGE_DISPUTE', { chargeId: disputedCharge, reason: event.data.object.reason });
        break;

      // 💰 INVOICE PAYMENT SUCCEEDED
      case 'invoice.payment_succeeded':
        const invoice = event.data.object;
        console.log('📄 Invoice payment succeeded:', invoice.id, 'Amount:', invoice.amount_paid / 100);
        logSecurityEvent('INVOICE_PAID', { invoiceId: invoice.id, amount: invoice.amount_paid / 100 });
        break;

      // ⚠️ INVOICE PAYMENT FAILED
      case 'invoice.payment_failed':
        const failedInvoice = event.data.object;
        console.log('📄 Invoice payment failed:', failedInvoice.id);
        logSecurityEvent('INVOICE_PAYMENT_FAILED', { invoiceId: failedInvoice.id });
        break;

      default:
        console.log('ℹ️ Unhandled event type:', event.type);
    }

    // Mark event as processed
    await pool.query(
      'UPDATE stripe_events SET processed=TRUE, processed_at=NOW() WHERE stripe_event_id=$1',
      [event.id]
    );

    res.json({ received: true, processed: true });
  } catch (e) {
    console.error('❌ Webhook processing error:', e);
    logSecurityEvent('WEBHOOK_ERROR', { error: e.message, eventType: event.type });
    res.status(400).json({ error: e.message });
  }
});

// Admin: list purchases (include partner info, stripe status, and line items)
router.get('/admin/purchases', authenticate, requireAnyPermission(['purchases', 'financial_ops'], 'view'), async (req, res) => {
  try {
    const { payment_method, partner_id, status } = req.query;
    const conditions = [];
    const params = [];

    if (payment_method) { params.push(payment_method);              conditions.push(`p.payment_method=$${params.length}`); }
    if (partner_id)     { params.push(parseInt(partner_id, 10));    conditions.push(`p.partner_id=$${params.length}`); }
    if (status)         { params.push(status.toUpperCase());        conditions.push(`p.status=$${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const r = await pool.query(`
      SELECT p.id, p.partner_id, p.qty, p.total_price, p.stripe_link, p.stripe_status,
             p.payment_intent_id, p.payment_method, p.external_reference, p.notes,
             p.status, p.expires_at, p.created_at, p.updated_at,
             pt.name AS partner_name, pt.email AS partner_email,
             (SELECT v2.complimentary_reason FROM vouchers v2
              WHERE v2.purchase_id = p.id LIMIT 1) AS complimentary_reason,
             (SELECT COALESCE(NULLIF(TRIM(CONCAT(u.first_name,' ',u.last_name)),''), u.email)
              FROM vouchers v2 LEFT JOIN users u ON u.id = v2.complimentary_issued_by
              WHERE v2.purchase_id = p.id AND v2.complimentary_issued_by IS NOT NULL LIMIT 1) AS complimentary_issued_by_name,
             (SELECT u.email FROM vouchers v2 LEFT JOIN users u ON u.id = v2.complimentary_issued_by
              WHERE v2.purchase_id = p.id AND v2.complimentary_issued_by IS NOT NULL LIMIT 1) AS complimentary_issued_by_email
      FROM purchases p
      LEFT JOIN partners pt ON pt.id = p.partner_id
      ${where}
      ORDER BY p.created_at DESC
    `, params);

    for (const purchase of r.rows) {
      const items = await pool.query('SELECT * FROM stripe_line_items WHERE purchase_id=$1', [purchase.id]);
      purchase.line_items = items.rows;
    }

    res.json(r.rows);
  } catch (e) {
    console.error('Error fetching purchases:', e);
    res.status(400).json({ error: e.message });
  }
});

// Admin: list Stripe customers
router.get('/admin/stripe-customers', authenticate, requireRole('admin'), async (req,res)=>{
  try{
    const r = await pool.query(`
      SELECT sc.*, pt.name as partner_name, pt.email as partner_email
      FROM stripe_customers sc
      LEFT JOIN partners pt ON pt.id = sc.partner_id
      ORDER BY sc.created_at DESC
    `);
    res.json(r.rows);
  }catch(e){
    console.error('Error fetching customers:', e);
    res.status(400).json({error:e.message});
  }
});

// Admin: Get all transaction events (paginated and filterable)
router.get('/admin/transaction-events', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const purchaseId = req.query.purchase_id;
    const partnerId = req.query.partner_id;
    const eventType = req.query.event_type;
    const status = req.query.status; // new_status

    let query = 'SELECT COUNT(*) FROM transaction_events WHERE 1=1';
    let params = [];
    let paramNum = 1;

    if (purchaseId) {
      query = query.replace('WHERE 1=1', `WHERE purchase_id=$${paramNum}`);
      params.push(purchaseId);
      paramNum++;
    }
    if (partnerId) {
      query += ` AND partner_id=$${paramNum}`;
      params.push(partnerId);
      paramNum++;
    }
    if (eventType) {
      query += ` AND event_type=$${paramNum}`;
      params.push(eventType);
      paramNum++;
    }
    if (status) {
      query += ` AND new_status=$${paramNum}`;
      params.push(status);
      paramNum++;
    }

    // Get total count
    const countResult = await pool.query(query, params);
    const total = parseInt(countResult.rows[0].count);

    // Get transaction events
    let selectQuery = `
      SELECT te.id, te.purchase_id, te.partner_id, te.payment_intent_id, te.previous_status,
             te.new_status, te.event_type, te.stripe_event_id, te.metadata, te.created_at,
             p.total_price, p.qty, p.status as purchase_status,
             pt.name as partner_name, pt.email as partner_email
      FROM transaction_events te
      LEFT JOIN purchases p ON te.purchase_id = p.id
      LEFT JOIN partners pt ON te.partner_id = pt.id
      WHERE 1=1`;

    if (purchaseId) {
      selectQuery = selectQuery.replace('WHERE 1=1', `WHERE te.purchase_id=$1`);
      paramNum = 2;
    } else {
      paramNum = 1;
    }

    if (partnerId) {
      selectQuery += ` AND te.partner_id=$${paramNum}`;
      paramNum++;
    }
    if (eventType) {
      selectQuery += ` AND te.event_type=$${paramNum}`;
      paramNum++;
    }
    if (status) {
      selectQuery += ` AND te.new_status=$${paramNum}`;
      paramNum++;
    }

    selectQuery += ` ORDER BY te.created_at DESC LIMIT $${paramNum} OFFSET $${paramNum + 1}`;

    const eventParams = [...params, limit, offset];
    const result = await pool.query(selectQuery, eventParams);

    res.json({
      events: result.rows,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (e) {
    console.error('Error fetching transaction events:', e);
    res.status(400).json({ error: 'Error al obtener eventos de transacción' });
  }
});

// Admin: Get transaction history for a specific purchase
router.get('/admin/purchases/:purchaseId/transaction-history', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  const { purchaseId } = req.params;

  try {
    // Verify the purchase exists
    const purchaseCheck = await pool.query('SELECT id, partner_id FROM purchases WHERE id=$1', [purchaseId]);

    if (purchaseCheck.rowCount === 0) {
      return res.status(404).json({ error: 'Purchase not found' });
    }

    const partnerId = purchaseCheck.rows[0].partner_id;

    // Get transaction events for this purchase
    const events = await pool.query(
      `SELECT id, purchase_id, previous_status, new_status, event_type, stripe_event_id,
              stripe_event_data, metadata, created_at
       FROM transaction_events
       WHERE purchase_id=$1
       ORDER BY created_at ASC`,
      [purchaseId]
    );

    res.json({
      purchase_id: purchaseId,
      partner_id: partnerId,
      events: events.rows
    });
  } catch (e) {
    console.error('Error fetching transaction history:', e);
    res.status(400).json({ error: 'Error al obtener historial de transacción' });
  }
});

// Admin: Get transaction event summary by status (for dashboard)
router.get('/admin/transaction-events/summary', authenticate, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const summary = await pool.query(`
      SELECT
        new_status,
        COUNT(*) as count,
        COUNT(DISTINCT partner_id) as unique_partners,
        COUNT(DISTINCT purchase_id) as unique_purchases
      FROM transaction_events
      GROUP BY new_status
      ORDER BY count DESC
    `);

    const totalEvents = await pool.query('SELECT COUNT(*) FROM transaction_events');
    const uptime24h = await pool.query(`
      SELECT COUNT(*) FROM transaction_events
      WHERE created_at >= NOW() - INTERVAL '24 hours'
    `);

    res.json({
      status_summary: summary.rows,
      total_events: parseInt(totalEvents.rows[0].count),
      events_24h: parseInt(uptime24h.rows[0].count)
    });
  } catch (e) {
    console.error('Error fetching transaction summary:', e);
    res.status(400).json({ error: 'Error al obtener resumen de transacciones' });
  }
});

router.get('/partner/:id/payments', authenticate, async (req, res) => {
  const pid = req.params.id;
  if (req.user && req.user.role !== 'admin') {
    if (!req.user.partner_id || String(req.user.partner_id) !== String(pid)) {
      return res.status(403).json({ error: 'forbidden' });
    }
  }

  try {
    const payments = await pool.query(
      `SELECT p.id, p.partner_id, p.qty, p.total_price, p.status, p.stripe_status,
              p.payment_intent_id, p.stripe_session_id, p.payment_method,
              p.external_reference, p.notes, p.created_at, p.updated_at,
              (SELECT v2.complimentary_reason FROM vouchers v2
               WHERE v2.purchase_id = p.id LIMIT 1) AS complimentary_reason
       FROM purchases p
       WHERE p.partner_id=$1
       ORDER BY p.created_at DESC`,
      [pid]
    );
    res.json(payments.rows);
  } catch (e) {
    res.status(400).json({ error: 'Error al obtener estados de pago' });
  }
});

router.get('/partner/:id/purchases/:purchaseId/status', authenticate, apiLimiter, async (req, res) => {
  const { id: partnerId, purchaseId } = req.params;
  const sessionIdFromQuery = (req.query.session_id || '').toString().trim();

  if (req.user && req.user.role !== 'admin') {
    if (!req.user.partner_id || String(req.user.partner_id) !== String(partnerId)) {
      return res.status(403).json({ error: 'forbidden' });
    }
  }

  try {
    const purchase = await pool.query(
      `SELECT id, partner_id, status, stripe_status, payment_intent_id, created_at, updated_at
       FROM purchases
       WHERE id=$1 AND partner_id=$2`,
      [purchaseId, partnerId]
    );

    if (purchase.rowCount === 0) {
      return res.status(404).json({ error: 'Purchase not found' });
    }

    let p = purchase.rows[0];
    let isPaid = p.status === 'PAID' || p.stripe_status === 'succeeded' || p.stripe_status === 'paid';

    if (!isPaid) {
      const sessionToCheck = sessionIdFromQuery || p.stripe_session_id;
      if (sessionToCheck) {
        try {
          const session = await stripe.checkout.sessions.retrieve(sessionToCheck, {
            expand: ['payment_intent']
          });

          if (session?.metadata?.purchase_id && String(session.metadata.purchase_id) !== String(purchaseId)) {
            return res.status(400).json({ error: 'session_id no corresponde con la compra' });
          }

          const stripeStatus = session.payment_status || p.stripe_status || 'pending';
          const paidNow = stripeStatus === 'paid';
          const paymentIntentId = typeof session.payment_intent === 'object'
            ? session.payment_intent.id
            : (session.payment_intent || p.payment_intent_id || null);

          await pool.query(
            `UPDATE purchases
             SET stripe_status=$1,
                 status=$2,
                 payment_intent_id=$3,
                 stripe_session_id=$4,
                 updated_at=NOW()
             WHERE id=$5`,
            [stripeStatus, paidNow ? 'PAID' : p.status, paymentIntentId, session.id, purchaseId]
          );

          if (paidNow) {
            const existingVouchers = await pool.query('SELECT COUNT(*) FROM vouchers WHERE purchase_id=$1', [purchaseId]);
            if (parseInt(existingVouchers.rows[0].count, 10) === 0) {
              for (let i = 0; i < p.qty; i++) {
                const code = crypto.randomBytes(6).toString('hex').toUpperCase();
                await pool.query(
                  'INSERT INTO vouchers (partner_id, purchase_id, code, status) VALUES ($1, $2, $3, $4)',
                  [partnerId, purchaseId, code, 'AVAILABLE']
                );
              }
            }
          }

          const refreshed = await pool.query(
            `SELECT id, partner_id, status, stripe_status, payment_intent_id, stripe_session_id
             FROM purchases
             WHERE id=$1 AND partner_id=$2`,
            [purchaseId, partnerId]
          );
          p = refreshed.rows[0] || p;
          isPaid = p.status === 'PAID' || p.stripe_status === 'succeeded' || p.stripe_status === 'paid';
        } catch (syncErr) {
          console.warn('No se pudo reconciliar compra con Stripe en status endpoint:', syncErr.message);
        }
      }
    }

    return res.json({
      purchase_id: p.id,
      status: p.status,
      stripe_status: p.stripe_status,
      stripe_session_id: p.stripe_session_id || null,
      payment_intent_id: p.payment_intent_id,
      is_paid: isPaid,
      can_manage_vouchers: isPaid
    });
  } catch (e) {
    return res.status(400).json({ error: 'Error al obtener estado del pago' });
  }
});

// Partner: Get transaction state history for a specific purchase
router.get('/partner/:id/purchases/:purchaseId/transaction-history', authenticate, async (req, res) => {
  const { id: partnerId, purchaseId } = req.params;

  // Authorization: check if user belongs to this partner
  if (req.user && req.user.role !== 'admin') {
    if (!req.user.partner_id || String(req.user.partner_id) !== String(partnerId)) {
      return res.status(403).json({ error: 'forbidden' });
    }
  }

  try {
    // Verify the purchase belongs to this partner
    const purchaseCheck = await pool.query(
      'SELECT id, partner_id FROM purchases WHERE id=$1 AND partner_id=$2',
      [purchaseId, partnerId]
    );

    if (purchaseCheck.rowCount === 0) {
      return res.status(404).json({ error: 'Purchase not found' });
    }

    // Get transaction events
    const events = await pool.query(
      `SELECT id, purchase_id, previous_status, new_status, event_type, stripe_event_id,
              metadata, created_at
       FROM transaction_events
       WHERE purchase_id=$1
       ORDER BY created_at ASC`,
      [purchaseId]
    );

    res.json({
      purchase_id: purchaseId,
      events: events.rows
    });
  } catch (e) {
    console.error('Error fetching transaction history:', e);
    res.status(400).json({ error: 'Error al obtener historial de transacción' });
  }
});

// Partner: Get all transaction events for all their purchases (paginated)
router.get('/partner/:id/transaction-events', authenticate, apiLimiter, async (req, res) => {
  const partnerId = req.params.id;

  // Authorization: check if user belongs to this partner
  if (req.user && req.user.role !== 'admin') {
    if (!req.user.partner_id || String(req.user.partner_id) !== String(partnerId)) {
      return res.status(403).json({ error: 'forbidden' });
    }
  }

  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    // Get total count
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM transaction_events WHERE partner_id=$1',
      [partnerId]
    );
    const total = parseInt(countResult.rows[0].count);

    // Get paginated transaction events
    const events = await pool.query(
      `SELECT te.id, te.purchase_id, te.previous_status, te.new_status, te.event_type,
              te.stripe_event_id, te.metadata, te.created_at,
              p.id as purchase_id, p.total_price, p.qty
       FROM transaction_events te
       LEFT JOIN purchases p ON te.purchase_id = p.id
       WHERE te.partner_id=$1
       ORDER BY te.created_at DESC
       LIMIT $2 OFFSET $3`,
      [partnerId, limit, offset]
    );

    res.json({
      events: events.rows,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (e) {
    console.error('Error fetching transaction events:', e);
    res.status(400).json({ error: 'Error al obtener eventos de transacción' });
  }
});

// Stripe webhook simulation (for testing without real Stripe): update purchase status
router.post('/stripe/webhook', async (req,res)=>{
  const { purchase_id, status } = req.body; // status: PAID or FAILED
  try{
    const p = await pool.query('UPDATE purchases SET status=$1 WHERE id=$2 RETURNING *',[status,purchase_id]);
    if(status === 'PAID'){
      // create vouchers for the purchase
      const purchase = p.rows[0];
      const qty = purchase.qty;
      const partner_id = purchase.partner_id;
      const created = [];
      for(let i=0;i<qty;i++){
        const code = crypto.randomBytes(6).toString('hex').toUpperCase();
        const v = await pool.query('INSERT INTO vouchers (partner_id,purchase_id,code) VALUES ($1,$2,$3) RETURNING *',[partner_id,purchase_id,code]);
        created.push(v.rows[0]);
      }
      res.json({ok:true,created});
    }else{
      res.json({ok:true});
    }
  }catch(e){ res.status(400).json({error:e.message}); }
});

// ── Vouchers de cortesía y compras externas ───────────────────────────────────

// POST /admin/partners/:id/vouchers/complimentary
router.post('/admin/partners/:id/vouchers/complimentary',
  authenticate, requirePermission('financial_ops', 'edit'), apiLimiter,
  param('id').isInt({ min: 1 }),
  body('quantity').isInt({ min: 1, max: 500 }).withMessage('quantity debe ser entre 1 y 500'),
  body('reason').trim().notEmpty().withMessage('reason es obligatorio'),
  handleValidationErrors,
  async (req, res) => {
    const partnerId = parseInt(req.params.id, 10);
    const { quantity, reason } = req.body;
    try {
      const partnerRow = await pool.query('SELECT id, name FROM partners WHERE id=$1', [partnerId]);
      if (partnerRow.rowCount === 0) return res.status(404).json({ error: 'Partner no encontrado' });

      const purchaseRes = await pool.query(
        `INSERT INTO purchases (partner_id, qty, total_price, status, payment_method)
         VALUES ($1, $2, 0, 'PAID', 'complimentary') RETURNING id`,
        [partnerId, quantity]
      );
      const purchaseId = purchaseRes.rows[0].id;

      for (let i = 0; i < quantity; i++) {
        await pool.query(
          `INSERT INTO vouchers (partner_id, purchase_id, code, status, voucher_type, complimentary_reason, complimentary_issued_by)
           VALUES ($1, $2, $3, 'AVAILABLE', 'COMPLIMENTARY', $4, $5)`,
          [partnerId, purchaseId, generateVoucherCode(), reason, req.user.sub]
        );
      }

      await logSystemEvent('COMPLIMENTARY_VOUCHERS_ISSUED', 'VOUCHER', req.user.sub, null, purchaseId,
        { partner_id: partnerId, partner_name: partnerRow.rows[0].name, quantity, reason },
        'SUCCESS', null, req);

      res.json({ ok: true, purchase_id: purchaseId, vouchers_created: quantity });
    } catch (e) {
      console.error('❌ Error emitiendo vouchers de cortesía:', e);
      res.status(500).json({ error: 'Error al emitir vouchers de cortesía' });
    }
  }
);

// POST /admin/partners/:id/purchases/external
router.post('/admin/partners/:id/purchases/external',
  authenticate, requirePermission('financial_ops', 'edit'), apiLimiter,
  param('id').isInt({ min: 1 }),
  body('qty').isInt({ min: 1, max: 10000 }).withMessage('qty debe ser entre 1 y 10000'),
  body('total_price').isFloat({ min: 0 }).withMessage('total_price debe ser un número positivo'),
  body('payment_method').isIn(EXTERNAL_PAYMENT_METHODS).withMessage(`payment_method debe ser: ${EXTERNAL_PAYMENT_METHODS.join(', ')}`),
  body('external_reference').optional().trim(),
  body('notes').optional().trim(),
  handleValidationErrors,
  async (req, res) => {
    const partnerId = parseInt(req.params.id, 10);
    const { qty, total_price, payment_method, external_reference, notes } = req.body;
    try {
      const partnerRow = await pool.query('SELECT id, name FROM partners WHERE id=$1', [partnerId]);
      if (partnerRow.rowCount === 0) return res.status(404).json({ error: 'Partner no encontrado' });

      const purchaseRes = await pool.query(
        `INSERT INTO purchases (partner_id, qty, total_price, status, payment_method, external_reference, notes)
         VALUES ($1, $2, $3, 'PAID', $4, $5, $6) RETURNING id`,
        [partnerId, qty, total_price, payment_method, external_reference || null, notes || null]
      );
      const purchaseId = purchaseRes.rows[0].id;

      for (let i = 0; i < qty; i++) {
        await pool.query(
          `INSERT INTO vouchers (partner_id, purchase_id, code, status, voucher_type)
           VALUES ($1, $2, $3, 'AVAILABLE', 'STANDARD')`,
          [partnerId, purchaseId, generateVoucherCode()]
        );
      }

      await logSystemEvent('EXTERNAL_PURCHASE_CREATED', 'PURCHASE', req.user.sub, null, purchaseId,
        { partner_id: partnerId, partner_name: partnerRow.rows[0].name, qty, total_price, payment_method, external_reference },
        'SUCCESS', null, req);

      res.json({ ok: true, purchase_id: purchaseId, vouchers_created: qty, total_price });
    } catch (e) {
      console.error('❌ Error registrando compra externa:', e);
      res.status(500).json({ error: 'Error al registrar compra externa' });
    }
  }
);

// PUT /admin/purchases/:id/adjust  — corregir compras externas o de cortesía
router.put('/admin/purchases/:id/adjust',
  authenticate, requirePermission('financial_ops', 'edit'), apiLimiter,
  param('id').isInt({ min: 1 }),
  body('partner_id').optional().isInt({ min: 1 }),
  body('qty').optional().isInt({ min: 1, max: 10000 }),
  body('total_price').optional().isFloat({ min: 0 }),
  body('payment_method').optional().isIn(ADJUSTABLE_PAYMENT_METHODS),
  body('external_reference').optional().trim(),
  body('notes').optional().trim(),
  body('complimentary_reason').optional().trim(),
  handleValidationErrors,
  async (req, res) => {
    const purchaseId = parseInt(req.params.id, 10);
    try {
      const existing = await pool.query(
        'SELECT id, payment_method, qty, total_price, external_reference, notes FROM purchases WHERE id=$1',
        [purchaseId]
      );
      if (existing.rowCount === 0) return res.status(404).json({ error: 'Compra no encontrada' });

      const current = existing.rows[0];
      if (!ADJUSTABLE_PAYMENT_METHODS.includes(current.payment_method)) {
        return res.status(400).json({ error: 'Solo se pueden ajustar compras externas o de cortesía, no las de Stripe' });
      }

      const { partner_id, qty, total_price, payment_method, external_reference, notes, complimentary_reason } = req.body;

      // Validar partner si se proveyó
      if (partner_id !== undefined) {
        const partnerCheck = await pool.query('SELECT id FROM partners WHERE id=$1', [partner_id]);
        if (partnerCheck.rowCount === 0) return res.status(400).json({ error: 'Partner no encontrado' });
      }

      // Construir diff solo con los campos provistos
      const changes = {};
      if (partner_id       !== undefined) changes.partner_id       = { from: current.partner_id,       to: partner_id };
      if (qty              !== undefined) changes.qty              = { from: current.qty,              to: qty };
      if (total_price      !== undefined) changes.total_price      = { from: current.total_price,      to: total_price };
      if (payment_method   !== undefined) changes.payment_method   = { from: current.payment_method,   to: payment_method };
      if (external_reference !== undefined) changes.external_reference = { from: current.external_reference, to: external_reference };
      if (notes            !== undefined) changes.notes            = { from: current.notes,            to: notes };

      if (Object.keys(changes).length === 0 && complimentary_reason === undefined) {
        return res.status(400).json({ error: 'No se proveyó ningún campo a actualizar' });
      }

      // Reconciliación previa: validar que qty reducida sea alcanzable
      if (qty !== undefined && qty < current.qty) {
        const voucherCounts = await pool.query(
          `SELECT COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE status='AVAILABLE') AS available
           FROM vouchers WHERE purchase_id=$1`,
          [purchaseId]
        );
        const totalVouchers = parseInt(voucherCounts.rows[0].total, 10);
        const availableVouchers = parseInt(voucherCounts.rows[0].available, 10);
        const toDelete = totalVouchers - qty;
        if (toDelete > availableVouchers) {
          return res.status(400).json({
            error: `No se puede reducir a ${qty} vouchers: ${totalVouchers - availableVouchers} ya fueron consumidos y no se pueden eliminar`
          });
        }
      }

      // UPDATE compra
      await pool.query(
        `UPDATE purchases SET
           partner_id        = COALESCE($1, partner_id),
           qty               = COALESCE($2, qty),
           total_price       = COALESCE($3, total_price),
           payment_method    = COALESCE($4, payment_method),
           external_reference = COALESCE($5, external_reference),
           notes             = COALESCE($6, notes),
           updated_at        = NOW()
         WHERE id=$7`,
        [
          partner_id       !== undefined ? partner_id       : null,
          qty              !== undefined ? qty              : null,
          total_price      !== undefined ? total_price      : null,
          payment_method   !== undefined ? payment_method   : null,
          external_reference !== undefined ? external_reference : null,
          notes            !== undefined ? notes            : null,
          purchaseId
        ]
      );

      // Si es de cortesía y se actualiza la razón, actualizar en todos sus vouchers
      if (complimentary_reason !== undefined && current.payment_method === 'complimentary') {
        changes.complimentary_reason = { to: complimentary_reason };
        await pool.query(
          `UPDATE vouchers SET complimentary_reason=$1 WHERE purchase_id=$2`,
          [complimentary_reason, purchaseId]
        );
      }

      // Reconciliación de vouchers si qty cambió
      if (qty !== undefined && qty !== current.qty) {
        const voucherRow = await pool.query(
          'SELECT COUNT(*) AS total FROM vouchers WHERE purchase_id=$1',
          [purchaseId]
        );
        const currentVoucherCount = parseInt(voucherRow.rows[0].total, 10);
        const effectivePartnerId = partner_id !== undefined ? partner_id : current.partner_id;
        const effectiveMethod    = payment_method !== undefined ? payment_method : current.payment_method;

        if (qty > currentVoucherCount) {
          // Crear vouchers faltantes
          const toCreate = qty - currentVoucherCount;
          const isComplimentary = effectiveMethod === 'complimentary';

          if (isComplimentary) {
            const reasonRow = await pool.query(
              'SELECT complimentary_reason, complimentary_issued_by FROM vouchers WHERE purchase_id=$1 LIMIT 1',
              [purchaseId]
            );
            const reason   = complimentary_reason || (reasonRow.rowCount > 0 ? reasonRow.rows[0].complimentary_reason : 'Ajuste');
            const issuedBy = reasonRow.rowCount > 0 ? reasonRow.rows[0].complimentary_issued_by : req.user.sub;
            for (let i = 0; i < toCreate; i++) {
              await pool.query(
                `INSERT INTO vouchers (partner_id, purchase_id, code, status, voucher_type, complimentary_reason, complimentary_issued_by)
                 VALUES ($1, $2, $3, 'AVAILABLE', 'COMPLIMENTARY', $4, $5)`,
                [effectivePartnerId, purchaseId, generateVoucherCode(), reason, issuedBy]
              );
            }
          } else {
            for (let i = 0; i < toCreate; i++) {
              await pool.query(
                `INSERT INTO vouchers (partner_id, purchase_id, code, status, voucher_type)
                 VALUES ($1, $2, $3, 'AVAILABLE', 'STANDARD')`,
                [effectivePartnerId, purchaseId, generateVoucherCode()]
              );
            }
          }
          changes.vouchers_created = toCreate;

        } else if (qty < currentVoucherCount) {
          // Eliminar vouchers AVAILABLE sobrantes (los más recientes primero)
          const toDelete = currentVoucherCount - qty;
          const availableRows = await pool.query(
            'SELECT id FROM vouchers WHERE purchase_id=$1 AND status=$2 ORDER BY id DESC LIMIT $3',
            [purchaseId, 'AVAILABLE', toDelete]
          );
          const idsToDelete = availableRows.rows.map(r => r.id);
          if (idsToDelete.length > 0) {
            await pool.query('DELETE FROM vouchers WHERE id = ANY($1)', [idsToDelete]);
          }
          changes.vouchers_deleted = idsToDelete.length;
        }
      }

      await logSystemEvent('PURCHASE_ADJUSTED', 'PURCHASE', req.user.sub, null, purchaseId,
        { purchase_id: purchaseId, changes }, 'SUCCESS', null, req);

      const updated = await pool.query(
        `SELECT p.id, p.partner_id, p.qty, p.total_price, p.status, p.payment_method,
                p.external_reference, p.notes,
                COUNT(v.id)::int AS vouchers_total,
                COUNT(v.id) FILTER (WHERE v.status='AVAILABLE')::int AS vouchers_available,
                COUNT(v.id) FILTER (WHERE v.status='CONSUMED')::int  AS vouchers_consumed
         FROM purchases p
         LEFT JOIN vouchers v ON v.purchase_id = p.id
         WHERE p.id=$1
         GROUP BY p.id`,
        [purchaseId]
      );
      res.json({ ok: true, purchase: updated.rows[0], changes });
    } catch (e) {
      console.error('❌ Error ajustando compra:', e);
      res.status(500).json({ error: 'Error al ajustar la compra' });
    }
  }
);

// GET /admin/purchases/:id  — detalle de una compra
router.get('/admin/purchases/:id',
  authenticate, requirePermission('financial_ops', 'view'), apiLimiter,
  param('id').isInt({ min: 1 }),
  handleValidationErrors,
  async (req, res) => {
    const purchaseId = parseInt(req.params.id, 10);
    try {
      const result = await pool.query(
        `SELECT p.id, p.partner_id, pr.name AS partner_name, p.qty, p.total_price,
                p.status, p.payment_method, p.external_reference, p.notes,
                p.stripe_status, p.created_at, p.updated_at,
                COUNT(v.id)::int AS vouchers_total,
                COUNT(v.id) FILTER (WHERE v.status='AVAILABLE')::int AS vouchers_available,
                COUNT(v.id) FILTER (WHERE v.status='CONSUMED')::int  AS vouchers_consumed
         FROM purchases p
         JOIN partners pr ON pr.id = p.partner_id
         LEFT JOIN vouchers v ON v.purchase_id = p.id
         WHERE p.id=$1
         GROUP BY p.id, pr.name`,
        [purchaseId]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: 'Compra no encontrada' });
      res.json(result.rows[0]);
    } catch (e) {
      res.status(500).json({ error: 'Error al obtener detalle de compra' });
    }
  }
);

module.exports = router;
