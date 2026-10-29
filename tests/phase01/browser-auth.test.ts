// public clientのPKCEからWorker認可までを通し、秘密値の保管やCookie認証を導入しない。
import assert from "node:assert/strict";
import { fixture, origin, device } from "./helper.ts";
import { mockOidc } from "./mock-oidc.ts";
import {
  BrowserSession,
  pkceChallenge,
} from "../../packages/browser-auth/index.ts";
import { readResponse } from "../../packages/browser-auth/transport.ts";
import { scenario } from "../evidence.ts";

scenario(
  "SEC-04",
  "browser-pkce-code-to-api-session",
  "memory-mock-oidc-workerd-v1",
  "S256・state・nonceを検証した資格でAPIへ接続し、D1の所属を確認してログアウト時に失効する",
  async () => {
    const context = await fixture();
    try {
      const provider = mockOidc(context);
      const client = new BrowserSession(provider.config, {
        fetch: provider.fetch,
      });
      assert.equal(client.snapshot.state, "signed-out");
      const url = await client.begin();
      assert.equal(client.snapshot.state, "waiting");
      await client.complete(provider.authorize(url));
      assert.equal(client.snapshot.state, "authenticated");
      const session = await client.session();
      assert.deepEqual(session, {
        subject: "viewer-local",
        role: "viewer",
        tenantId: "demo-household",
        environment: "development",
        expiresAt: context.decode(provider.issuedToken).exp,
      });
      assert.equal(provider.tokenRequests, 1);
      await assert.rejects(client.complete(provider.authorize(url)));
      assert.equal(provider.tokenRequests, 1, "認可応答を再送しました。");
      assert.equal(client.snapshot.state, "authenticated");
      assert.equal(
        JSON.stringify(client).includes(provider.issuedToken),
        false,
        "資格を公開プロパティへ保持しました。",
      );
      await client.logout();
      assert.equal(client.snapshot.state, "signed-out");
      assert.equal(
        (await context.browser("/session", provider.issuedToken)).status,
        401,
      );
      assert.equal(context.egress, 0);
    } finally {
      await context.close();
    }
  },
);

