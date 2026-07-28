-- Migration kaideno #4 : rapport hebdomadaire par email (version limitée).
-- À exécuter APRÈS migration.sql, migration2.sql et migration3.sql, sur la même base D1 "kaideno-db".
--
-- Dashboard Cloudflare → Workers & Pages → D1 → kaideno-db → onglet "Console"
-- → coller tout ce fichier → Exécuter.

ALTER TABLE users ADD COLUMN last_digest_seconds INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN last_digest_at TEXT;
