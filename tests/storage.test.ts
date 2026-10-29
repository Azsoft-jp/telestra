// 保存データの長さ・hash・認可・期限・容量と、immutable書込の条件を検証する。
import assert from "node:assert/strict";
import { FakeObjectStorage, sha256 } from "../packages/storage/index.ts";
import { BoundaryError } from "../packages/contracts/index.ts";
import { scenario } from "./evidence.ts";

const actor = { tenantId: "demo-household", actorId: "tuner-demo-01" };
const grant = {
  ...actor,
  prefix: "recordings/rec-demo-01/attempts/attempt-demo-01/",
  methods: ["put", "get", "stat"] as const,
  maxBytes: 4096,
  expiresAt: 2000,
};
const key = `${grant.prefix}raw/000000.ts`;

scenario(
  "MED-01",
  "storage-capacity-and-prefix-limits",
  "synthetic-bytes-v1",
  "Storage総容量・prefix境界・サイズ上限を拒否する",
  () => {
    const store = new FakeObjectStorage({
      maxObjectBytes: 4096,
      maxTotalBytes: 8192,
    });
    const bytes = Buffer.alloc(4096);
    store.putImmutable(
      actor,
      grant,
      `${grant.prefix}raw/one.ts`,
      bytes,
      sha256(bytes),
      bytes.length,
      1000,
    );
    store.putImmutable(
      actor,
      grant,
      `${grant.prefix}raw/two.ts`,
      bytes,
      sha256(bytes),
      bytes.length,
      1000,
    );
    assert.throws(
      () =>
        store.putImmutable(
          actor,
          grant,
          `${grant.prefix}raw/three.ts`,
          bytes,
          sha256(bytes),
          bytes.length,
          1000,
        ),
      BoundaryError,
    );
    assert.throws(
      () =>
        store.get(
          actor,
          { ...grant, maxBytes: 1 },
          `${grant.prefix}raw/one.ts`,
          1000,
        ),
      BoundaryError,
    );
    assert.throws(
      () =>
        store.get(
          actor,
          grant,
          "recordings/rec-demo-01/attempts/attempt-demo-010/raw/one.ts",
          1000,
        ),
      BoundaryError,
    );
    assert.throws(
      () =>
        store.get(
          actor,
          { ...grant, prefix: "recordings/" },
          "recordings/../secret",
          1000,
        ),
      BoundaryError,
    );
  },
);

scenario(
  "MED-01",
  "immutable-storage-boundaries",
  "synthetic-bytes-v1",
  "長さ/hash/認可/期限/容量を確認し、同一書込は冪等・上書きは禁止する",
  () => {
    const store = new FakeObjectStorage({
      maxObjectBytes: 4096,
      maxTotalBytes: 8192,
    });
    const bytes = Buffer.from("合成原本");
    const put = (data: Uint8Array, hash = sha256(data), length = data.length) =>
      store.putImmutable(actor, grant, key, data, hash, length, 1000);
    assert.throws(() => put(bytes, "0".repeat(64)), BoundaryError);
    assert.throws(
      () => put(bytes, sha256(bytes), bytes.length + 1),
      BoundaryError,
    );
    put(bytes);
    put(bytes);
    assert.throws(() => put(Buffer.from("別データ")), BoundaryError);
    assert.throws(
      () =>
        store.get({ ...actor, tenantId: "other-household" }, grant, key, 1000),
      BoundaryError,
    );
    assert.throws(
      () => store.get({ ...actor, actorId: "another-node" }, grant, key, 1000),
      BoundaryError,
    );
    assert.throws(() => store.get(actor, grant, key, 2000), BoundaryError);
    assert.throws(
      () => store.get(actor, grant, `${grant.prefix}../secret`, 1000),
      BoundaryError,
    );
    assert.throws(
      () => store.get(actor, { ...grant, methods: ["put"] }, key, 1000),
      BoundaryError,
    );
    const read = store.get(actor, grant, key, 1000);
    read[0] = 0;
    assert.deepEqual(store.get(actor, grant, key, 1000), bytes);
    bytes[0] = 0;
    assert.notDeepEqual(store.get(actor, grant, key, 1000), bytes);
    assert.throws(() => put(Buffer.alloc(4097)), BoundaryError);
    assert.throws(
      () => store.get(actor, grant, `${grant.prefix}missing`, 1000),
      BoundaryError,
    );
  },
);
