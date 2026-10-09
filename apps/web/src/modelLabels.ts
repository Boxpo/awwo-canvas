// From AwwO apps/web/src/modelLabels.ts. Display metadata never replaces a model's admission selector.
export function modelLabels(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] =>
    typeof entry[1] === 'string' && entry[1].trim().length > 0 && entry[1].length <= 512));
}

export function modelLabel(id: string, labels: Record<string, string> = {}): string {
  return Object.hasOwn(labels, id) ? labels[id] : id;
}
