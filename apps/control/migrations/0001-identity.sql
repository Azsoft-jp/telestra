-- 主体、Node、資格世代、予約と録画台帳を永続化する。Tokenや秘密鍵の値は保存しない。
CREATE TABLE memberships (
  environment TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('viewer','recorder','operator','admin')),
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  PRIMARY KEY(environment, tenant_id, subject)
);
CREATE TABLE nodes (
  environment TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  node_role TEXT NOT NULL CHECK(node_role IN ('tuner','encoder')),
  public_jwk TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','active','revoked')),
  credential_version INTEGER NOT NULL DEFAULT 1,
  session_epoch INTEGER NOT NULL DEFAULT 0,
  capabilities TEXT NOT NULL DEFAULT '{}',
  last_seen INTEGER,
  PRIMARY KEY(environment, tenant_id, node_id)
);
CREATE TABLE node_joins (
  environment TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(environment, tenant_id, node_id),
  FOREIGN KEY(environment, tenant_id, node_id) REFERENCES nodes(environment, tenant_id, node_id)
);
CREATE TABLE revoked_tokens (
  environment TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  jti TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(environment, tenant_id, jti)
);
CREATE TABLE reservations (
  environment TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'scheduled',
  revision INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  PRIMARY KEY(environment, tenant_id, reservation_id)
);
CREATE TABLE recordings (
  environment TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  recording_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY(environment, tenant_id, recording_id)
);
CREATE TABLE rate_limits (
  scope TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY(scope,bucket)
);
CREATE TABLE identity_audit (
  event_id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  actor_hash TEXT NOT NULL,
  node_id TEXT,
  created_at INTEGER NOT NULL
);
