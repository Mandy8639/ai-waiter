import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/seo/metadata";
import {
  PRIVACY_POLICY_PATH,
  PRIVACY_POLICY_UPDATED,
} from "@/lib/legal/privacy";
import { SUPPORT_PATH } from "@/lib/legal/support";

/**
 * The public pages a search engine should know about.
 *
 * Restaurant pages (/r/<slug>) are deliberately not listed. Every restaurant
 * created is public, test and demo ones included, so listing them would
 * advertise those. A restaurant's menu can still be found through links to
 * it; listing chosen restaurants here is a later decision.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_URL}/`, changeFrequency: "monthly", priority: 1 },
    { url: `${SITE_URL}/signup`, changeFrequency: "yearly", priority: 0.8 },
    { url: `${SITE_URL}/login`, changeFrequency: "yearly", priority: 0.5 },
    {
      url: `${SITE_URL}${SUPPORT_PATH}`,
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${SITE_URL}${PRIVACY_POLICY_PATH}`,
      lastModified: new Date(PRIVACY_POLICY_UPDATED),
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ];
}
