-- 録画認可の世代を短命資格から分離する。既存rowも1から開始し、履歴を推測で補わない。
-- 状態と同じrowで更新する。失効を配信済みとみなす列ではなく、分断中の即時失効は保証しない。
ALTER TABLE nodes ADD COLUMN authorization_epoch INTEGER NOT NULL DEFAULT 1
  CHECK(typeof(authorization_epoch)='integer' AND authorization_epoch BETWEEN 1 AND 9007199254740991);
