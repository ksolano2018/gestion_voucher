/**
 * Tests para endpoints de autenticacion (/oauth/token, /oauth/refresh, /oauth/logout)
 *
 * Usan mocks de pg y bcrypt para no requerir BD real.
 */

const request = require('supertest');

// --- Mocks ANTES de importar la app ---

jest.mock('pg', () => {
  const queryMock = jest.fn();
  const releaseMock = jest.fn();
  const connectMock = jest.fn().mockResolvedValue({ query: queryMock, release: releaseMock });

  const PoolMock = jest.fn().mockImplementation(() => ({
    connect: connectMock,
    query: queryMock,
    on: jest.fn(),
    end: jest.fn().mockResolvedValue(undefined),
  }));

  return { Pool: PoolMock };
});

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    webhooks: { constructEvent: jest.fn() },
    checkout: { sessions: { create: jest.fn() } },
    customers: { list: jest.fn().mockResolvedValue({ data: [] }) },
  }));
});

const bcrypt = require('bcrypt');
const { Pool } = require('pg');

let app, pool;

beforeAll(() => {
  ({ app, pool } = require('../app'));
});

afterAll(async () => {
  if (pool?.end) await pool.end();
});

// Helper: configura el mock de pool.query para devolver un resultado especifico
function mockQuery(rows = [], rowCount = null) {
  pool.query.mockResolvedValueOnce({
    rows,
    rowCount: rowCount ?? rows.length,
  });
}

// ============================================================
// /oauth/token - Validacion de inputs
// ============================================================

describe('POST /oauth/token - validacion de inputs', () => {
  test('rechaza si falta grant_type', async () => {
    const res = await request(app)
      .post('/oauth/token')
      .send({ username: 'test@test.com', password: 'Abc@1234' });

    expect(res.status).toBe(400);
    expect(res.body.errors).toBeDefined();
  });

  test('rechaza grant_type incorrecto', async () => {
    const res = await request(app)
      .post('/oauth/token')
      .send({ grant_type: 'client_credentials', username: 'test@test.com', password: 'Abc@1234' });

    expect(res.status).toBe(400);
    expect(res.body.errors).toBeDefined();
  });

  test('rechaza email invalido', async () => {
    const res = await request(app)
      .post('/oauth/token')
      .send({ grant_type: 'password', username: 'not-an-email', password: 'Abc@1234' });

    expect(res.status).toBe(400);
    expect(res.body.errors).toBeDefined();
  });

  test('rechaza password muy corta', async () => {
    const res = await request(app)
      .post('/oauth/token')
      .send({ grant_type: 'password', username: 'test@test.com', password: '123' });

    expect(res.status).toBe(400);
    expect(res.body.errors).toBeDefined();
  });
});

// ============================================================
// /oauth/token - Logica de autenticacion (con mock de BD)
// ============================================================

describe('POST /oauth/token - logica de autenticacion', () => {
  test('devuelve 400 si el usuario no existe', async () => {
    mockQuery([], 0); // users table: no rows

    const res = await request(app)
      .post('/oauth/token')
      .send({ grant_type: 'password', username: 'noexiste@test.com', password: 'Abc@1234' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  test('devuelve 400 si la password es incorrecta', async () => {
    const hashedPwd = await bcrypt.hash('CorrectPass@1', 10);
    mockQuery([{ id: 1, email: 'user@test.com', password: hashedPwd, role: 'partner', partner_id: 1, must_change_password: false }]);

    const res = await request(app)
      .post('/oauth/token')
      .send({ grant_type: 'password', username: 'user@test.com', password: 'WrongPass@1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  test('devuelve must_change_password si la cuenta lo requiere', async () => {
    const hashedPwd = await bcrypt.hash('TempPass@1', 10);
    mockQuery([{ id: 2, email: 'newuser@test.com', password: hashedPwd, role: 'partner', partner_id: 1, must_change_password: true }]);

    const res = await request(app)
      .post('/oauth/token')
      .send({ grant_type: 'password', username: 'newuser@test.com', password: 'TempPass@1' });

    expect(res.status).toBe(200);
    expect(res.body.must_change_password).toBe(true);
  });
});

// ============================================================
// /oauth/refresh - validacion
// ============================================================

describe('POST /oauth/refresh', () => {
  test('rechaza si no hay cookie de refresh_token', async () => {
    const res = await request(app).post('/oauth/refresh');
    expect(res.status).toBe(401);
  });
});

// ============================================================
// /oauth/logout
// ============================================================

describe('POST /oauth/logout', () => {
  test('responde 200 aunque no haya sesion activa', async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).post('/oauth/logout');
    expect(res.status).toBe(200);
  });
});
