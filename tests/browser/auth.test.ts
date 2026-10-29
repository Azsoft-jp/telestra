// 非永続Chromium contextで実際のpopup・CORS・別originを検証する。trace・HAR・storageStateは保存しない。
import assert from "node:assert/strict";
import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";
import { authFixture } from "./fixture.ts";
import { fixtureTLS } from "../../scripts/fixture-tls.ts";
import { scenario } from "../evidence.ts";

async function login(page: Page) {
  await page.locator("#login").click();
  await page.waitForFunction(() => {
    const state =
      document.querySelector<HTMLElement>("#auth-status")?.dataset.state;
    return (
      state &&
      !["opening", "waiting", "exchanging", "signed-out"].includes(state)
    );
  });
  assert.equal(
    await page.locator("#auth-status").getAttribute("data-state"),
    "authenticated",
  );
}
// assertionとPlaywrightの例外には現在URLが含まれ得るため、上流の本文・causeを証跡へ出さない。
async function browserCase(
  run: (
    context: BrowserContext,
    env: Awaited<ReturnType<typeof authFixture>>,
    mark: (value: string) => void,
  ) => Promise<void>,
) {
  const environment = await authFixture(fixtureTLS());
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let context: BrowserContext | undefined;
  let outward = 0;
  let stage = "setup";
  const policies = new Set<string>();
  try {
    browser = await chromium.launch({
      proxy: { server: environment.proxy, bypass: "127.0.0.1" },
    });
    // 自己署名TLSを許容するのは、外向き要求を遮断したこの非永続fixture contextだけ。
    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      serviceWorkers: "block",
      viewport: { width: 1200, height: 900 },
    });
    context.setDefaultTimeout(5000);
    context.setDefaultNavigationTimeout(5000);
    context.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      if (["/", "/authorize", "/auth/callback"].includes(path)) {
        const policy = response.headers()["cross-origin-opener-policy"];
        if (policy === "unsafe-none" || policy === "same-origin-allow-popups")
          policies.add(path + ":" + policy);
      }
    });
    const allowed = new Set([
      environment.app,
      environment.secondary,
      environment.idp,
      environment.api,
    ]);
    // リクエストの横取りはCORSのpreflightに影響するため、通常の試験では監視だけを行う。
    context.on("request", (request) => {
      if (!allowed.has(new URL(request.url()).origin)) outward++;
    });
    await run(context, environment, (value) => {
      stage = value;
    });
    assert.equal(outward, 0);
    assert.equal(environment.context.egress, 0);
  } catch {
    const safeStates: string[] = [];
    for (const page of context?.pages() ?? []) {
      try {
        const state = await page
          .locator("#auth-status")
          .getAttribute("data-state", { timeout: 500 });
        safeStates.push(
          state && /^[a-z-]{1,30}$/.test(state) ? state : "callback",
        );
      } catch {
        const opener = await page
          .evaluate(() => window.opener === null)
          .catch(() => true);
        safeStates.push(opener ? "callback-no-opener" : "callback-with-opener");
      }
    }
    throw new Error(
      `実Chromiumの認証検査に失敗しました。段階=${stage}; 状態=${safeStates.join(",")}; policy=${Array.from(policies).join(",")}; Token要求=${environment.providers.map((p) => p.tokenRequests).join(",")}; API要求=${environment.stats.apiRequests}; preflight=${environment.stats.preflights}。上流例外は出力しません。`,
    );
  } finally {
    try {
      await context?.close();
    } finally {
      try {
        await browser?.close();
      } finally {
        await environment.close();
      }
    }
  }
}

scenario(
  "SEC-04",
  "chromium-popup-api-and-origin-isolation",
  "four-loopback-tls-origins-chromium-v1",
  "実Chromiumでpopup認可・CORS・API失効・別originの再ログイン・再読込の状態分離を確認する",
  () =>
    browserCase(async (context, env, mark) => {
      const page = await context.newPage();
      await page.goto(env.app);
      mark("initial-state");
      await page.locator('#auth-status[data-state="signed-out"]').waitFor();
      mark("primary-login");
      await login(page);
      assert.match(
        await page.locator("#user-status").innerText(),
        /viewer-local/,
      );
      const other = await context.newPage();
      await other.goto(env.secondary);
      mark("secondary-state");
      await other.locator('#auth-status[data-state="signed-out"]').waitFor();
      mark("secondary-login");
      await login(other);
      mark("logout");
      await page.locator("#logout").click();
      await page.locator('#auth-status[data-state="signed-out"]').waitFor();
      await other.locator("#session").click();
      await other.locator('#auth-status[data-state="authenticated"]').waitFor();
      assert.equal(env.providers[0]!.tokenRequests, 1);
      assert.equal(env.providers[1]!.tokenRequests, 1);
      assert.equal(
        (
          await env.context.browser("/session", env.providers[0]!.issuedToken, {
            origin: env.app,
          })
        ).status,
        401,
      );
      await other.reload();
      await other.locator('#auth-status[data-state="signed-out"]').waitFor();
      for (const site of [page, other]) {
        const stored = await site.evaluate(() => ({
          local: localStorage.length,
          session: sessionStorage.length,
        }));
        assert.deepEqual(stored, { local: 0, session: 0 });
      }
      assert.equal((await context.cookies()).length, 0);
      mark("preflight");
      assert.ok(
        env.stats.preflights > 0,
        "別origin APIのpreflightを確認できません。",
      );
      // IdPのoriginはAPIの許可一覧にない。CSPが許す接続でもCORSで本文を読めない。
      mark("cors-denial");
      const foreign = await context.newPage();
      await foreign.goto(env.idp + "/unknown");
      const before = env.stats.apiRequests;
      assert.equal(
        await foreign.evaluate(async (api) => {
          try {
            await fetch(api + "/session", {
              credentials: "omit",
              cache: "no-store",
            });
            return false;
          } catch {
            return true;
          }
        }, env.api),
        true,
      );
      assert.equal(env.stats.apiRequests, before + 1);
      await foreign.close();
    }),
);

