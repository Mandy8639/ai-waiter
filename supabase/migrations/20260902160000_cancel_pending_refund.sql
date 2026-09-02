-- Releasing a refund that Stripe never accepted.
--
-- The refund flow records intent before asking Stripe, so a crash leaves
-- evidence that money was meant to go back rather than losing it (see
-- src/lib/payments/refund-actions.ts). The cost of that ordering is a
-- pending row when the Stripe call fails — and pending refunds count as
-- committed against the payment's limit, deliberately, so that a refund
-- already in flight cannot be issued twice.
--
-- Left alone, that row holds budget for money that never moved: a £20
-- payment whose refund Stripe rejected would refuse a second £20 attempt
-- forever. This releases it.
--
-- `mark_refund_settled()` cannot do the job: it keys on
-- stripe_refund_id, which by definition does not exist when Stripe refused
-- the request. Hence a separate function keyed on our own row.
--
-- Deliberately NOT deletion. 'cancelled' keeps the attempt visible — who
-- tried to refund what, and when it failed — which is exactly what someone
-- asks after a customer says "you told me I'd been refunded". Deleting the
-- row would make that conversation unanswerable.
create function public.cancel_pending_refund(p_refund_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_refund public.payment_refunds%rowtype;
  v_role text;
begin
  select * into v_refund from public.payment_refunds where id = p_refund_id;
  if not found then
    return false;
  end if;

  -- SECURITY DEFINER bypasses RLS, so this check is the access control.
  v_role := public.current_restaurant_role(v_refund.restaurant_id);
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'REFUND_FORBIDDEN: only an owner or manager can cancel a refund'
      using errcode = '42501';
  end if;

  -- Only a refund that never reached Stripe may be cancelled. Once it has
  -- a Stripe refund id the money is moving, and marking it cancelled here
  -- would tell the restaurant it was never sent while the customer's bank
  -- says otherwise.
  if v_refund.stripe_refund_id is not null then
    raise exception 'REFUND_ALREADY_SENT: this refund has already reached Stripe'
      using errcode = '22023';
  end if;

  if v_refund.status <> 'pending' then
    return false;
  end if;

  update public.payment_refunds
  set status = 'cancelled'
  where id = p_refund_id;

  return true;
end;
$$;

comment on function public.cancel_pending_refund(uuid) is
  'Releases a refund Stripe never accepted, freeing the amount it held against the payment. Refuses once a Stripe refund id exists — that money is already moving. Cancels rather than deletes, so a failed attempt stays visible. See docs/security.md#payments.';

revoke execute on function public.cancel_pending_refund(uuid) from public;
grant execute on function public.cancel_pending_refund(uuid) to authenticated;
