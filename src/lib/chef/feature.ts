import "server-only";
import { chefEnabledFor } from "./core";

/**
 * Whether diners at this restaurant see the Chef. A server setting, not a
 * restaurant setting: CHEF_RESTAURANTS (see .env.example). Rolled out to
 * one restaurant first, and widened — or removed — with one change and no
 * migration.
 */
export function isChefEnabled(restaurantSlug: string): boolean {
  return chefEnabledFor(process.env.CHEF_RESTAURANTS, restaurantSlug);
}
