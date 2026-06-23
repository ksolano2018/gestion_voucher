-- Plantillas de correo editables (cuerpo Mustache), versionadas.
-- Una versión activa por clave (template_key). Si no hay fila activa, el
-- microservicio servicio-notificaciones usa la plantilla por defecto del código.
CREATE TABLE IF NOT EXISTS email_templates (
  id SERIAL PRIMARY KEY,
  template_key VARCHAR(64) NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  body_text TEXT,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  version INT NOT NULL DEFAULT 1,
  updated_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_email_templates_key ON email_templates(template_key);
-- Garantiza una sola versión activa por clave.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_email_templates_active ON email_templates(template_key) WHERE is_active;
