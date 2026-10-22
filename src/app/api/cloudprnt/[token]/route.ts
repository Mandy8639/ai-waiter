import { NextResponse, type NextRequest } from "next/server";
import {
  chooseFormat,
  formatForMediaType,
  needsInfo,
  parsePoll,
  pollReply,
} from "@/lib/printing/cloudprnt-core";
import {
  claimJob,
  findPrinter,
  finishJob,
  nextJob,
  recordPoll,
} from "@/lib/printing/cloudprnt";
import { renderDoc } from "@/lib/printing/star-commands";
import { reportError } from "@/lib/observability/report";

/**
 * Star CloudPRNT: where a restaurant's network printers poll. The URL,
 * https://<host>/api/cloudprnt/<token>, goes into the printer's own
 * CloudPRNT settings; the token is the printer's only credential (see
 * 20261108090000_cloudprnt_printers.sql). An unknown token gets a 404 and
 * nothing else.
 *
 * POST   status poll   -> { jobReady, mediaTypes, jobToken } (cloudprnt-core.ts)
 * GET    fetch a job   -> the ticket's bytes, rendered for this printer
 * DELETE job finished  -> printed, or queued again
 *
 * A newer printer first asks for cloudprnt-setting.json next to this URL
 * (to offer MQTT); that path is no printer's token, so it gets a 404, and
 * the printer carries on with plain HTTP polling, which is what we want.
 */
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string }> };

const noStore = { "Cache-Control": "no-store" };

function notFound() {
  return new NextResponse(null, { status: 404, headers: noStore });
}

export async function POST(request: NextRequest, { params }: Context) {
  const { token } = await params;
  try {
    const found = await findPrinter(token);
    if (!found) return notFound();

    const body = await request.json().catch(() => null);
    const now = new Date();
    const printer = await recordPoll(found, parsePoll(body), now);
    if (!printer.is_active) {
      return NextResponse.json({ jobReady: false }, { headers: noStore });
    }

    const format = chooseFormat(printer.encodings, printer.client_type);
    const askInfo = needsInfo(printer, now);
    const next = askInfo ? null : await nextJob(printer, now);
    return NextResponse.json(
      pollReply({ askInfo, job: next?.job ?? null, format }),
      { headers: noStore },
    );
  } catch (error) {
    reportError(error, { scope: "cloudprnt.poll" });
    // The printer just polls again; never show it a job we couldn't check.
    return NextResponse.json({ jobReady: false }, { headers: noStore });
  }
}

export async function GET(request: NextRequest, { params }: Context) {
  const { token } = await params;
  try {
    const printer = await findPrinter(token);
    if (!printer) return notFound();

    const query = request.nextUrl.searchParams;
    const jobId = query.get("token");
    const claimed = jobId ? await claimJob(printer, jobId, new Date()) : null;
    if (!claimed) return notFound();

    const format = formatForMediaType(
      query.get("type"),
      chooseFormat(printer.encodings, printer.client_type),
    );
    const bytes = renderDoc(claimed.doc, format);
    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        ...noStore,
        "Content-Type": format.mediaType,
        "Content-Length": String(bytes.length),
      },
    });
  } catch (error) {
    reportError(error, { scope: "cloudprnt.fetch" });
    return new NextResponse(null, { status: 500, headers: noStore });
  }
}

export async function DELETE(request: NextRequest, { params }: Context) {
  const { token } = await params;
  try {
    const printer = await findPrinter(token);
    if (!printer) return notFound();
    const query = request.nextUrl.searchParams;
    await finishJob(printer, query.get("token"), query.get("code"), new Date());
    return new NextResponse(null, { status: 200, headers: noStore });
  } catch (error) {
    reportError(error, { scope: "cloudprnt.finish" });
    return new NextResponse(null, { status: 500, headers: noStore });
  }
}
