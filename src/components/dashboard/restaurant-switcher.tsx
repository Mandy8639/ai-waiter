"use client";

import { useRef } from "react";
import { selectRestaurant } from "@/lib/restaurants/actions";
import type { UserRestaurant } from "@/lib/restaurants/get-user-restaurants";

export function RestaurantSwitcher({
  restaurants,
  currentId,
}: {
  restaurants: UserRestaurant[];
  currentId: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  if (restaurants.length <= 1) {
    return (
      <span className="type-label truncate text-[0.9375rem] font-semibold">
        {restaurants[0]?.name}
      </span>
    );
  }

  return (
    <form ref={formRef} action={selectRestaurant}>
      <label htmlFor="restaurant-switcher" className="sr-only">
        Switch restaurant
      </label>
      <select
        id="restaurant-switcher"
        name="restaurantId"
        defaultValue={currentId}
        onChange={() => formRef.current?.requestSubmit()}
        className="border-input bg-card focus-visible:ring-ring/50 h-9 rounded-lg border px-2.5 text-sm font-medium focus-visible:ring-3 focus-visible:outline-none"
      >
        {restaurants.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
    </form>
  );
}
