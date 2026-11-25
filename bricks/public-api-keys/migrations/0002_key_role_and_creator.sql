-- public-api-keys 0002 (story 1.11): a key carries a workspace role and the user who created it.
-- role: the most a key may do in its workspace. Never 'owner'. Keys made before this migration become 'member'.
-- created_by: the creating user. At authentication the creator must still be a member at or above the key's role,
-- otherwise the key is refused. Keys made before this migration have no creator and are therefore refused.
-- last_used_at already exists (0001). The key_hash index is created again only if it is missing.
ALTER TABLE key_api_keys ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin'));
ALTER TABLE key_api_keys ADD COLUMN created_by TEXT;
CREATE INDEX IF NOT EXISTS key_api_keys_hash_idx ON key_api_keys(key_hash, revoked);
