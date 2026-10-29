-- 確定した予約版とNodeの認可世代に拘束したpolicyを、割当世代ごとの不変snapshotとして保持する。
-- 署名値・秘密鍵・Storage Grantは保存しない。現行予約のrevision 0を自動で確定しない。
CREATE TABLE capture_policies (
 environment TEXT NOT NULL,
 tenant_id TEXT NOT NULL,
 recording_id TEXT NOT NULL,
 assignment_epoch INTEGER NOT NULL CHECK(assignment_epoch BETWEEN 1 AND 9007199254740991),
 node_id TEXT NOT NULL,
 authorization_epoch INTEGER NOT NULL CHECK(authorization_epoch BETWEEN 1 AND 9007199254740991),
 reservation_id TEXT NOT NULL,
 reservation_revision INTEGER NOT NULL CHECK(reservation_revision BETWEEN 1 AND 9007199254740991),
 attempt_id TEXT NOT NULL,
 policy_id TEXT NOT NULL,
 permit_id TEXT NOT NULL,
 revoked INTEGER NOT NULL CHECK(revoked IN (0,1)),
 claims TEXT NOT NULL CHECK(length(CAST(claims AS BLOB))<=4096),
 PRIMARY KEY(environment,tenant_id,recording_id,assignment_epoch),
 UNIQUE(environment,tenant_id,policy_id),
 UNIQUE(environment,tenant_id,permit_id),
 FOREIGN KEY(environment,tenant_id,recording_id) REFERENCES recordings(environment,tenant_id,recording_id),
 FOREIGN KEY(environment,tenant_id,node_id) REFERENCES nodes(environment,tenant_id,node_id),
 FOREIGN KEY(environment,tenant_id,reservation_id) REFERENCES reservations(environment,tenant_id,reservation_id)
);
