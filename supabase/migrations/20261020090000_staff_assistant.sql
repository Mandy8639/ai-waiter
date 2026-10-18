-- The staff assistant: a chat box on the dashboard where an owner, manager
-- or kitchen user types "86 the salmon" or "pause ordering for an hour"
-- (src/lib/staff-assistant/).
--
-- It adds no way to change anything. Every change it makes goes through a
-- function or policy the dashboard already uses — set_menu_item_
-- availability(), set_menu_item_sold_out_until_next_opening(),
-- set_modifier_option_availability(), pause_new_orders(),
-- resume_new_orders(), set_kitchen_busy(), and for prices the same
-- menu_items UPDATE policy as the edit form — called as the signed-in
-- person, so their role and Row Level Security decide, not the assistant.
-- A kitchen account still cannot change a price.
--
-- What this migration adds is the record: every command, how it was read,
-- each call it made and what came of it. Owners and managers can read
-- their own restaurant's. Nobody writes it from the browser: rows are
-- written by the server after the fact (service role), so the log says
-- what actually happened, and a signed-in user cannot add, edit or delete
-- a line of it.

create table public.staff_assistant_commands (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  -- Their role when they sent it; roles change.
  role text not null,
  -- What they typed, or the button they pressed ("Undo", "Yes").
  command text not null,
  -- rules: understood by the built-in phrases; ai: read by the model (and
  -- then always confirmed before anything changed); button: a Yes, Undo or
  -- choice from an earlier reply.
  interpreted_by text not null,
  -- The structured reading of the command, or null when not understood.
  intent jsonb,
  outcome text not null,
  -- One entry per database call: {"fn", "args", "ok", "error"}.
  tool_calls jsonb not null default '[]'::jsonb,
  reply text not null,
  created_at timestamptz not null default now(),

  constraint staff_assistant_commands_role_valid
    check (role in ('owner', 'manager', 'kitchen', 'staff')),
  constraint staff_assistant_commands_command_length
    check (char_length(command) between 1 and 500),
  constraint staff_assistant_commands_interpreted_by_valid
    check (interpreted_by in ('rules', 'ai', 'button')),
  constraint staff_assistant_commands_outcome_valid
    check (outcome in (
      'applied', 'confirm', 'choose', 'answered',
      'refused', 'not_found', 'not_understood', 'failed', 'rate_limited'
    )),
  constraint staff_assistant_commands_tool_calls_is_array
    check (jsonb_typeof(tool_calls) = 'array')
);

comment on table public.staff_assistant_commands is
  'Every staff-assistant command: what was typed, how it was read, each database call it made and the reply. Written by the server only (service role); owners and managers read their own restaurant''s. See 20261020090000_staff_assistant.sql.';

create index staff_assistant_commands_restaurant_idx
  on public.staff_assistant_commands (restaurant_id, created_at desc);
-- The per-person rate limit counts recent rows.
create index staff_assistant_commands_user_idx
  on public.staff_assistant_commands (user_id, created_at desc);

alter table public.staff_assistant_commands enable row level security;

-- Oversight data, like audit_log: owners and managers only.
create policy "staff_assistant_commands_select_manager_or_owner"
  on public.staff_assistant_commands
  for select
  to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id));

-- No INSERT, UPDATE or DELETE policy for any API role.
