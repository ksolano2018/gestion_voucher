const express = require('express');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/actuator/health', (req, res) => {
  res.json({ status: 'UP', service: 'API Gateway' });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Proyecto API Gateway',
    version: '1.0.0',
    status: 'running'
  });
});

// Error 404
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint no encontrado', path: req.path });
});

app.listen(port, () => {
  console.log(`API Gateway escuchando en puerto ${port}`);
});
