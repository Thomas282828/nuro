-- Migration kaideno : vrais comptes (mot de passe + plan + quota) et sessions de connexion.
-- À exécuter UNE SEULE FOIS sur la base D1 "kaideno-db" avant de déployer le nouveau Worker.
--
-- Comment l'exécuter :
--   Dashboard Cloudflare → Workers & Pages → D1 → kaideno-db → onglet "Console"
--   → coller tout ce fichier → Exécuter.

ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN salt TEXT;
ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'free';
ALTER TABLE users ADD COLUMN used_seconds INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN quota_month TEXT;

CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_email ON auth_sessions(email);
