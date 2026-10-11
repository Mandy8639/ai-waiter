import "server-only";
import { cookies, headers } from "next/headers";
import { APP_SHELL_COOKIE, appShellFrom, type AppShell } from "./core";

/** The store app this request comes from, if any. See ./core.ts. */
export async function getAppShell(): Promise<AppShell | null> {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);
  return appShellFrom({
    cookie: cookieStore.get(APP_SHELL_COOKIE)?.value,
    userAgent: headerList.get("user-agent"),
  });
}
