export const toNumber = (value?: number | bigint | string) => {
  if (value === undefined) return "";
  return Intl.NumberFormat("ru-RU").format(Number(value));
};

export function fromBip(value?: number | string | bigint) {
  if (value === undefined) return "";
  return toNumber(Number(value) / 100).toString() + "%";
}
