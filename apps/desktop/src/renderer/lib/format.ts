/** Dollars with as many decimals as the amount needs to say something. */
export function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) {
    return "<$0.01";
  }
  return `$${value.toFixed(value >= 100 ? 0 : 2)}`;
}

export function compactNumber(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}m`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return `${Math.round(value)}`;
}

export function formatPath(path: string, maxLength = 44): string {
  if (path.length <= maxLength) {
    return path;
  }
  return `...${path.slice(path.length - maxLength + 3)}`;
}
