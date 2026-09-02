-- Expand: last-4 of the machine bearer for Access display. Not recoverable for existing rows.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS last4 TEXT;

-- Down: keep the column (no data loss). Drop only after readers stop using it.
-- ALTER TABLE clients DROP COLUMN IF EXISTS last4;
