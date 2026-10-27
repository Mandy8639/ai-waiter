-- Tap to Pay gets the same double-charge guard as phone payments
-- (20261120090000).
--
-- A server taps a card while the table is settled another way (a guest
-- paid on their phone a moment earlier). mark_tap_to_pay_succeeded()
-- (20261105090000) rightly refused to count the tap, but the refusal went
-- back as an error: the staff app told the server to "refund this payment
-- from Reports", which can't be done because the tap never counted as
-- paid, and the webhook only reported it. The guest stayed charged.
--
-- settle_tap_to_pay() answers what happened instead: 'double_paid' records
-- a payment_conflicts row (provider stripe, the PaymentIntent), and the
-- app refunds it at once (src/lib/payments/double-charge.ts, keyed on the
-- conflict, so the staff app's check and the webhook can't refund twice).
-- Settle up's notice tells the restaurant.

create function public.settle_tap_to_pay(p_payment_intent_id text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.order_payments%rowtype;
begin
  select * into v_payment
  from public.order_payments
  where stripe_payment_intent_id = p_payment_intent_id and card_present
  for update;

  if not found then
    return 'unknown';
  end if;
  if v_payment.status = 'succeeded' then
    return 'already';
  end if;
  if exists (
    select 1 from public.payment_conflicts
    where provider = 'stripe' and provider_payment_id = p_payment_intent_id
  ) then
    return 'double_paid';
  end if;

  begin
    update public.order_payments
    set status = 'succeeded', paid_at = now()
    where id = v_payment.id;
  exception when unique_violation then
    if sqlerrm not like 'PAYMENT_ORDER_ALREADY_SETTLED%' then
      raise;
    end if;
    perform public.record_payment_conflict(v_payment.id, 'stripe', p_payment_intent_id);
    return 'double_paid';
  end;

  return 'settled';
end;
$$;

comment on function public.settle_tap_to_pay(text) is
  'Settles a Tap to Pay payment once Stripe says it succeeded: settled, already, unknown, or double_paid (the table was settled another way first; recorded in payment_conflicts for a refund). service_role only.';

revoke execute on function public.settle_tap_to_pay(text) from public, anon, authenticated;
grant execute on function public.settle_tap_to_pay(text) to service_role;
