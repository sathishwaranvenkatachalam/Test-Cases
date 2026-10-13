export default function Badge({ status }: { status: string | null | undefined }) {
  const s = status ?? 'none';
  return <span className={`badge b-${s}`}>{s}</span>;
}
