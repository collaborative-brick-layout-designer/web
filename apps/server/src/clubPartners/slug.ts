/** A club's address from what was typed or pasted: "riverside-lug", "/orgs/riverside-lug", or a full link to it. */
export function slugFrom(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const t = raw.trim();
  const m = /\/orgs\/([a-z0-9-]+)/i.exec(t);
  return (m ? m[1]! : t).toLowerCase().slice(0, 64);
}
