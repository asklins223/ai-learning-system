type PublicLabels = Readonly<Record<string, string>> | undefined;

export function publicLabel(labels: PublicLabels, id: string, fallbackLabel = "未命名项"): string {
  const label = labels?.[id]?.trim();
  return label || fallbackLabel;
}

export function indexedPublicLabel(
  labels: PublicLabels,
  ids: readonly string[],
  id: string,
  noun: string,
): string {
  const index = ids.indexOf(id);
  return publicLabel(labels, id, index >= 0 ? `${noun} ${index + 1}` : noun);
}
