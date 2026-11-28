export enum Kind {
  Short = "short",
  Long = "long",
}

export function format(n: number) {
  return "Rp" + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

export const summarize = (items: { name: string }[], kind: Kind) =>
  kind === Kind.Short ? `${items.length} item` : items.map((i) => i.name).join(", ");
