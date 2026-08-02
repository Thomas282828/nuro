-- Migration kaideno #5 : paiements Stripe (abonnements payants Essentiel/Pro).
-- À exécuter APRÈS migration.sql, migration2.sql, migration3.sql et migration4.sql, sur la
-- même base D1 "kaideno-db".
--
-- Dashboard Cloudflare → Workers & Pages → D1 → kaideno-db → onglet "Console"
-- → coller tout ce fichier → Exécuter.

ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT;
