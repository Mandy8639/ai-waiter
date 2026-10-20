-- Paid AI dish images (MENU_IMAGE_MODEL, approved 2026-10-19) are recorded
-- in ai_usage like every other AI use, so their cost shows on /admin's
-- Spending card and in the weekly email. Adds the 'images' job.

alter table public.ai_usage drop constraint ai_usage_job_valid;
alter table public.ai_usage add constraint ai_usage_job_valid check (
  job in ('waiter', 'staff_assistant', 'vision', 'suggestions', 'drafts', 'images')
);
