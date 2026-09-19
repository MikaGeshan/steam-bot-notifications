CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  locale TEXT NOT NULL DEFAULT 'id-ID',
  country CHAR(2) NOT NULL DEFAULT 'ID',
  currency CHAR(3) NOT NULL DEFAULT 'IDR',
  timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta',
  notification_mode TEXT NOT NULL DEFAULT 'instant' CHECK (notification_mode IN ('instant', 'digest')),
  quiet_start SMALLINT NOT NULL DEFAULT 22 CHECK (quiet_start BETWEEN 0 AND 23),
  quiet_end SMALLINT NOT NULL DEFAULT 8 CHECK (quiet_end BETWEEN 0 AND 23),
  notifications_enabled BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending_deletion', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channel_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  encrypted_address TEXT NOT NULL,
  address_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, address_hash)
);

CREATE TABLE IF NOT EXISTS consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  version TEXT NOT NULL,
  granted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS steam_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  steam_id TEXT NOT NULL UNIQUE,
  profile_visibility TEXT NOT NULL DEFAULT 'unknown',
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sync_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS steam_link_tokens (
  nonce_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS games (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'unknown' CHECK (type IN ('game', 'dlc', 'bundle', 'unknown')),
  release_date DATE,
  popularity DOUBLE PRECISION NOT NULL DEFAULT 0,
  metadata_status TEXT NOT NULL DEFAULT 'partial',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS games_title_idx ON games USING gin (to_tsvector('simple', title));

CREATE TABLE IF NOT EXISTS game_provider_ids (
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 1,
  PRIMARY KEY(provider, external_id),
  UNIQUE(game_id, provider)
);

CREATE TABLE IF NOT EXISTS game_platforms (
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  PRIMARY KEY(game_id, platform)
);

CREATE TABLE IF NOT EXISTS game_genres (
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  genre TEXT NOT NULL,
  weight DOUBLE PRECISION NOT NULL DEFAULT 1,
  PRIMARY KEY(game_id, genre)
);

CREATE TABLE IF NOT EXISTS owned_games (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  playtime_minutes INTEGER NOT NULL DEFAULT 0 CHECK (playtime_minutes >= 0),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, game_id)
);

CREATE TABLE IF NOT EXISTS playtime_snapshots (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  captured_at TIMESTAMPTZ NOT NULL,
  cumulative_minutes INTEGER NOT NULL CHECK (cumulative_minutes >= 0),
  PRIMARY KEY(user_id, game_id, captured_at)
);

CREATE INDEX IF NOT EXISTS playtime_user_time_idx ON playtime_snapshots(user_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS price_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  shop TEXT NOT NULL,
  country CHAR(2) NOT NULL,
  currency CHAR(3) NOT NULL,
  regular_minor BIGINT NOT NULL CHECK (regular_minor >= 0),
  current_minor BIGINT NOT NULL CHECK (current_minor >= 0),
  cut_percent SMALLINT NOT NULL CHECK (cut_percent BETWEEN 0 AND 100),
  deal_url TEXT NOT NULL,
  source TEXT NOT NULL,
  voucher BOOLEAN NOT NULL DEFAULT false,
  captured_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS price_game_scope_idx ON price_snapshots(game_id, country, currency, captured_at DESC);

CREATE TABLE IF NOT EXISTS historical_lows (
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  shop_scope TEXT NOT NULL,
  country CHAR(2) NOT NULL,
  currency CHAR(3) NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  occurred_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(game_id, shop_scope, country, currency)
);

CREATE TABLE IF NOT EXISTS wishlist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, game_id)
);

CREATE TABLE IF NOT EXISTS wishlist_rules (
  wishlist_item_id UUID PRIMARY KEY REFERENCES wishlist_items(id) ON DELETE CASCADE,
  max_price_minor BIGINT,
  min_cut_percent SMALLINT DEFAULT 30 CHECK (min_cut_percent BETWEEN 0 AND 100),
  historical_low_only BOOLEAN NOT NULL DEFAULT false,
  CHECK (max_price_minor IS NOT NULL OR min_cut_percent IS NOT NULL OR historical_low_only)
);

CREATE TABLE IF NOT EXISTS purchase_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency CHAR(3) NOT NULL,
  purchased_at DATE NOT NULL,
  store TEXT,
  acquisition_type TEXT NOT NULL DEFAULT 'paid' CHECK (acquisition_type IN ('paid', 'gift', 'free', 'subscription', 'unknown')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS purchase_user_date_idx ON purchase_records(user_id, purchased_at DESC);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'explicit',
  weight DOUBLE PRECISION NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, key, value, source)
);

CREATE TABLE IF NOT EXISTS recommendation_feedback (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('like', 'dislike', 'hide', 'owned')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, game_id)
);

CREATE TABLE IF NOT EXISTS provider_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, external_event_id)
);

CREATE TABLE IF NOT EXISTS notification_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'suppressed')),
  provider_message_id TEXT,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_state_schedule_idx ON notification_events(state, scheduled_at);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  dedupe_key TEXT,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'completed', 'failed', 'dead')),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs(state, run_at, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_dedupe_idx
  ON jobs(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state IN ('pending', 'running');

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO feature_flags (key, enabled) VALUES
  ('notifications.enabled', true),
  ('steam.sync.enabled', true),
  ('recommendations.enabled', true)
ON CONFLICT (key) DO NOTHING;
