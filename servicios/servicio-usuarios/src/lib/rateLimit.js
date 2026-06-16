'use strict';
// Rate limiters transversales. ipKeyGenerator normaliza IPv6 para que no se evada el límite.
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

// Endpoints de autenticación: clave por username (o IP) para no bloquear toda la IP.
const authLimiter = rateLimit({
  windowMs: (parseInt(process.env.RATE_LIMIT_WINDOW_MINUTES) || 15) * 60 * 1000,
  max: parseInt(process.env.MAX_LOGIN_ATTEMPTS) || 5,
  message: { error: 'Demasiados intentos de inicio de sesión. Intenta de nuevo más tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const username = (req.body && (req.body.username || req.body.email || '')).toString().toLowerCase().trim();
    return username || ipKeyGenerator(req.ip);
  },
});

// Endpoints de API: cupo mayor para usuarios autenticados; clave por usuario o IP.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: (req) => {
    const baseLimit = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100;
    if (req.user && req.user.role === 'admin')   return Math.max(baseLimit, 1200);
    if (req.user && req.user.role === 'partner') return Math.max(baseLimit, 600);
    return baseLimit;
  },
  keyGenerator: (req) => {
    if (req.user && req.user.sub) return `user:${req.user.sub}`;
    return ipKeyGenerator(req.ip);
  },
  message: { error: 'Demasiadas solicitudes. Intenta de nuevo más tarde.' },
  standardHeaders: true,
  legacyHeaders: false
});

module.exports = { authLimiter, apiLimiter };
