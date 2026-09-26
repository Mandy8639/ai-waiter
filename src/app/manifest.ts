import type { MetadataRoute } from "next";

/**
 * The web app manifest (phase F).
 *
 * Needed for kitchen push on iPhone and iPad: Safari only allows web push
 * for a site the person has added to their Home Screen, and it treats a
 * site as installable only when it has a manifest with a standalone
 * display. Android and desktop browsers don't require it, but use it for
 * the installed app's name and icon.
 *
 * start_url is the kitchen board, because the people who install this are
 * the ones who want to be told about orders. Diners never need to install
 * anything; their menu is reached by QR code.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Tableside",
    short_name: "Tableside",
    description: "Orders and table requests for your restaurant.",
    start_url: "/dashboard/kitchen",
    scope: "/",
    display: "standalone",
    background_color: "#faf8f5",
    theme_color: "#7a2e10",
    icons: [
      {
        src: "/favicon.ico",
        sizes: "any",
        type: "image/x-icon",
      },
    ],
  };
}
