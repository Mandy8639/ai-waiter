import { notFound, redirect } from "next/navigation";
import QRCode from "qrcode";
import { SplitBillPanel } from "@/components/customer/split-bill-panel";
import { createClient } from "@/lib/supabase/server";
import { getRequestOrigin } from "@/lib/tables/qr";
import { toSplitView } from "@/lib/payments/split";
import { PRIVATE_PAGE_ROBOTS } from "@/lib/seo/metadata";

export const metadata = {
  title: "Split bill — Tableside",
  robots: PRIVATE_PAGE_ROBOTS,
};

/**
 * A split bill (phase J). Opened by the person who split it, and by anyone
 * they share the link with — who may never have scanned the table's code,
 * so nothing here needs a session. The link's token is the permission, and
 * what it permits is seeing the bill and paying part of it.
 */
export default async function SplitBillPage({
  params,
  searchParams,
}: {
  params: Promise<{ restaurantSlug: string; token: string }>;
  searchParams: Promise<{ paid?: string; left?: string }>;
}) {
  const [{ restaurantSlug, token }, returned] = await Promise.all([
    params,
    searchParams,
  ]);
  if (!/^[0-9a-f]{64}$/.test(token)) notFound();

  const supabase = (await createClient()) as unknown as {
    rpc: (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: unknown }>;
  };
  const { data } = await supabase.rpc("get_tab_split", { p_token: token });
  const view = toSplitView(data);
  if (!view) notFound();

  // A link opened under the wrong restaurant path goes to the right one.
  if (view.restaurantSlug && view.restaurantSlug !== restaurantSlug) {
    redirect(`/r/${view.restaurantSlug}/split/${token}`);
  }

  const shareUrl = `${await getRequestOrigin()}/r/${encodeURIComponent(view.restaurantSlug)}/split/${token}`;
  const qrDataUrl =
    view.isOwner && view.status === "open"
      ? await QRCode.toDataURL(shareUrl, {
          errorCorrectionLevel: "M",
          margin: 2,
          width: 384,
        })
      : null;

  return (
    <SplitBillPanel
      view={view}
      token={token}
      shareUrl={shareUrl}
      qrDataUrl={qrDataUrl}
      leftPaymentId={
        returned.left && /^[0-9a-f-]{36}$/.test(returned.left)
          ? returned.left
          : null
      }
      justPaid={returned.paid === "1"}
    />
  );
}
