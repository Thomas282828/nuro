-- Migration kaideno #3 : liens de partage en lecture seule.
-- À exécuter APRÈS migration.sql et migration2.sql, sur la même base D1 "kaideno-db".
--
-- Dashboard Cloudflare → Workers & Pages → D1 → kaideno-db → onglet "Console"
-- → coller tout ce fichier → Exécuter.

CREATE TABLE IF NOT EXISTS shares (
  token TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  title TEXT,
  summary_json TEXT,   -- résumé structuré (titre, resume, points_cles, actions) en JSON
  transcript TEXT,      -- transcription lisible (locuteurs déjà remplacés par leur nom)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shares_owner ON shares(owner_email);
