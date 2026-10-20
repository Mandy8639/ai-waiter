-- "Generate for all dishes" (Menu photos page): a restaurant can ask for an
-- illustration of every dish without a photo in one go. At 10 attempts a
-- day that took a 249-dish menu 25 days, so the restaurant-wide cap rises
-- to 300. The per-dish cap (2 a day) and the single pending image per dish
-- are unchanged, and every image still waits for an owner's approval.
--
-- Cost bound: the platform pays per image (openai/gpt-image-2.5-flare at
-- low quality was $0.0065 on 2026-10-19), so the worst case is about $2
-- per restaurant per day. Each image's cost is recorded in ai_usage.

update public.menu_image_generation_limits
set attempts_per_restaurant_per_day = 300
where id;

alter table public.menu_image_generation_limits
  alter column attempts_per_restaurant_per_day set default 300;
