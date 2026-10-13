import { z } from "zod";

export const paymentSettingsSchema = z.object({
  /**
   * at_order blocks an order from reaching the kitchen until it is paid
   * (enforced from phase 2). at_end lets orders flow immediately and the
   * tab is settled afterwards — the permissive default, so that turning
   * payments on never silently stops a restaurant taking orders.
   */
  paymentTiming: z.enum(["at_order", "at_end"]),
  acceptCard: z.boolean(),
  acceptCash: z.boolean(),
  /** Payments taken on the restaurant's own card machine at the register. */
  acceptCardTerminal: z.boolean(),
  tippingEnabled: z.boolean(),
});

export type PaymentSettingsInput = z.infer<typeof paymentSettingsSchema>;
