// 専用process groupで合成fixtureを持ち、IPCの停止要求または親の切断で後始末する。
import { authFixture } from "../tests/browser/fixture.ts";
import { fixtureTLS } from "./fixture-tls.ts";

if (typeof process.send !== "function" || process.argv.length !== 2) {
  console.error("親CLIから起動してください。");
  process.exit(1);
}
let environment: Awaited<ReturnType<typeof authFixture>> | undefined;
let requested = false,
  ending = false;
function send(state: "stopped" | "failed") {
  if (process.connected) process.send?.({ state });
}
async function stop() {
  requested = true;
  if (!environment || ending) return;
  ending = true;
  try {
    await environment.close();
    send("stopped");
  } catch {
    send("failed");
    process.exitCode = 1;
  } finally {
    if (process.connected) process.disconnect();
  }
}
process.on("message", (value: unknown) => {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).join(",") !== "type" ||
    !("type" in value) ||
    value.type !== "telestra.fixture.stop.v1"
  ) {
    process.exitCode = 1;
    send("failed");
  }
  void stop();
});
process.on("disconnect", () => {
  void stop();
});
try {
  environment = await authFixture(fixtureTLS());
  if (requested) await stop();
  else
    process.send?.({
      state: "ready",
      app: environment.app,
      secondary: environment.secondary,
    });
} catch {
  send("failed");
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}
