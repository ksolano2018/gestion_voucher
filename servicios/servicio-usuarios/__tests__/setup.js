// Configura variables de entorno minimas antes de cargar la app
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_secret_key_min_32_characters_long_xx';
process.env.ADMIN_PASSWORD = 'TestAdmin@123';
process.env.ADMIN_EMAIL = 'admin@test.com';
process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_NAME = process.env.DB_NAME || 'proyectodb';
process.env.DB_USER = process.env.DB_USER || 'admin';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'admin123';
process.env.STRIPE_SECRET_KEY = 'sk_test_fake_key_for_tests';
process.env.FRONTEND_URL = 'http://localhost:3000';
