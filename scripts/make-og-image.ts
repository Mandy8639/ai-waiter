// Builds public/brand/og/tableside-og.png, the 1200x630 image shown when a
// Tableside link is shared (src/lib/seo/metadata.ts), from the brand icon.
// Run from the repo root: npx tsx scripts/make-og-image.ts
import { readFileSync } from "node:fs";
import sharp from "sharp";

const icon = readFileSync("public/brand/tableside-icon.svg", "utf8")
  .replace(/<\?xml[^>]*>/, "")
  .replace(/<svg[^>]*>/, (m: string) =>
    m
      .replace(/width="\d+"/, 'width="300"')
      .replace(/height="\d+"/, 'height="300"'),
  );
const iconData = Buffer.from(icon).toString("base64");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#FAF7F2"/>
  <rect x="0" y="606" width="1200" height="24" fill="#842B02"/>
  <image href="data:image/svg+xml;base64,${iconData}" x="96" y="165" width="300" height="300"/>
  <text x="456" y="300" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="104" font-weight="700" fill="#2A1A12" letter-spacing="-2">Tableside</text>
  <text x="460" y="372" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="42" fill="#5C4A3F">An AI waiter for restaurants.</text>
  <text x="460" y="440" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="30" fill="#842B02" font-weight="600">tableside.menu</text>
</svg>`;
sharp(Buffer.from(svg))
  .png({ compressionLevel: 9 })
  .toFile("public/brand/og/tableside-og.png")
  .then((i) => console.log("written", i.width, i.height, i.size));
