import { notFound } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";

export default function PrototypeLayout({ children }: { children: React.ReactNode }) {
  if (process.env.NODE_ENV === "production") notFound();
  return <AppShell variant="focus">{children}</AppShell>;
}

