const express = require('express');
const helmet = require('helmet');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
const apiUrl = process.env.REACT_APP_API_URL || 'http://localhost:8080';

// Mismas cabeceras de seguridad (CSP/HSTS/X-Powered-By, etc.) que ya tienen las APIs
// (servicio-usuarios/servicio-compras) — antes solo estaban ahí, el sitio servido por
// este contenedor (el que de verdad abre el navegador) no las tenía (QA-27/QA-28).
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: process.env.NODE_ENV === 'production' ? ["'self'"] : ["'self'", "http://localhost:*"]
    }
  }
}));

app.use('/static', express.static(path.join(__dirname, 'public'), {
  maxAge: 0,
  etag: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('app.js') || filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Serve a tiny favicon to avoid 404 requests from browsers
app.get('/favicon.ico', (req, res) => {
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
  res.set('Content-Type', 'image/png');
  res.send(Buffer.from(pngBase64, 'base64'));
});

app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(indexPath, 'utf8', (err, data) => {
    if (err) return res.status(500).send('Error cargando la aplicación');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const out = data.replace(/%API_URL%/g, apiUrl);
    res.send(out);
  });
});

// Serve same index for admin and partner routes (SPA-style)
app.get(['/admin','/partner'], (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(indexPath, 'utf8', (err, data) => {
    if (err) return res.status(500).send('Error cargando la aplicación');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const out = data.replace(/%API_URL%/g, apiUrl);
    res.send(out);
  });
});

// Página pública (sin login) donde el estudiante crea su contraseña a partir del
// link de un solo uso del correo de bienvenida (QA-08).
app.get('/set-password', (req, res) => {
  const pagePath = path.join(__dirname, 'public', 'set-password.html');
  fs.readFile(pagePath, 'utf8', (err, data) => {
    if (err) return res.status(500).send('Error cargando la página');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const out = data.replace(/%API_URL%/g, apiUrl);
    res.send(out);
  });
});

app.listen(port, () => {
  console.log(`Frontend escuchando en el puerto ${port}, API_URL=${apiUrl}`);
});
