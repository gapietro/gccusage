export function formatDollars(amount: number): string {
  if (amount < 0.01) return "$0.00";
  if (amount < 1) return `$${amount.toFixed(2)}`;
  if (amount < 100) return `$${amount.toFixed(2)}`;
  return `$${amount.toFixed(0)}`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}hr ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function formatModelName(model: string): string {
  // claude-sonnet-4-20250514 -> Sonnet 4
  // claude-opus-4-6-20250219 -> Opus 4.6
  // claude-haiku-4-5-20251001 -> Haiku 4.5
  // claude-haiku-3.5-20241001 -> Haiku 3.5
  const match = model.match(/claude-(\w+)-(\d+)(?:[.-](\d{1,2})(?=-|$))?/);
  if (match) {
    const name = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1);
    const version = match[3] ? `${match[2]}.${match[3]}` : match[2];
    return `${name} ${version}`;
  }
  return model;
}

export function formatTokensPerMinute(tokPerMin: number): string {
  if (tokPerMin < 1) return "0 tok/m";
  if (tokPerMin < 1000) return `${tokPerMin.toFixed(1)} tok/m`;
  return `${(tokPerMin / 1000).toFixed(1)}k tok/m`;
}
