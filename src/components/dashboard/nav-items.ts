export interface NavItem {
  label: string;
  href: string;
}

export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Kitchen", href: "/dashboard/kitchen" },
  { label: "Menu", href: "/dashboard/menu" },
  { label: "Categories", href: "/dashboard/categories" },
  { label: "Modifiers", href: "/dashboard/modifiers" },
  { label: "Ingredients", href: "/dashboard/ingredients" },
  { label: "Allergens", href: "/dashboard/allergens" },
  { label: "Tables", href: "/dashboard/tables" },
  { label: "Staff", href: "/dashboard/staff" },
  { label: "Settings", href: "/dashboard/settings" },
];
