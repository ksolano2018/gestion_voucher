/**
 * Tests para el endpoint POST /webhook/stripe
 *
 * Verifica que:
 * - En produccion se rechaza si falta STRIPE_WEBHOOK_SECRET
 * - Se rechaza si falta la cabecera stripe-signature
 * - Se rechaza si la firma es invalida
 */

const request = require('supertest');

jest.mock('pg', () => {
  const queryMock = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const PoolMock = jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue({ query: queryMock, release: jest.fn() }),
    query: queryMock,
    on: jest.fn(),
    end: jest.fn().mockResolvedValue(undefined),
  }));
  return { Pool: PoolMock };
});

const stripeMock = {
  webhooks: {
    constructEvent: jest.fn(),
  },
  checkout: { sessions: { create: jest.fn() } },
  customers: { list: jest.fn().mockResolvedValue({ data: [] }) },
};

jest.mock('stripe', () => jest.fn().mockImplementation(() => stripeMock));

let app;

beforeAll(() => {
  ({ app } = require('../app'));
});

describe('POST /webhook/stripe', () => {
  const WEBHOOK_SECRET = 'whsec_test_secret';

  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    stripeMock.webhooks.constructEvent.mockReset();
  });

  afterEach(() => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  test('rechaza si falta la cabecera stripe-signature', async () => {
    const res = await request(app)
      .post('/webhook/stripe')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ type: 'payment_intent.succeeded' }));

    expect(res.status).toBe(400);
  });

  test('rechaza si la firma de stripe es invalida', async () => {
    stripeMock.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature for payload');
    });

    const res = await request(app)
      .post('/webhook/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'invalid_signature')
      .send(JSON.stringify({ type: 'payment_intent.succeeded' }));

    expect(res.status).toBe(400);
    expect(res.text).toMatch(/Webhook Error/);
  });

  test('procesa el evento si la firma es valida', async () => {
    const fakeEvent = {
      id: 'evt_test_123',
      type: 'checkout.session.completed',
      data: { object: {} },
    };
    stripeMock.webhooks.constructEvent.mockReturnValue(fakeEvent);

    const { Pool } = require('pg');
    const poolInstance = new Pool();
    poolInstance.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post('/webhook/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'valid_signature')
      .send(JSON.stringify(fakeEvent));

    expect(stripeMock.webhooks.constructEvent).toHaveBeenCalledWith(
      expect.any(Buffer),
      'valid_signature',
      WEBHOOK_SECRET
    );
    expect(res.status).toBe(200);
  });

  test('en produccion rechaza si STRIPE_WEBHOOK_SECRET no esta configurado', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      const res = await request(app)
        .post('/webhook/stripe')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ type: 'payment_intent.succeeded' }));

      expect(res.status).toBe(500);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});
