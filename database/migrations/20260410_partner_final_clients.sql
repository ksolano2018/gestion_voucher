-- Tabla de clientes finales por partner
CREATE TABLE IF NOT EXISTS partner_final_clients (
  id         SERIAL PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  name       VARCHAR(200) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_partner_final_clients_partner_id ON partner_final_clients(partner_id);