scenario(
  "CORE-02",
  "browser-pkce-vector-and-callback-boundaries",
  "rfc7636-and-memory-callback-v1",
  "S256の既知vectorと固定callbackを照合し、未知・重複・別state・別issuer・期限切れを交換前に拒否する",
  async () => {
    assert.equal(
      await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    for (const invalid of ["a".repeat(42), "a".repeat(129), " ".repeat(43)])
      await assert.rejects(pkceChallenge(invalid));
    const context = await fixture();
    try {
      const changes: ((url: URL) => void)[] = [
        (u) => u.searchParams.set("state", "A".repeat(43)),
        (u) => u.searchParams.set("iss", "https://other.example.test"),
        (u) => u.searchParams.delete("iss"),
        (u) => u.searchParams.append("state", "A".repeat(43)),
        (u) => u.searchParams.set("__proto__", "unknown"),
        (u) => u.searchParams.set("redirect_uri", "https://other.example.test"),
        (u) => {
          u.hash = "fragment";
        },
        (u) => {
          u.hostname = "other.example.test";
        },
        (u) => {
          u.pathname = "/different";
        },
        (u) => {
          u.username = "untrusted";
        },
        (u) => u.searchParams.set("code", "a".repeat(2049)),
        (u) => u.searchParams.set("code", "改行\n"),
      ];
      for (const change of changes) {
        const provider = mockOidc(context),
          client = new BrowserSession(provider.config, {
            fetch: provider.fetch,
          });
        const callback = new URL(provider.authorize(await client.begin()));
        change(callback);
        await assert.rejects(client.complete(callback.toString()));
        assert.equal(
          provider.tokenRequests,
          0,
          "不正な応答からコードを交換しました。",
        );
        assert.equal(client.snapshot.state, "failed");
      }
      let now = context.now();
      const provider = mockOidc(context),
        client = new BrowserSession(provider.config, {
          fetch: provider.fetch,
          now: () => now,
        });
      const callback = provider.authorize(await client.begin());
      now += 120;
      await assert.rejects(client.complete(callback));
      assert.equal(provider.tokenRequests, 0);
      for (const changes of [
        { tokenEndpoint: "http://idp.example.test/token" },
        { tokenEndpoint: "https://idp.example.test/token?redirect=other" },
        { redirectUri: "https://other.example.test/auth/callback" },
        { appOrigin: "https://tv.example.test/path" },
      ])
        assert.throws(
          () =>
            new BrowserSession(
              { ...provider.config, ...changes },
              { fetch: provider.fetch },
            ),
        );
      const restarted = new BrowserSession(provider.config, {
        fetch: provider.fetch,
      });
      await assert.rejects(restarted.complete(callback));
      assert.equal(restarted.snapshot.state, "signed-out");
      assert.equal(context.egress, 0);
    } finally {
      await context.close();
    }
  },
);

scenario(
  "SEC-04",
  "browser-pkce-token-purpose-nonce-and-subject",
  "memory-oidc-token-denials-v1",
  "IDとAccessの用途・nonce・署名・issuer・audience・主体・期限を照合し、不正な応答をAPIへ転送しない",
  async () => {
    const context = await fixture();
    try {
      const foreign = await device("foreign-oidc");
      const changes: ((value: Record<string, unknown>) => Promise<void>)[] = [
        async (v) => {
          v.id_token = await context.mintIdToken(
            "viewer-local",
            "A".repeat(43),
          );
        },
        async (v) => {
          v.id_token = v.access_token;
        },
        async (v) => {
          v.access_token = v.id_token;
        },
        async (v) => {
          v.id_token = await context.mintIdToken(
            "viewer-local",
            String(context.decode(String(v.id_token)).nonce),
            {},
            foreign.privateKey,
          );
        },
        async (v) => {
          v.access_token = await context.mint(
            "viewer-local",
            {},
            foreign.privateKey,
          );
        },
        async (v) => {
          v.id_token = await context.mintIdToken(
            "viewer-local",
            String(context.decode(String(v.id_token)).nonce),
            { aud: "other-client" },
          );
        },
        async (v) => {
          v.id_token = await context.mintIdToken(
            "viewer-local",
            String(context.decode(String(v.id_token)).nonce),
            { iss: "https://other.example.test" },
          );
        },
        async (v) => {
          v.id_token = await context.mintIdToken(
            "viewer-local",
            String(context.decode(String(v.id_token)).nonce),
            { exp: context.now() - 1, iat: context.now() - 60 },
          );
        },
        async (v) => {
          v.access_token = await context.mint("viewer-local", {
            aud: "other-api",
          });
        },
        async (v) => {
          v.access_token = await context.mint("viewer-local", {
            iss: "https://other.example.test",
          });
        },
        async (v) => {
          v.access_token = await context.mint("other-local");
        },
        async (v) => {
          v.access_token = await context.mint("viewer-local", {
            exp: context.now() - 1,
            iat: context.now() - 60,
          });
        },
        async (v) => {
          v.access_token = await context.mint("viewer-local", {
            roles: ["admin"],
          });
        },
        async (v) => {
          v.refresh_token = crypto.randomUUID();
        },
        async (v) => {
          v.expires_in = 0;
        },
        async (v) => {
          v.expires_in = 901;
        },
        async (v) => {
          v.token_type = "Other";
        },
      ];
      for (const change of changes) {
        const provider = mockOidc(context);
        const perform: typeof fetch = async (input, init) => {
          const response = await provider.fetch(input, init);
          const value = (await response.json()) as Record<string, unknown>;
          await change(value);
          return Response.json(value, {
            headers: { "Cache-Control": "no-store" },
          });
        };
        const client = new BrowserSession(provider.config, { fetch: perform });
        await assert.rejects(
          client.complete(provider.authorize(await client.begin())),
        );
        assert.equal(provider.tokenRequests, 1);
        assert.equal(
          provider.apiRequests,
          0,
          "検証前の資格をAPIへ転送しました。",
        );
        assert.equal(client.snapshot.state, "failed");
      }
      // 正しいcallbackでもverifierを取り違えるとMock IdPが拒否し、自動再送しない。
      const provider = mockOidc(context);
      const perform: typeof fetch = (input, init) => {
        const fields = new URLSearchParams(String(init?.body));
        fields.set("code_verifier", "A".repeat(43));
        return provider.fetch(input, { ...init, body: fields.toString() });
      };
      const client = new BrowserSession(provider.config, { fetch: perform });
      await assert.rejects(
        client.complete(provider.authorize(await client.begin())),
      );
      assert.equal(provider.tokenRequests, 1);
      assert.equal(provider.apiRequests, 0);
      assert.equal(context.egress, 0);
    } finally {
      await context.close();
    }
  },
);

scenario(
  "SEC-01",
  "browser-api-rbac-revocation-and-expiry",
  "pkce-api-d1-authorization-v1",
  "認可後もAPIの現在のRoleと失効を確認し、403・復帰・401・ローカル期限切れを区別する",
  async () => {
    const context = await fixture();
    try {
      const provider = mockOidc(context);
      // Mock IdPと同じ実時計を使い、期限切れの確認時だけ差分を加える。固定時計は秒境界で正常なiatを拒否してしまう。
      let offsetSeconds = 0;
      const client = new BrowserSession(provider.config, {
        fetch: provider.fetch,
        now: () => context.now() + offsetSeconds,
      });
      await client.complete(provider.authorize(await client.begin()));
      await assert.rejects(
        client.request("/nodes", { method: "POST", body: {} }),
      );
      assert.equal(client.snapshot.state, "forbidden");
      await client.session();
      assert.equal(client.snapshot.state, "authenticated");
      const before = provider.apiRequests;
      for (const path of [
        "https://other.example.test/session",
        "//other.example.test/session",
        "/session?token=bad",
        "/nodes/join",
        "/nodes/rotate",
        "/session/../nodes",
      ])
        await assert.rejects(client.request(path));
      assert.equal(provider.apiRequests, before);
      await context.database
        .prepare(
          "UPDATE memberships SET status='revoked' WHERE subject='viewer-local'",
        )
        .run();
      await assert.rejects(client.session());
      assert.equal(client.snapshot.state, "expired");
      await context.database
        .prepare(
          "UPDATE memberships SET status='active' WHERE subject='viewer-local'",
        )
        .run();
      await client.complete(provider.authorize(await client.begin()));
      const requests = provider.apiRequests;
      offsetSeconds += 601;
      assert.equal(client.snapshot.state, "expired");
      await assert.rejects(client.session());
      assert.equal(
        provider.apiRequests,
        requests,
        "期限切れ資格を送信しました。",
      );
    } finally {
      await context.close();
    }
  },
);

scenario(
  "SEC-04",
  "browser-auth-origin-and-reload-isolation",
  "two-origin-memory-pkce-v1",
  "別originと新しいインスタンスは資格・進行中の認可を引き継がず、それぞれログインする",
  async () => {
    const secondaryOrigin = "https://secondary.example.test";
    const context = await fixture(undefined, [origin, secondaryOrigin]);
    try {
      const primary = mockOidc(context),
        secondary = mockOidc(context, secondaryOrigin);
      const a = new BrowserSession(primary.config, { fetch: primary.fetch }),
        b = new BrowserSession(secondary.config, { fetch: secondary.fetch });
      const callback = primary.authorize(await a.begin());
      await a.complete(callback);
      await assert.rejects(b.complete(callback));
      assert.equal(b.snapshot.state, "signed-out");
      await b.begin();
      await assert.rejects(b.complete(callback));
      assert.equal(secondary.tokenRequests, 0);
      await b.complete(secondary.authorize(await b.begin()));
      assert.equal((await b.session()).role, "viewer");
      const reloaded = new BrowserSession(primary.config, {
        fetch: primary.fetch,
      });
      await assert.rejects(reloaded.session());
      assert.equal(reloaded.snapshot.state, "signed-out");
      assert.equal(a.snapshot.state, "authenticated");
      assert.equal(context.egress, 0);
    } finally {
      await context.close();
    }
  },
);

scenario(
  "SEC-04",
  "browser-auth-cancel-and-logout-uncertainty",
  "memory-pkce-delayed-response-v1",
  "中断後の遅い資格を採用せず、ログアウト応答を失った場合はローカル破棄と失効未確認を表示する",
  async () => {
    const context = await fixture();
    try {
      const provider = mockOidc(context);
      let ready: () => void = () => {},
        release: () => void = () => {};
      const received = new Promise<void>((r) => {
          ready = r;
        }),
        held = new Promise<void>((r) => {
          release = r;
        });
      let hold = true,
        offline = false;
      const perform: typeof fetch = async (input, init) => {
        if (offline) throw new Error("合成した通信断です。");
        const response = await provider.fetch(input, init);
        if (hold) {
          ready();
          await held;
        }
        return response;
      };
      const client = new BrowserSession(provider.config, { fetch: perform });
      // 拒否を先に監視し、中断通知を未処理のPromise rejectionにしない。
      const stopped = assert.rejects(
        client.complete(provider.authorize(await client.begin())),
      );
      await received;
      client.cancel();
      release();
      await stopped;
      assert.equal(client.snapshot.state, "signed-out");
      assert.equal(provider.apiRequests, 0);
      hold = false;
      await client.complete(provider.authorize(await client.begin()));
      offline = true;
      await assert.rejects(client.session());
      assert.equal(client.snapshot.state, "disconnected");
      offline = false;
      await client.session();
      assert.equal(client.snapshot.state, "authenticated");
      offline = true;
      await assert.rejects(client.logout());
      assert.equal(client.snapshot.state, "logout-unconfirmed");
      offline = false;
      await assert.rejects(client.session());
      assert.equal(
        (await context.browser("/session", provider.issuedToken)).status,
        200,
        "未確認の失効を成功と扱いました。",
      );
    } finally {
      await context.close();
    }
  },
);

scenario(
  "CORE-02",
  "browser-auth-response-size-and-time-bounds",
  "bounded-auth-response-stream-v1",
  "過大応答・非JSON・キャッシュ可能応答・redirectと停止したstreamを拒否し、待機を5秒で打ち切る",
  async () => {
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    };
    const responses = [
      () =>
        new Response("{}", {
          headers: {
            "Content-Type": "text/plain",
            "Cache-Control": "no-store",
          },
        }),
      () => Response.json({}, { headers: { "Cache-Control": "public" } }),
      () => new Response(" ".repeat(16_385), { headers }),
      () => new Response("あ".repeat(6000), { headers }),
      () =>
        new Response("{}", {
          headers: { ...headers, "Content-Length": "16385" },
        }),
      () => Response.redirect("https://other.example.test", 302),
    ];
    for (const [index, response] of responses.entries()) {
      let calls = 0;
      await assert.rejects(
        readResponse(
          async () => {
            calls++;
            return response();
          },
          "https://idp.example.test/token",
          {},
          new AbortController(),
        ),
        `不正な応答のケース${index}を拒否しません。`,
      );
      assert.equal(calls, 1);
    }
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
    });
    const started = Date.now();
    await assert.rejects(
      readResponse(
        async () => new Response(stream, { headers }),
        "https://idp.example.test/token",
        {},
        new AbortController(),
      ),
    );
    assert.ok(
      Date.now() - started >= 4500 && Date.now() - started < 8000,
      "応答待機の期限が不正です。",
    );
    assert.equal(cancelled, true);
  },
);