scenario(
  "CORE-02",
  "chromium-popup-sender-block-close-and-callback",
  "chromium-native-window-boundaries-v1",
  "実windowの別origin・別sourceを無視し、popup拒否・手動終了・中断とcallbackのURL消去を確認する",
  () =>
    browserCase(async (context, env, mark) => {
      const blocked = await context.newPage();
      await blocked.addInitScript(() => {
        window.open = () => null;
      });
      await blocked.goto(env.app);
      mark("blocked");
      await blocked.locator('#auth-status[data-state="signed-out"]').waitFor();
      await blocked.locator("#login").click();
      await blocked.locator('#auth-status[data-state="blocked"]').waitFor();
      assert.equal(env.providers[0]!.tokenRequests, 0);
      await blocked.close();

      const page = await context.newPage();
      await page.goto(env.app);
      await page.locator('#auth-status[data-state="signed-out"]').waitFor();
      // IdPの応答を合成ページへ置換し、正規のpopupが別originにいる間のpostMessageを試験する。
      const pattern = env.idp + "/authorize**";
      await context.route(pattern, (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><title>合成IdPの待機</title>送信元の試験",
        }),
      );
      const opened = page.waitForEvent("popup");
      await page.locator("#login").click();
      const popup = await opened;
      await popup.waitForURL(env.idp + "/authorize**");
      mark("sender");
      const authorization = popup.url();
      await popup.evaluate((target) => {
        window.opener.postMessage({ type: "untrusted" }, target);
      }, env.app);
      await page.evaluate(() =>
        window.postMessage({ type: "untrusted" }, window.location.origin),
      );
      // 別origin・別windowのメッセージを処理しないことを、有限の待機で確認する。
      await page.waitForTimeout(300);
      assert.equal(
        await page.locator("#auth-status").getAttribute("data-state"),
        "waiting",
      );
      assert.equal(env.providers[0]!.tokenRequests, 0);
      await context.unroute(pattern);
      await popup.goto(authorization);
      await page.locator('#auth-status[data-state="authenticated"]').waitFor();
      assert.equal(env.providers[0]!.tokenRequests, 1);
      await page.locator("#logout").click();
      await page.locator('#auth-status[data-state="signed-out"]').waitFor();

      await context.route(pattern, (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><title>合成IdPの待機</title>手動終了の試験",
        }),
      );
      mark("manual-close");
      const closeOpened = page.waitForEvent("popup");
      await page.locator("#login").click();
      const closed = await closeOpened;
      await closed.close();
      await page.locator('#auth-status[data-state="closed"]').waitFor();
      assert.equal(env.providers[0]!.tokenRequests, 1);
      mark("cancel");
      const cancelOpened = page.waitForEvent("popup");
      await page.locator("#login").click();
      const cancelled = await cancelOpened;
      await page.locator("#cancel").click();
      await page.locator('#auth-status[data-state="closed"]').waitFor();
      if (!cancelled.isClosed()) await cancelled.waitForEvent("close");
      await context.unroute(pattern);

      mark("callback-alone");
      const alone = await context.newPage();
      await alone.goto(
        env.app +
          "/auth/callback?code=synthetic&state=" +
          "A".repeat(43) +
          "&iss=https%3A%2F%2Fidp.example.test",
      );
      await alone
        .locator("#callback-status")
        .filter({ hasText: "認可結果を戻せません" })
        .waitFor();
      assert.equal(new URL(alone.url()).search, "");
      assert.equal(await alone.evaluate(() => window.opener === null), true);
    }),
);

scenario(
  "UX-08",
  "chromium-auth-layout-keyboard-and-security-headers",
  "chromium-auth-viewports-v1",
  "日本語の状態、320/768/1200幅、キーボード操作、角丸なし、CSPとReferrer-Policyを確認する",
  () =>
    browserCase(async (context, env, mark) => {
      const page = await context.newPage();
      mark("layout");
      const response = await page.goto(env.app);
      assert.equal(response?.headers()["referrer-policy"], "no-referrer");
      assert.match(
        response?.headers()["content-security-policy"] ?? "",
        /frame-ancestors 'none'/,
      );
      assert.equal(
        response?.headers()["cross-origin-opener-policy"],
        "same-origin-allow-popups",
      );
      await page.locator('#auth-status[data-state="signed-out"]').waitFor();
      for (const width of [320, 768, 1200]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
          true,
        );
        assert.equal(
          await page
            .locator("#login")
            .evaluate((element) => getComputedStyle(element).borderRadius),
          "0px",
        );
      }
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      assert.equal(
        await page
          .locator("#login")
          .evaluate((element) => element === document.activeElement),
        true,
      );
      await page.keyboard.press("Enter");
      await page.locator('#auth-status[data-state="authenticated"]').waitFor();
      assert.match(
        await page.locator("#auth-status").innerText(),
        /ログインしています/,
      );
      await page.screenshot({
        path: "artifacts/auth-browser.png",
        fullPage: true,
      });
    }),
);
