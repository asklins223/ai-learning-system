import { notFound } from "next/navigation";

/** Design lab surfaces are intentionally local-only and never ship as product routes. */
export default function ShowcaseLayout({ children }: { children: React.ReactNode }) {
  if (process.env.NODE_ENV === "production") notFound();
  return children;
}
