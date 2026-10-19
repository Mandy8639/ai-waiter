/** change_pickup_time()'s raised codes, as staff should read them. */
export function parsePickupMoveError(rawMessage: string): string {
  const match = /^([A-Z_]+):\s*(.*)$/.exec(rawMessage);
  if (match?.[1] === "PICKUP_INVALID") return match[2];
  if (match?.[1] === "PICKUP_NOT_FOUND")
    return "That order could not be found.";
  return "Couldn't move that pickup time. Please try again.";
}