scenario(
  "CORE-02",
  "browser-auth-finite-requests-and-cancel",
  "memory-auth-four-request-window-v1",
  "同時要求を4件までに制限し、中断後は応答がなくても全待機を回収して新たな資格を採用しない",
  async () => {
    const context = await fixture();
    try {
      const provider = mockOidc(context);
      let holding = false,
        calls = 0;
      const perform: typeof fetch = (input, init) => {
        if (holding) {
          calls++;
          return new Promise<Response>(() => {});
        }
        return provider.fetch(input, init);
      };
      const client = new BrowserSession(provider.config, { fetch: perform });
      await client.complete(provider.authorize(await client.begin()));
      holding = true;
      const pending = Array.from({ length: 4 }, () =>
        assert.rejects(client.session()),
      );
      await assert.rejects(client.session(), { code: "AUTH_BUSY" });
      assert.equal(calls, 4);
      client.cancel();
      await Promise.all(pending);
      assert.equal(client.snapshot.state, "signed-out");
      holding = false;
      await client.complete(provider.authorize(await client.begin()));
      assert.equal(client.snapshot.state, "authenticated");
    } finally {
      await context.close();
    }
  },
);

scenario(
  "CORE-02",
  "browser-api-session-schema-fails-closed",
  "memory-auth-api-session-corruption-v1",
  "構成の外部変更を採用せず、利用者セッションの応答Schemaが壊れた場合は資格を破棄する",
  async () => {
    const context = await fixture();
    try {
      const provider = mockOidc(context),
        config = structuredClone(provider.config);
      let corrupt = false;
      const perform: typeof fetch = (input, init) =>
        corrupt
          ? Promise.resolve(
              Response.json(
                { unexpected: true },
                { headers: { "Cache-Control": "no-store" } },
              ),
            )
          : provider.fetch(input, init);
      const client = new BrowserSession(config, { fetch: perform });
      config.apiOrigin = "https://other.example.test";
      config.publicJwks.keys.length = 0;
      await client.complete(provider.authorize(await client.begin()));
      assert.equal((await client.session()).role, "viewer");
      corrupt = true;
      await assert.rejects(client.session());
      assert.equal(client.snapshot.state, "failed");
      assert.equal(client.snapshot.expiresAt, null);
    } finally {
      await context.close();
    }
  },
);
