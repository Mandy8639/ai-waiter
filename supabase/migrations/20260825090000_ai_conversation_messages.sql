-- Session-scoped AI waiter conversation transcript (Batch 7). Serves three
-- purposes at once, deliberately kept as one table rather than three:
-- conversation memory (so a page reload doesn't lose context — spec
-- section 20), a rate-limiting signal (counting recent 'user' rows — see
-- src/lib/ai/rate-limit.ts), and an audit trail for AI-driven cart/order
-- mutations (spec section 39, 'tool' rows).
--
-- This is NOT "permanently stored personal preferences in restaurant/
-- customer data" (which spec section 20 explicitly disallows) — it's tied
-- 1:1 to a customer_session, which already expires and is never linked to
-- a real identity (see docs/security.md#secure-customer-sessions). It
-- disappears the same way a cart does: nothing reads it once the session
-- is gone.
create table public.ai_conversation_messages (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  customer_session_id uuid not null,
  role text not null,
  content text not null,
  -- Set only on role = 'tool' rows: which tool ran and whether it
  -- succeeded — the audit trail spec section 39 asks for. Never
  -- model-fabricated: written by the orchestrator immediately after the
  -- real tool function returns, from ITS result, not from anything the
  -- model claims happened.
  tool_name text,
  tool_success boolean,
  created_at timestamptz not null default now(),

  constraint ai_conversation_messages_role_valid check (role in ('user', 'assistant', 'tool')),
  constraint ai_conversation_messages_content_length check (length(content) <= 8000),
  constraint ai_conversation_messages_tool_fields_consistent check (
    (role = 'tool' and tool_name is not null) or (role <> 'tool' and tool_name is null)
  ),
  -- Tenant-scoped FK, same pattern as every other customer-facing table.
  constraint ai_conversation_messages_session_same_restaurant
    foreign key (restaurant_id, customer_session_id)
    references public.customer_sessions (restaurant_id, id)
    on delete cascade
);

comment on table public.ai_conversation_messages is
  'AI waiter conversation transcript, scoped to one customer_session. Also backs rate limiting and the AI tool-call audit trail. See docs/ai.md.';

create index ai_conversation_messages_session_id_idx on public.ai_conversation_messages (customer_session_id);
create index ai_conversation_messages_session_created_at_idx
  on public.ai_conversation_messages (customer_session_id, created_at);

alter table public.ai_conversation_messages enable row level security;

-- A customer reads/writes only their own session's transcript — the same
-- `customer_sessions.user_id = auth.uid()` boundary used throughout this
-- schema (carts, orders). No staff-read policy in this batch: there's no
-- product need yet for staff to read a customer's AI chat, and not adding
-- the policy is cheaper and safer than adding one nobody asked for.
create policy "ai_conversation_messages_select_own"
  on public.ai_conversation_messages
  for select
  to authenticated
  using (
    exists (
      select 1 from public.customer_sessions cs
      where cs.id = ai_conversation_messages.customer_session_id and cs.user_id = auth.uid()
    )
  );

create policy "ai_conversation_messages_insert_own"
  on public.ai_conversation_messages
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.customer_sessions cs
      where cs.id = ai_conversation_messages.customer_session_id and cs.user_id = auth.uid()
    )
  );

-- No UPDATE/DELETE policy: append-only, matching order_status_history's
-- "the record of what happened doesn't get edited after the fact"
-- philosophy — a customer can insert new messages but never rewrite
-- history, including their own.
