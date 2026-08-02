-- Migration kaideno #2 : mot de passe oublié + programme de parrainage réel.
-- À exécuter APRÈS migration.sql, sur la même base D1 "kaideno-db".
--
-- Dashboard Cloudflare → Workers & Pages → D1 → kaideno-db → onglet "Console"
-- → coller tout ce fichier → Exécuter.

-- Réinitialisation de mot de passe
CREATE TABLE IF NOT EXISTS password_resets (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_password_resets_email ON password_resets(email);

-- Parrainage
ALTER TABLE users ADD COLUMN referral_code TEXT;
ALTER TABLE users ADD COLUMN bonus_seconds INTEGER DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);

CREATE TABLE IF NOT EXISTS referrals (
  referred_email TEXT PRIMARY KEY,
  referrer_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  rewarded INTEGER DEFAULT 0
);
