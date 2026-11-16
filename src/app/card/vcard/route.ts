import { BUSINESS_CARD, buildVCard } from "@/lib/marketing/business-card";

/**
 * The founder's contact as a .vcf, for the "Save contact" button on /card.
 * A phone opens it in Contacts; nothing is stored or logged here.
 */
export function GET() {
  return new Response(buildVCard(BUSINESS_CARD), {
    headers: {
      "Content-Type": "text/vcard; charset=utf-8",
      "Content-Disposition": 'attachment; filename="manideep-gouraram-tableside.vcf"',
      "Cache-Control": "public, max-age=300",
    },
  });
}
