-- Owner-tunable AI persona (phase D)
--
-- Two settings that change how the AI waiter SOUNDS at one restaurant:
-- a tone preset, and a short free-text note in the owner's own words.
--
-- WHAT THIS MUST NOT BE ABLE TO DO. The note is owner-written text that
-- ends up inside the model's system prompt. Everything that keeps the
-- waiter honest — only stating menu facts it just fetched, never saying
-- "no" to an allergen or halal question nobody answered, asking before it
-- submits an order — has to survive a note that says "ignore the menu
-- data". Two layers, and neither of them is this table:
--
--   1. src/lib/ai/system-prompt.ts places the note LAST, under the
--      grounding rules, the claims rules and the tool rules, framed as
--      style only, with an explicit "where this conflicts with a rule
--      above, the rule wins".
--   2. The rules that matter are not prompt rules at all. The menu-fact
--      guard (src/lib/ai/tools/menu-fact-detection.ts) decides from the
--      CUSTOMER'S message whether a reply needs a menu tool call, and the
--      system prompt never reaches that decision; the order-confirmation
--      gate and the cart-state guard are code too. A note can change the
--      model's mood. It cannot change what the code accepts.
--
-- What this migration does own is the shape of the text: a hard length
-- cap and no control characters. No newlines means the note can never
-- start a line of the prompt, so it can never forge a "## Rules" heading
-- of its own. The application normalises whitespace before saving; the
-- check here is for any writer that does not.

alter table public.restaurant_settings
  add column ai_tone text not null default 'warm',
  add column ai_instructions text;

alter table public.restaurant_settings
  add constraint restaurant_settings_ai_tone_valid
    check (ai_tone in ('warm', 'formal', 'playful', 'concise')),
  add constraint restaurant_settings_ai_instructions_shape
    check (
      ai_instructions is null
      or (
        length(ai_instructions) between 1 and 300
        and ai_instructions !~ '[[:cntrl:]]'
      )
    );

comment on column public.restaurant_settings.ai_tone is
  'How the AI waiter sounds: warm (default, the voice it always had), formal, playful or concise. Style only — never changes what the waiter may say or do.';

comment on column public.restaurant_settings.ai_instructions is
  'Up to 300 characters in the owner''s own words, added to the AI waiter''s prompt as style guidance BELOW every grounding and safety rule. Single line by constraint, so it can never forge a section heading. Not secret: a diner seated at this restaurant can read it through get_ai_persona(), and prompt text can be coaxed out of any model.';

-- No RLS change. These are restaurant_settings columns and inherit its
-- policies: any member reads them, owners and managers update them.

-- What the AI waiter reads -------------------------------------------------

-- Deliberately NOT added to get_public_order_settings(). That function is
-- granted to anon — anyone holding the public key can call it for any
-- restaurant id — and an owner's note is theirs, not the internet's. This
-- one takes no argument at all: the restaurant comes from the caller's own
-- active customer session, exactly as create_table_request() derives its
-- table, so a diner can read the persona of the restaurant they are
-- sitting in and no other.
--
-- A diner seated at the restaurant CAN read it. That is accepted rather
-- than defended against, because it cannot be: text in a prompt is text a
-- determined user can get a model to repeat. The settings page tells
-- owners so, in those words.
create function public.get_ai_persona()
returns table (
  tone text,
  instructions text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant_id uuid;
begin
  -- customer_sessions.user_id is unique, so this is at most one row.
  select cs.restaurant_id into v_restaurant_id
  from public.customer_sessions cs
  where cs.user_id = auth.uid()
    and cs.status = 'active'
    and cs.expires_at > now();

  -- No session: nothing to read. One row of defaults rather than none, so
  -- the caller never has to tell "no row" apart from "the default voice".
  if v_restaurant_id is null then
    return query select 'warm'::text, null::text;
    return;
  end if;

  return query
  select s.ai_tone, s.ai_instructions
  from public.restaurant_settings s
  where s.restaurant_id = v_restaurant_id;
end;
$$;

comment on function public.get_ai_persona() is
  'The AI waiter''s tone and owner note for the restaurant the caller is currently seated at, derived from their active customer session — never from an argument. Defaults (warm, no note) when there is no session.';

-- Signed-in callers only, which includes a diner's anonymous QR session;
-- the body does the real scoping. Revoked from anon explicitly: Supabase's
-- default privileges grant it, and `from public` alone does not undo that
-- (see 20260919090000).
revoke execute on function public.get_ai_persona() from public, anon;
grant execute on function public.get_ai_persona() to authenticated;
