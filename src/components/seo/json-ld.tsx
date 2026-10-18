/**
 * Schema.org structured data, as Next.js recommends (docs/02-guides/
 * json-ld.md): a plain script tag.
 *
 * Restaurant-entered text ends up in here, so "<" is escaped: a description
 * containing "</script>" must not be able to end the tag and run as HTML.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data).replace(/</g, "\\u003c"),
      }}
    />
  );
}
