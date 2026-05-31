/**
 * Tests para el endpoint GET /health
 */

const request = require('supertest');

jest.mock('stripe', () => jest.fn().mockImplementation(() => ({
  webhooks: { constructEvent: jest.fn() },
  checkout: { sessions: { create: jest.fn() } },
  customers: { list: jest.fn().mockResolvedValue({ data: [] }) },
})));

let poolQueryMock;

jest.mock('pg', () => {
  poolQueryMock = jest.fn();
  const PoolMock = jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue({ query: jest.fn(), release: jest.fn() }),
    query: poolQueryMock,
    on: jest.fn(),
    end: jest.fn().mockResolvedValue(undefined),
  }));
  return { Pool: PoolMock };
});

let app;

beforeAll(() => {
  ({ app } = require('../app'));
});

describe('GET /health', () => {
  test('devuelve 200 y status healthy cuando la BD responde', (done) => {
    poolQueryMock.mockImplementation((sql, cb) => cb(null));

    request(app)
      .get('/health')
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('healthy');
        expect(res.body.database).toBe('connected');
        expect(res.body.timestamp).toBeDefined();
      })
      .end(done);
  });

  test('devuelve 503 cuando la BD no responde', (done) => {
    poolQueryMock.mockImplementation((sql, cb) => cb(new Error('connection refused')));

    request(app)
      .get('/health')
      .expect(503)
      .expect((res) => {
        expect(res.body.status).toBe('unhealthy');
        expect(res.body.database).toBe('disconnected');
      })
      .end(done);
  });
});
