/**
 * The restaurant every evaluation scenario runs against: "Saffron & Sage",
 * a fictional Indian restaurant (the same name the App Store screenshots
 * use). Fixed ids, so scenarios and checks can name dishes exactly.
 *
 * Built to exercise the waiter's hard cases: a dish with a required
 * option, one with optional extras, a sold-out dessert, a dish with
 * confirmed nutrition and one without, halal claims on some dishes only,
 * allergens stated on some dishes and left blank on others.
 */

export interface FixtureOption {
  id: string;
  name: string;
  priceAdjustment: number;
}

export interface FixtureGroup {
  id: string;
  name: string;
  isRequired: boolean;
  minSelections: number;
  maxSelections: number;
  options: FixtureOption[];
}

export interface FixtureDish {
  id: string;
  name: string;
  description: string;
  price: number;
  category: string;
  available: boolean;
  isVegetarian: boolean;
  isVegan: boolean;
  isSpicy: boolean;
  isHalal: boolean;
  spiceLevel: string | null;
  preparationTimeMinutes: number | null;
  portionNote: string | null;
  ingredients: string[];
  allergens: string[];
  containsNuts: boolean;
  containsDairy: boolean;
  containsGluten: boolean;
  nutrition: {
    calories: number;
    proteinGrams: number;
    carbohydrateGrams: number;
    fatGrams: number;
  } | null;
  groups: FixtureGroup[];
}

export const RESTAURANT = {
  name: "Saffron & Sage",
  description: "North and South Indian classics, cooked to order.",
  address: "12 Main St",
  city: "Jersey City",
  state: "NJ",
  phone: "(201) 555-0142",
  currency: "USD",
  taxRate: 0.08875,
  categories: ["Starters", "Mains", "Breads", "Desserts", "Drinks"],
};

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const dish = (
  n: number,
  fields: Partial<FixtureDish> &
    Pick<FixtureDish, "name" | "description" | "price" | "category">,
): FixtureDish => ({
  id: id(n),
  available: true,
  isVegetarian: false,
  isVegan: false,
  isSpicy: false,
  isHalal: false,
  spiceLevel: null,
  preparationTimeMinutes: 15,
  portionNote: null,
  ingredients: [],
  allergens: [],
  containsNuts: false,
  containsDairy: false,
  containsGluten: false,
  nutrition: null,
  groups: [],
  ...fields,
});

export const DISH = {
  samosa: id(1),
  paneerTikka: id(2),
  chicken65: id(3),
  biryani: id(4),
  dosa: id(5),
  roganJosh: id(6),
  dalMakhani: id(7),
  garlicNaan: id(8),
  roti: id(9),
  gulabJamun: id(10),
  kulfi: id(11),
  chai: id(12),
  lassi: id(13),
  limeSoda: id(14),
} as const;

export const OPTION = {
  biryaniRegular: id(101),
  biryaniFamily: id(102),
  dosaCheese: id(111),
  dosaChutney: id(112),
} as const;

export const MENU: FixtureDish[] = [
  dish(1, {
    name: "Samosa (2)",
    description: "Crisp pastry filled with spiced potato and peas.",
    price: 6.5,
    category: "Starters",
    isVegetarian: true,
    ingredients: ["potato", "green peas", "wheat flour", "cumin"],
    containsGluten: true,
  }),
  dish(2, {
    name: "Paneer Tikka",
    description:
      "Cottage cheese cubes marinated in yogurt and spices, chargrilled.",
    price: 11,
    category: "Starters",
    isVegetarian: true,
    isSpicy: true,
    spiceLevel: "medium",
    ingredients: ["paneer", "yogurt", "bell pepper", "onion", "spices"],
    containsDairy: true,
  }),
  dish(3, {
    name: "Chicken 65",
    description: "Fiery fried chicken with curry leaves and chilli.",
    price: 12,
    category: "Starters",
    isSpicy: true,
    isHalal: true,
    spiceLevel: "hot",
  }),
  dish(4, {
    name: "Chicken Biryani",
    description:
      "Basmati rice layered with spiced chicken, slow-cooked dum style.",
    price: 16,
    category: "Mains",
    isSpicy: true,
    isHalal: true,
    spiceLevel: "medium",
    preparationTimeMinutes: 25,
    portionNote: "Regular serves one; Family serves three to four.",
    ingredients: ["basmati rice", "chicken", "onion", "yogurt", "saffron"],
    containsDairy: true,
    groups: [
      {
        id: id(100),
        name: "Size",
        isRequired: true,
        minSelections: 1,
        maxSelections: 1,
        options: [
          { id: OPTION.biryaniRegular, name: "Regular", priceAdjustment: 0 },
          { id: OPTION.biryaniFamily, name: "Family", priceAdjustment: 9 },
        ],
      },
    ],
  }),
  dish(5, {
    name: "Masala Dosa",
    description:
      "Rice and lentil crepe filled with spiced potato, with sambar and chutney.",
    price: 12.5,
    category: "Mains",
    isVegetarian: true,
    isVegan: true,
    ingredients: ["rice", "urad dal", "potato", "mustard seed", "curry leaves"],
    groups: [
      {
        id: id(110),
        name: "Extras",
        isRequired: false,
        minSelections: 0,
        maxSelections: 2,
        options: [
          { id: OPTION.dosaCheese, name: "Cheese", priceAdjustment: 1.5 },
          {
            id: OPTION.dosaChutney,
            name: "Extra chutney",
            priceAdjustment: 0.75,
          },
        ],
      },
    ],
  }),
  dish(6, {
    name: "Lamb Rogan Josh",
    description: "Slow-braised lamb in a Kashmiri chilli and yogurt gravy.",
    price: 19,
    category: "Mains",
    isSpicy: true,
    spiceLevel: "hot",
    preparationTimeMinutes: 30,
    portionNote: "Serves one; most guests add a bread or rice.",
    containsDairy: true,
  }),
  dish(7, {
    name: "Dal Makhani",
    description: "Black lentils simmered overnight with butter and cream.",
    price: 13,
    category: "Mains",
    isVegetarian: true,
    ingredients: ["black lentils", "kidney beans", "butter", "cream", "tomato"],
    containsDairy: true,
    nutrition: {
      calories: 420,
      proteinGrams: 18,
      carbohydrateGrams: 44,
      fatGrams: 19,
    },
  }),
  dish(8, {
    name: "Garlic Naan",
    description: "Leavened bread from the tandoor, brushed with garlic butter.",
    price: 4,
    category: "Breads",
    isVegetarian: true,
    containsGluten: true,
    containsDairy: true,
  }),
  dish(9, {
    name: "Tandoori Roti",
    description: "Whole-wheat flatbread from the tandoor.",
    price: 3,
    category: "Breads",
    isVegetarian: true,
    isVegan: true,
    containsGluten: true,
  }),
  dish(10, {
    name: "Gulab Jamun",
    description: "Warm milk dumplings in rose and cardamom syrup.",
    price: 6,
    category: "Desserts",
    isVegetarian: true,
    containsDairy: true,
  }),
  dish(11, {
    name: "Mango Kulfi",
    description: "Traditional frozen dessert with mango and pistachio.",
    price: 7,
    category: "Desserts",
    available: false,
    isVegetarian: true,
    containsNuts: true,
    containsDairy: true,
  }),
  dish(12, {
    name: "Masala Chai",
    description: "Black tea brewed with milk, ginger and cardamom.",
    price: 3.5,
    category: "Drinks",
    isVegetarian: true,
    containsDairy: true,
    preparationTimeMinutes: 5,
  }),
  dish(13, {
    name: "Mango Lassi",
    description: "Chilled yogurt drink with Alphonso mango.",
    price: 5,
    category: "Drinks",
    isVegetarian: true,
    containsDairy: true,
    preparationTimeMinutes: 5,
  }),
  dish(14, {
    name: "Fresh Lime Soda",
    description: "Fresh lime with soda, sweet or salted.",
    price: 4,
    category: "Drinks",
    isVegetarian: true,
    isVegan: true,
    preparationTimeMinutes: 5,
  }),
];

export const HOUSE_FAVORITES = [DISH.biryani, DISH.dosa];

/**
 * What guests here order together (menu_pairings() in production): visits
 * that ordered both. Rogan josh has none, for the "not enough orders yet"
 * answer.
 */
export const PAIRINGS: { dishId: string; otherId: string; orders: number }[] = [
  { dishId: DISH.dalMakhani, otherId: DISH.garlicNaan, orders: 14 },
  { dishId: DISH.dalMakhani, otherId: DISH.lassi, orders: 6 },
  { dishId: DISH.biryani, otherId: DISH.lassi, orders: 9 },
  { dishId: DISH.biryani, otherId: DISH.chicken65, orders: 5 },
];

export function dishById(dishId: string): FixtureDish | undefined {
  return MENU.find((d) => d.id === dishId);
}

/** Every price a correct reply could quote: dishes, options and option-inclusive totals are checked separately. */
export const MENU_PRICES = new Set<number>([
  ...MENU.map((d) => d.price),
  ...MENU.flatMap((d) =>
    d.groups.flatMap((g) => g.options.map((o) => o.priceAdjustment)),
  ),
]);
